// Feishu bitable → D1 sync, run from the Worker's own cron (replaces the
// box-hosted scripts/sync-feishu.mjs loop). Never logs tokens or secrets.
import {
  FIELD_NAMES, adaptRecord, buildBatchUpdate, requeueWrites,
  toReminder, toSchedule, toTodo,
  type FeishuRecord, type PendingWrite, type TodoData,
} from './feishu-transform';

export interface FeishuEnv {
  DB: D1Database;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_BASE_TOKEN?: string;
  FEISHU_TABLE_ID?: string;
}

export interface FeishuSyncResult {
  ok: boolean;
  reason?: string;
  fetched?: number;
  writes?: { sent: number; failed: number; held: number; unsettled: number };
  todo?: 'written' | 'skipped_read_failed' | 'skipped_concurrent_edit';
  counts?: { tasks: number; done_today: number; reminders: number; scheduled: number };
}

const API = 'https://open.feishu.cn/open-apis';
const SOURCE = 'feishu-cron';
const BATCH = 500;

class FeishuError extends Error {}

async function feishuJson(res: Response, what: string): Promise<any> {
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !body || body.code !== 0) {
    // Only code/msg — never echo request bodies or headers.
    throw new FeishuError(`${what} failed: http ${res.status}, code ${body?.code ?? '?'}, ${body?.msg ?? ''}`.trim());
  }
  return body;
}

// One fresh tenant token per run (2h TTL, 5-min cron — caching isn't worth it).
async function getTenantToken(env: FeishuEnv): Promise<string> {
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const body = await feishuJson(res, 'tenant_access_token');
  if (typeof body.tenant_access_token !== 'string') throw new FeishuError('tenant_access_token missing');
  return body.tenant_access_token;
}

function tablePath(env: FeishuEnv) {
  return `${API}/bitable/v1/apps/${encodeURIComponent(env.FEISHU_BASE_TOKEN!)}/tables/${encodeURIComponent(env.FEISHU_TABLE_ID!)}`;
}

async function fetchRecords(env: FeishuEnv, token: string): Promise<FeishuRecord[]> {
  const out: FeishuRecord[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${tablePath(env)}/records/search?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ field_names: FIELD_NAMES, automatic_fields: false }),
    });
    const body = await feishuJson(res, 'records/search');
    for (const r of body.data?.items ?? []) if (r?.record_id) out.push(adaptRecord(r));
    if (!body.data?.has_more || !body.data?.page_token) return out;
    pageToken = body.data.page_token;
  }
  throw new FeishuError('records/search: too many pages');
}

// First cell of a field column — single selects arrive wrapped as [value].
const firstCell = (v: FeishuRecord['row'][number]) => (Array.isArray(v) ? v[0] : v) ?? undefined;

// Single-record GET — hits the primary store, which records/search lags by
// minutes. Returns the Status cell, null when the record is gone, throws on
// other failures.
async function fetchStatus(env: FeishuEnv, token: string, rid: string): Promise<string | undefined | null> {
  const res = await fetch(
    `${tablePath(env)}/records/${encodeURIComponent(rid)}?field_names=${encodeURIComponent('Status')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) return null;
  const body = await feishuJson(res, `record get ${rid}`);
  const v = body?.data?.record?.fields?.Status;
  return (Array.isArray(v) ? v[0] : v) ?? undefined;
}

// Never throws — write-back failure must not block the read path.
async function drainPendingWrites(env: FeishuEnv, token: string, writes: PendingWrite[]) {
  const acked = new Set<string>();
  const failed = new Set<string>();
  const records = buildBatchUpdate(writes);
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    try {
      const res = await fetch(`${tablePath(env)}/records/batch_update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ records: chunk }),
      });
      await feishuJson(res, 'records/batch_update');
      chunk.forEach((r) => acked.add(r.record_id));
    } catch (err) {
      console.error(`[feishu] batch_update failed (${chunk.length} records):`, (err as Error).message);
      chunk.forEach((r) => failed.add(r.record_id));
    }
  }
  return { acked, failed };
}

async function upsert(env: FeishuEnv, id: string, title: string, data: unknown, now: string) {
  await env.DB.prepare(
    `INSERT INTO widgets (id, title, data, updated_at, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, source = excluded.source`,
  ).bind(id, title, JSON.stringify(data), now, SOURCE).run();
}

