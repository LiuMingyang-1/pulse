// Feishu bitable → D1 sync, run from the Worker's own cron (replaces the
// box-hosted scripts/sync-feishu.mjs loop). Never logs tokens or secrets.
import {
  FIELD_NAMES, adaptRecord, buildBatchUpdate, requeueWrites,
  toCalendar, toReminder, toSchedule, toTodo,
  type AdaptFields, type FeishuRecord, type PendingWrite, type TodoData,
} from './feishu-transform';
import {
  checkboxRequired,
  parseCheckbox,
  parseTasksGate,
  resolveCapability,
  resolveFieldNames,
  shouldUpgradeCompleted,
  tasksReadMode,
  upgradePendingWrite,
  writeMatches,
  type PrimaryCells,
  type TasksCapability,
  type TasksSchemaStamp,
} from './tasks-schema';
import {
  beginFeishuSync,
  currentFeishuSyncFlight,
  feishuSyncRetryDelayMs,
  finishFeishuSyncReservation,
  sleepForFeishuRetry,
  type SyncReservation,
} from './feishu-sync-guard';
import { FEISHU_SYNC_RETRY_BUDGET_MS } from './sync-cooldown';

export interface FeishuEnv {
  DB: D1Database;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_BASE_TOKEN?: string;
  FEISHU_TABLE_ID?: string;
  /** Unset / legacy keeps today's Status behavior. compat dual-writes. v2 reads the checkbox. */
  TASKS_SCHEMA?: string;
  /** Checkbox column name. Default 已完成. Not a field id. */
  FEISHU_FIELD_COMPLETED?: string;
  /** Plan-date column name. Default 计划日期. Not a field id. */
  FEISHU_FIELD_PLAN_DATE?: string;
}

export interface FeishuSyncResult {
  ok: boolean;
  reason?: string;
  /** True when this call did not touch Feishu (slot busy or cooldown). */
  skipped?: boolean;
  retry_after_ms?: number;
  fetched?: number;
  writes?: { sent: number; failed: number; held: number; unsettled: number };
  todo?: 'written' | 'skipped_read_failed' | 'skipped_concurrent_edit';
  counts?: { tasks: number; done_today: number; reminders: number; scheduled: number; planned?: number };
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

// One fresh tenant token per run (2h TTL, hourly cron — caching isn't worth it).
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

async function fetchRecords(
  env: FeishuEnv,
  token: string,
  fieldNames: readonly string[],
  adapt: AdaptFields,
): Promise<FeishuRecord[]> {
  const out: FeishuRecord[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${tablePath(env)}/records/search?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ field_names: fieldNames, automatic_fields: false }),
    });
    const body = await feishuJson(res, 'records/search');
    for (const r of body.data?.items ?? []) if (r?.record_id) out.push(adaptRecord(r, adapt));
    if (!body.data?.has_more || !body.data?.page_token) return out;
    pageToken = body.data.page_token;
  }
  throw new FeishuError('records/search: too many pages');
}

async function listFieldNames(env: FeishuEnv, token: string): Promise<Set<string>> {
  const names = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ page_size: '100' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${tablePath(env)}/fields?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await feishuJson(res, 'fields');
    for (const f of body.data?.items ?? []) {
      const name = typeof f?.field_name === 'string' ? f.field_name : f?.name;
      if (typeof name === 'string' && name) names.add(name);
    }
    if (!body.data?.has_more || !body.data?.page_token) return names;
    pageToken = body.data.page_token;
  }
  throw new FeishuError('fields: too many pages');
}

// First cell of a field column — single selects arrive wrapped as [value].
const firstCell = (v: FeishuRecord['row'][number]) => (Array.isArray(v) ? v[0] : v) ?? undefined;

