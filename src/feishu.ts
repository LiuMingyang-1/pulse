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
  writes?: { acked: number; failed: number };
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

// Read-back of just-written records via single-record GET — the wide
// records/search list is eventually consistent and can echo the pre-write
// Status for minutes, which would snap a freshly clicked todo back to undone
// (see feishu-transform's requeueWrites). Single-record GET goes to the
// primary store, so a mismatch means the write genuinely hasn't landed.
// Never throws like the drain. Sequential one-by-one: queues are tiny (a tap
// is one record), and a Promise.all burst just to read 1–3 rows isn't worth it.
async function confirmWrites(
  env: FeishuEnv, token: string, writes: PendingWrite[], acked: Set<string>, failed: Set<string>,
) {
  if (!acked.size) return;
  const want = new Map<string, string>();
  for (const w of writes) {
    if (w?.record_id && typeof w.status === 'string' && acked.has(w.record_id)) {
      want.set(w.record_id, w.status);
    }
  }
  for (const [rid, expected] of want) {
    try {
      const res = await fetch(
        `${tablePath(env)}/records/${encodeURIComponent(rid)}?field_names=${encodeURIComponent('Status')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const body = await feishuJson(res, `record get ${rid}`);
      const v = body?.data?.record?.fields?.Status;
      const status = Array.isArray(v) ? v[0] : v;
      if (status !== expected) {
        acked.delete(rid);
        failed.add(rid);
      }
    } catch (err) {
      // Can't confirm — pessimistically requeue; next round re-verifies.
      console.error(`[feishu] read-back failed for ${rid}:`, (err as Error).message);
      acked.delete(rid);
      failed.add(rid);
    }
  }
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
    const { acked, failed } = await drainPendingWrites(env, token, writes);
    // Read back just-written records before the wide read: if it still shows
    // the old Status the write isn't real yet — requeue so toTodo keeps the
    // user's click and retries next round instead of snapping back to undone.
    // Skipped when nothing was queued (common case on a plain cron tick).
    await confirmWrites(env, token, writes, acked, failed);

    const records = await fetchRecords(env, token);
    if (failed.size && local) {
      // Replace the queue wholesale: requeueWrites rebuilds one entry per
      // unverified record from the item's current state, so assigning it back
      // keeps queuedIds live without double-counting the originals.
      local.pending_writes = requeueWrites(local, failed);
    }

    const nowIso = new Date().toISOString();
    const todo = toTodo(records, local, acked, failed, nowIso);
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
      writes: { acked: acked.size, failed: failed.size },
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