export async function runFeishuSync(env: FeishuEnv): Promise<FeishuSyncResult> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_BASE_TOKEN || !env.FEISHU_TABLE_ID) {
    return { ok: false, reason: 'not_configured' };
  }
  try {
    // Read the todo row (pending_writes + local flags) and remember its
    // updated_at for the optimistic write guard below.
    let todoRead: { ok: boolean; data: Partial<TodoData> | null; updatedAt: string | null };
    try {
      const row = await env.DB.prepare('SELECT data, updated_at FROM widgets WHERE id = ?')
        .bind('todo').first<{ data: string; updated_at: string }>();
      todoRead = row
        ? { ok: true, data: JSON.parse(row.data), updatedAt: row.updated_at }
        : { ok: true, data: null, updatedAt: null };
    } catch (err) {
      console.error('[feishu] todo read failed:', (err as Error).message);
      todoRead = { ok: false, data: null, updatedAt: null };
    }

    const token = await getTenantToken(env);
    const local = todoRead.data;
    // Don't drain if the todo read failed: we couldn't persist the outcome.
    const writes = todoRead.ok && Array.isArray(local?.pending_writes) ? local!.pending_writes! : [];

    // records/search lags writes by minutes, so check each queued write
    // against the primary row (single-record GET) BEFORE deciding to send:
    // a write the primary already holds is `landed` and must never be sent
    // again — while the index still lags, re-sending would clobber a newer
    // Feishu-side edit.
    const primary = new Map<string, string | undefined>();
    const gone = new Set<string>();
    for (const w of writes) {
      const rid = w?.record_id;
      if (!rid || typeof w.status !== 'string') continue;
      try {
        const s = await fetchStatus(env, token, rid);
        if (s === null) { gone.add(rid); continue; }
        primary.set(rid, s);
        if (s === w.status) w.landed = true;
      } catch (err) {
        // Can't tell landed from lost — don't send blind (a resend could
        // clobber an unseen edit); the write stays queued and re-checks next
        // round.
        console.error(`[feishu] status read-back failed for ${rid}:`, (err as Error).message);
      }
    }

    // Only writes whose primary provably mismatches get (re)sent.
    const toSend = writes.filter(
      (w) => w?.record_id && typeof w.status === 'string' && !w.landed && primary.has(w.record_id),
    );
    const { acked, failed } = await drainPendingWrites(env, token, toSend);
    for (const w of toSend) {
      if (w.record_id && acked.has(w.record_id)) {
        w.landed = true;
        primary.set(w.record_id, w.status);
      }
    }

    const records = await fetchRecords(env, token);

    // Per queued write: released when the record is gone or its landed
    // write's primary moved on (edited elsewhere — don't re-impose the
    // toggle); verified once the wide index finally shows the new Status;
    // otherwise unsettled — stays queued, keeping the item's local flags
    // (landed → held without re-sending, unlanded → retried next round).
    // Without this the queue empties on ack and the NEXT sync's stale read
    // snaps the item back to undone — the "勾选后刷新又变回未完成" bug.
    const wideStatus = new Map<string, string | undefined>(
      records.map((r) => [r.record_id, firstCell(r.row[3])]),
    );
    const unsettled = new Set<string>();
    const held = new Set<string>();
    for (const w of writes) {
      const rid = w?.record_id;
      if (!rid || typeof w.status !== 'string' || gone.has(rid)) continue;
      if (w.landed && primary.has(rid) && primary.get(rid) !== w.status) continue;
      if (wideStatus.get(rid) === w.status) continue;
      unsettled.add(rid);
      if (w.landed) held.add(rid);
    }
    if (writes.length && local) {
      // Replace the queue wholesale: requeueWrites rebuilds one entry per
      // still-unsettled record from the item's current state, so assigning it
      // back keeps queuedIds live without double-counting the originals.
      // Verified/released writes drop out — an empty result clears the queue.
      local.pending_writes = requeueWrites(local, unsettled);
    }

    const nowIso = new Date().toISOString();
    const todo = toTodo(records, local, acked, failed, unsettled, nowIso);
    const reminder = toReminder(records);
    const schedule = toSchedule(records);

    let todoState: FeishuSyncResult['todo'];
    if (!todoRead.ok) {
      todoState = 'skipped_read_failed';
    } else {
      // Only write if nobody (e.g. /api/todo/toggle) touched the row since we
      // read it — otherwise we'd drop freshly queued pending_writes. Skipped
      // rounds are safe: the queue is retried next run (writes are idempotent).
      const stmt = todoRead.updatedAt === null
        ? env.DB.prepare(
            `INSERT INTO widgets (id, title, data, updated_at, source) VALUES ('todo', '飞书待办', ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          ).bind(JSON.stringify(todo), nowIso, SOURCE)
        : env.DB.prepare(
            `UPDATE widgets SET data = ?, updated_at = ?, source = ? WHERE id = 'todo' AND updated_at = ?`,
          ).bind(JSON.stringify(todo), nowIso, SOURCE, todoRead.updatedAt);
      const r = await stmt.run();
      todoState = (r.meta?.changes ?? 0) > 0 ? 'written' : 'skipped_concurrent_edit';
      if (todoState !== 'written') console.warn('[feishu] todo changed during sync — skipped this round');
    }
    await upsert(env, 'reminder', 'Reminder', reminder, nowIso);
    await upsert(env, 'schedule', '今日安排', schedule, nowIso);

    const result: FeishuSyncResult = {
      ok: true,
      fetched: records.length,
      writes: { sent: acked.size, failed: failed.size, held: held.size, unsettled: unsettled.size },
      todo: todoState,
      counts: {
        tasks: todo.pending_count,
        done_today: todo.done_items?.length ?? 0,
        reminders: reminder.items.length,
        scheduled: schedule.events.length,
      },
    };
    console.log('[feishu] sync', JSON.stringify(result));
    return result;
  } catch (err) {
    const msg = err instanceof FeishuError ? err.message : `unexpected: ${(err as Error)?.message ?? err}`;
    console.error('[feishu] sync failed:', msg);
    return { ok: false, reason: msg };
  }
}