// Single-record GET — hits the primary store, which records/search lags by
// minutes. Returns null when the record is gone, throws on other failures.
// `completedField` is included only when the probe already confirmed it, so a
// missing checkbox cell is false rather than "column unknown".
async function fetchPrimary(
  env: FeishuEnv,
  token: string,
  rid: string,
  completedField: string | null,
): Promise<PrimaryCells | null> {
  // A single field_names query is what production already uses for Status.
  // When the checkbox must be compared too, omit the filter and read the
  // whole primary row: a second field_names is not a documented way to ask
  // for both, and a missing checkbox cell would look like false.
  const url = completedField
    ? `${tablePath(env)}/records/${encodeURIComponent(rid)}`
    : `${tablePath(env)}/records/${encodeURIComponent(rid)}?field_names=${encodeURIComponent('Status')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const body = await feishuJson(res, `record get ${rid}`);
  const fields = body?.data?.record?.fields ?? {};
  const v = fields.Status;
  const cells: PrimaryCells = { status: (Array.isArray(v) ? v[0] : v) ?? undefined };
  if (completedField) cells.completed = parseCheckbox(fields[completedField]);
  return cells;
}

// Never throws — write-back failure must not block the read path.
async function drainPendingWrites(
  env: FeishuEnv,
  token: string,
  writes: PendingWrite[],
  completedField: string | null,
) {
  const acked = new Set<string>();
  const failed = new Set<string>();
  const records = buildBatchUpdate(writes, { completedField });
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

function isSyncReservation(value: SyncReservation | FeishuSyncResult): value is SyncReservation {
  return 'owner' in value && typeof value.releaseFlight === 'function';
}

export async function runFeishuSync(env: FeishuEnv): Promise<FeishuSyncResult> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_BASE_TOKEN || !env.FEISHU_TABLE_ID) {
    return { ok: false, reason: 'not_configured' };
  }

  const begun = await beginFeishuSync(env.DB);
  if (!isSyncReservation(begun)) {
    console.log('[feishu] sync skipped', begun.reason);
    return begun;
  }

  try {
    return await runFeishuSyncBody(env);
  } finally {
    try {
      await finishFeishuSyncReservation(env.DB, begun);
    } finally {
      begun.releaseFlight();
    }
  }
}

/**
 * Toggle write-back. If the slot is busy or cooling down, wait (bounded by
 * `FEISHU_SYNC_RETRY_BUDGET_MS`, inside waitUntil's post-response limit) and
 * try once more so the new pending write is not stuck until the hourly cron.
 */
export async function runFeishuSyncAfterPendingWrite(env: FeishuEnv): Promise<FeishuSyncResult> {
  const first = await runFeishuSync(env);
  if (!first.skipped) return first;

  const deadline = Date.now() + FEISHU_SYNC_RETRY_BUDGET_MS;
  const flight = currentFeishuSyncFlight();
  if (flight) {
    const ac = new AbortController();
    await Promise.race([
      flight.then(() => ac.abort(), () => ac.abort()),
      sleepForFeishuRetry(Math.max(0, deadline - Date.now()), ac.signal),
    ]);
    ac.abort();
  }

  const remain = deadline - Date.now();
  if (remain <= 0) return first;
  const delay = Math.min(await feishuSyncRetryDelayMs(env.DB), remain);
  if (delay > 0) await sleepForFeishuRetry(delay);
  return runFeishuSync(env);
}

async function runFeishuSyncBody(env: FeishuEnv): Promise<FeishuSyncResult> {
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

    const gate = parseTasksGate(env.TASKS_SCHEMA);
    const fieldNames = resolveFieldNames(env);
    const needsProbe = gate !== 'legacy' || writes.some((w) => typeof w.completed === 'boolean');
    let capability: TasksCapability = 'unknown';
    if (needsProbe) {
      try {
        capability = resolveCapability(await listFieldNames(env, token), fieldNames);
      } catch (err) {
        console.error('[feishu] field probe failed:', (err as Error).message);
        capability = 'unknown';
      }
    }
    const read = tasksReadMode(gate, capability);
    if (gate !== 'legacy' || capability !== 'unknown') {
      console.log('[feishu] tasks-schema', JSON.stringify({ gate, capability, read }));
    }
    const upgrade = shouldUpgradeCompleted(gate, capability);
    for (let i = 0; i < writes.length; i++) writes[i] = upgradePendingWrite(writes[i], upgrade);

    // Checkbox is part of the compare only when the probe saw the column.
    // Unknown (probe failed) keeps a dual-write queued and does not send it:
    // a Status-only payload would ack the queue and drop the checkbox half.
    // Legacy capability (column confirmed absent) abandons the checkbox half
    // and still drains Status, so a removed column cannot wedge the queue.
    const sendCheckbox = capability === 'v2' ? fieldNames.completed : null;

    // records/search lags writes by minutes, so check each queued write
    // against the primary row (single-record GET) BEFORE deciding to send:
    // a write the primary already holds is `landed` and must never be sent
    // again — while the index still lags, re-sending would clobber a newer
    // Feishu-side edit. A checkbox write is landed only when both cells match,
    // so an uncheck cannot be acked by a still-Done Status.
    const primary = new Map<string, PrimaryCells>();
    const gone = new Set<string>();
    for (const w of writes) {
      const rid = w?.record_id;
      if (!rid || typeof w.status !== 'string') continue;
      if (typeof w.completed === 'boolean' && capability === 'unknown') continue;
      try {
        const cells = await fetchPrimary(env, token, rid, checkboxRequired(w, capability) ? sendCheckbox : null);
        if (cells === null) { gone.add(rid); continue; }
        primary.set(rid, cells);
        if (writeMatches(cells, w, checkboxRequired(w, capability))) w.landed = true;
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
    if (toSend.some((w) => typeof w.completed === 'boolean')) {
      console.log('[feishu] dual-write', JSON.stringify(toSend.map((w) => ({
        record_id: w.record_id,
        status: w.status,
        completed: typeof w.completed === 'boolean' ? w.completed : null,
        schema: w.schema ?? 'legacy',
      }))));
    }
    const { acked, failed } = await drainPendingWrites(env, token, toSend, sendCheckbox);
    for (const w of toSend) {
      if (w.record_id && acked.has(w.record_id)) {
        w.landed = true;
        const prev = primary.get(w.record_id);
        primary.set(w.record_id, {
          status: w.status,
          completed: checkboxRequired(w, capability) ? w.completed : prev?.completed,
        });
      }
    }

    const adapt: AdaptFields = {};
    const searchFields: string[] = [...FIELD_NAMES];
    const wantCompleted = read === 'v2' || writes.some((w) => checkboxRequired(w, capability));
    if (wantCompleted && fieldNames.completed) {
      adapt.completedField = fieldNames.completed;
      searchFields.push(fieldNames.completed);
    }
    if (read === 'v2' && fieldNames.planDate) {
      adapt.planDateField = fieldNames.planDate;
      searchFields.push(fieldNames.planDate);
    }
    const records = await fetchRecords(env, token, searchFields, adapt);

    // Per queued write: released when the record is gone or its landed
    // write's primary moved on (edited elsewhere — don't re-impose the
    // toggle); verified once the wide index finally shows the new target;
    // otherwise unsettled — stays queued, keeping the item's local flags
    // (landed → held without re-sending, unlanded → retried next round).
    // Without this the queue empties on ack and the NEXT sync's stale read
    // snaps the item back to undone — the "勾选后刷新又变回未完成" bug.
    const wideCells = new Map<string, PrimaryCells>(
      records.map((r) => [r.record_id, {
        status: firstCell(r.row[3]),
        ...(r.completed === undefined ? {} : { completed: r.completed }),
      }]),
    );
    const unsettled = new Set<string>();
    const held = new Set<string>();
    for (const w of writes) {
      const rid = w?.record_id;
      if (!rid || typeof w.status !== 'string' || gone.has(rid)) continue;
      const check = checkboxRequired(w, capability);
      if (typeof w.completed === 'boolean' && capability === 'unknown') {
        unsettled.add(rid);
        continue;
      }
      if (w.landed && primary.has(rid) && !writeMatches(primary.get(rid), w, check)) continue;
      if (writeMatches(wideCells.get(rid), w, check)) continue;
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
    const view = { read };
    const todo = toTodo(records, local, acked, failed, unsettled, nowIso, view);
    if (gate !== 'legacy' || capability !== 'unknown') {
      const stamp: TasksSchemaStamp = {
        gate,
        read,
        capability,
        completed_field: fieldNames.completed,
        plan_date_field: fieldNames.planDate,
        ...(needsProbe ? { probed_at: nowIso } : {}),
      };
      todo.tasks_schema = stamp;
    }
    const reminder = toReminder(records);
    const schedule = toSchedule(records, new Date(nowIso), view);
    const calendar = toCalendar(records, new Date(nowIso));

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
    // Hidden feed row — never rendered as a card (see RETIRED in index.astro);
    // /api/calendar.ics serves it to iOS calendar subscriptions.
    await upsert(env, 'calendar', '日程订阅', calendar, nowIso);

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
        ...('planned' in schedule && schedule.planned ? { planned: schedule.planned.length } : {}),
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
