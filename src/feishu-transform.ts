// Pure Feishu → widget transforms, ported 1:1 from scripts/sync-feishu.mjs.
// No I/O here so it can be unit-tested (test/feishu-transform.test.ts).
//
// Records use the same positional shape lark-cli produced for the script:
//   row = [Task, Due, Priority, Status, Type, Scheduled Start, Scheduled End]
// adaptRecord() converts bitable OpenAPI records into that shape.

import {
  intervalOverlapsShanghaiDay,
  isValidSchedule,
  parseCheckbox,
  planDateKey,
  shanghaiDayKey,
  type TasksReadMode,
  type TasksSchemaStamp,
} from './tasks-schema';

export const FIELD_NAMES = [
  'Task', 'Due', 'Priority', 'Status', 'Type',
  'Scheduled Start', 'Scheduled End',
] as const;
const DATE_FIELDS = new Set(['Due', 'Scheduled Start', 'Scheduled End']);
const SELECT_FIELDS = new Set(['Priority', 'Status', 'Type']);

export type Cell = string | string[] | null;
export interface AdaptFields {
  /** When set, the read asked for this column. Absence on a row is false, not "unknown". */
  completedField?: string;
  /** When set, the read asked for this column. Absence stays null — never inferred. */
  planDateField?: string;
}
export interface FeishuRecord {
  row: Cell[];
  record_id: string;
  /** Present only when `completedField` was requested. */
  completed?: boolean;
  /** Present only when `planDateField` was requested. null = empty. */
  planDate?: string | null;
}
export interface TasksView {
  read: TasksReadMode;
}

export interface TodoItem {
  id: string;
  title: string;
  due: string | null;
  priority: string;
  status?: string;
  done?: boolean;
  pending?: boolean;
  prev_status?: string;
  sync_failed?: boolean;
  completed_at?: string;
  /** Shanghai calendar day of 计划日期. Only set on v2 reads. null = empty. */
  plan_date?: string | null;
}
export interface PendingWrite {
  record_id?: string;
  status?: string;
  /**
   * Checkbox target. Absent on legacy queue entries. `false` is a real
   * "not done" once the write was made under compat/v2 — it is not the same
   * as a missing field.
   */
  completed?: boolean;
  schema?: string;
  upgraded_from?: string;
  // Set once a single-record read confirms the primary row holds the target.
  // Landed writes are never re-sent — they stay queued only until the
  // lagging records/search index shows the same value (or the primary
  // diverges, meaning someone else edited the row). A v2 target is landed
  // only when Status AND the checkbox match.
  landed?: boolean;
  [k: string]: unknown;
}
export interface TodoData {
  pending_count: number;
  items: TodoItem[];
  done_items?: TodoItem[];
  pending_writes?: PendingWrite[];
  tasks_schema?: TasksSchemaStamp;
  write_audit?: unknown[];
}

// ── Field adapter ─────────────────────────────────────────────────────────
// Millisecond timestamp → "2026-10-14T15:00:00.000+08:00" (lark-cli's format).
// Shanghai has no DST, so a fixed +8h offset is exact.
export function msToShanghaiIso(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().replace('Z', '+08:00');
}

function textOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const s = v
      .map((seg) => (typeof seg === 'string' ? seg : (seg as { text?: unknown })?.text ?? ''))
      .join('');
    return s === '' ? null : s;
  }
  if (typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') {
    return (v as { text: string }).text;
  }
  return null;
}

export function adaptValue(name: string, v: unknown): Cell {
  if (v == null || v === '') return null;
  if (DATE_FIELDS.has(name)) {
    const ms = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(ms)) return msToShanghaiIso(ms);
    return typeof v === 'string' ? v : null;
  }
  if (SELECT_FIELDS.has(name)) {
    // single select → string; multi select → string[]. Wrap as array like
    // lark-cli did — every reader goes through first().
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) {
      const arr = v.map((x) => textOf(x)).filter((x): x is string => !!x);
      return arr.length ? arr : null;
    }
    const t = textOf(v);
    return t ? [t] : null;
  }
  return textOf(v);
}

function adaptDateCell(v: unknown): string | null {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (Number.isFinite(ms)) return msToShanghaiIso(ms);
  return typeof v === 'string' ? v : null;
}

export function adaptRecord(
  rec: { record_id: string; fields?: Record<string, unknown> },
  fields?: AdaptFields,
): FeishuRecord {
  const f = rec.fields ?? {};
  const out: FeishuRecord = { record_id: rec.record_id, row: FIELD_NAMES.map((n) => adaptValue(n, f[n])) };
  if (fields?.completedField) out.completed = parseCheckbox(f[fields.completedField]);
  if (fields?.planDateField) out.planDate = adaptDateCell(f[fields.planDateField]);
  return out;
}

// ── Transforms (verbatim logic from sync-feishu.mjs) ──────────────────────
const first = (v: Cell): string | undefined =>
  (Array.isArray(v) ? v[0] : v) ?? undefined;
const str = (v: Cell): string | null => (Array.isArray(v) ? v.join('') : v);

export const DONE_LIMIT = 20;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });
const localDay = (d: Date) => dayFmt.format(d);

export function isTodayDate(iso: unknown, now: Date = new Date()): boolean {
  if (typeof iso !== 'string' || iso.trim() === '') return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return localDay(d) === localDay(now);
}

function pending(records: FeishuRecord[], type: string) {
  return records.filter(({ row }) => first(row[3]) !== 'Done' && first(row[4]) === type);
}

// 'P0' → 0 … 'P3' → 3; missing/unparsable sinks to 9.
function priorityRank(p: string | undefined): number {
  const n = Number(p?.replace('P', '') ?? '9');
  return Number.isFinite(n) ? n : 9;
}

// Todo order: due ascending; same due → priority (P0 first); items without
// a due sink below dated ones and sort among themselves by priority.
// Equal keys return 0 so the sort stays consistent.
function dueMs(d: string | null | undefined): number | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function byDueThenPriority(a: TodoItem, b: TodoItem): number {
  const da = dueMs(a.due);
  const db = dueMs(b.due);
  if (da !== null && db !== null && da !== db) return da - db;
  if (da === null && db !== null) return 1;
  if (da !== null && db === null) return -1;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

export function toTodo(
  records: FeishuRecord[],
  local: Partial<TodoData> | null | undefined,
  acked: Set<string>,
  failed: Set<string>,
  unsettled: Set<string>,
  nowIso: string,
  view: TasksView = { read: 'legacy' },
): TodoData {
  const v2 = view.read === 'v2';
  const now = new Date(nowIso);
  const remoteDone = (rec: FeishuRecord) => (v2 ? rec.completed === true : first(rec.row[3]) === 'Done');
  const localById = new Map<string, TodoItem>();
  for (const list of [local?.items, local?.done_items]) {
    if (Array.isArray(list)) for (const it of list) if (it?.id) localById.set(it.id, it);
  }
  const localWrites = Array.isArray(local?.pending_writes) ? local!.pending_writes! : [];
  const queuedIds = new Set(localWrites.map((w) => w?.record_id).filter(Boolean) as string[]);

  const items: TodoItem[] = records
    .filter((rec) => !remoteDone(rec) && first(rec.row[4]) === 'Task')
    .map((rec) => {
      const { row, record_id: id } = rec;
      const prev = localById.get(id);
      const it: TodoItem = {
        id,
        title: str(row[0]) ?? '(untitled)',
        due: str(row[1]) ?? null,
        priority: first(row[2]) ?? 'P2',
        status: first(row[3]),
      };
      if (v2) it.plan_date = planDateKey(rec.planDate);
      // Locally-marked done while Feishu still shows it unfinished: keep the
      // sunken state as long as the write is unsettled (in flight, held for
      // the lagging index, or just failed). Only failed writes get the red
      // ring — waiting for the index is a normal multi-minute window.
      // completed_at must ride along: without it the item carries no
      // completion stamp into the next round's Done projection, and the
      // today-only done_items filter drops it once the index catches up.
      if (prev?.done && (queuedIds.has(id) || failed.has(id) || unsettled.has(id))) {
        it.done = true;
        if (prev.prev_status) it.prev_status = prev.prev_status;
        if (prev.completed_at) it.completed_at = prev.completed_at;
        it.pending = true;
        if (failed.has(id)) it.sync_failed = true;
      }
      return it;
    })
    .sort(byDueThenPriority);

  const mergedDone: TodoItem[] = records
    .filter((rec) => remoteDone(rec) && first(rec.row[4]) === 'Task')
    .map((rec) => {
      const { row, record_id: id } = rec;
      const prev = localById.get(id);
      const it: TodoItem = {
        id,
        title: str(row[0]) ?? '(untitled)',
        due: str(row[1]) ?? null,
        priority: first(row[2]) ?? 'P2',
        // v2 keeps the real Status. Forcing 'Done' here would make a later
        // undo restore Done and bounce the checkbox back on.
        status: v2 ? first(row[3]) : 'Done',
        done: true,
      };
      if (v2) it.plan_date = planDateKey(rec.planDate);
      if (prev?.completed_at) it.completed_at = prev.completed_at;
      else if (prev && prev.done !== true) it.completed_at = nowIso;
      if (prev?.prev_status) it.prev_status = prev.prev_status;
      if (prev && prev.done === false && (queuedIds.has(id) || failed.has(id) || unsettled.has(id))) {
        it.done = false;
        it.pending = true;
        if (failed.has(id)) it.sync_failed = true;
      }
      return it;
    });
  const sunken = mergedDone
    .filter((it) => it.done && isTodayDate(it.completed_at, now))
    .slice(-DONE_LIMIT);
  items.push(...mergedDone.filter((it) => !it.done));
  items.sort(byDueThenPriority);

  // Writes stay queued while they're unsettled — still in flight, held for
  // the lagging index, or failed. Verified writes and released ones (record
  // gone / external edit) drop out.
  const pending_writes = localWrites.filter(
    (w) => w?.record_id && (failed.has(w.record_id) || unsettled.has(w.record_id)),
  );

  const write_audit = Array.isArray(local?.write_audit) ? local.write_audit.slice(-20) : [];

  return {
    pending_count: items.filter((it) => !it.done).length,
    items,
    ...(sunken.length ? { done_items: sunken } : {}),
    ...(pending_writes.length ? { pending_writes } : {}),
    ...(write_audit.length ? { write_audit } : {}),
  };
}

export function toReminder(records: FeishuRecord[]) {
  const items = pending(records, 'Reminder')
    .filter(({ row }) => row[1])
    .map(({ row }) => ({ title: str(row[0]) ?? '(untitled)', due: str(row[1]) as string }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  return { items };
}

// Start ascending by timestamp; same instant → higher priority (smaller P
// number) first, same semantics as byDueThenPriority. Equal keys return 0.
function byStartThenPriority(
  a: { start: string; priority: string },
  b: { start: string; priority: string },
): number {
  const sa = Date.parse(a.start);
  const sb = Date.parse(b.start);
  if (sa !== sb) return sa - sb;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

export interface ScheduleEvent {
  title: string;
  start: string;
  end: string;
  priority: string;
  id?: string;
}
export interface PlannedTask {
  id: string;
  title: string;
  priority: string;
  plan_date: string;
}

/**
 * Legacy: Status=Doing, both Scheduled times, Scheduled Start falls on today.
 * v2: union of (1) a valid interval that overlaps today, any Status except a
 * completed checkbox, plan date ignored, and (2) 计划日期=today with no valid
 * interval and not completed. Doing is not "in progress" and is not a
 * substitute for either side. End<=Start and one-sided times are left as they
 * are. A valid interval on another day is scheduled, so it is not "未排期".
 */
export function toSchedule(
  records: FeishuRecord[],
  now: Date = new Date(),
  view: TasksView = { read: 'legacy' },
) {
  if (view.read !== 'v2') {
    const events = records
      .filter(({ row }) => first(row[3]) === 'Doing' && row[5] && row[6] && isTodayDate(row[5], now))
      .map(({ row }) => ({
        title: str(row[0]) ?? '(untitled)',
        start: str(row[5]) as string,
        end: str(row[6]) as string,
        priority: first(row[2]) ?? 'P2',
      }))
      .sort(byStartThenPriority);
    return { events };
  }

  const today = shanghaiDayKey(now);
  const events: ScheduleEvent[] = [];
  const planned: PlannedTask[] = [];
  for (const rec of records) {
    const { row } = rec;
    const start = str(row[5]);
    const end = str(row[6]);
    const title = str(row[0]) ?? '(untitled)';
    const priority = first(row[2]) ?? 'P2';
    const done = rec.completed === true;
    if (!done && start && end && intervalOverlapsShanghaiDay(start, end, now)) {
      events.push({ id: rec.record_id, title, start, end, priority });
      continue;
    }
    const day = planDateKey(rec.planDate);
    const scheduledElsewhere = isValidSchedule(start, end);
    if (!done && day === today && !scheduledElsewhere && first(row[4]) !== 'Reminder') {
      planned.push({ id: rec.record_id, title, priority, plan_date: day });
    }
  }
  events.sort(byStartThenPriority);
  planned.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema: 'v2' as const, events, planned };
}

// calendar feed contract: { events: [{id, title, start, end, priority}] } —
// the multi-day sibling of toSchedule, backing the /api/calendar.ics
// subscription. Unlike toSchedule it takes ANY slotted record (both Scheduled
// times present, any Status/Type — Done blocks stay as history and completion
// does not clear them), with the Scheduled Start inside a window around `now`.
// Plan date and the completion checkbox do not add or remove feed events.
// `id` carries the record_id so ICS UIDs stay `${record_id}@pulse`.
// End<=Start is left in the row; toIcs drops it. Nothing here writes a calendar.
export const CALENDAR_PAST_MS = 3 * 24 * 3600 * 1000;
export const CALENDAR_FUTURE_MS = 14 * 24 * 3600 * 1000;

export function toCalendar(
  records: FeishuRecord[],
  now: Date = new Date(),
  window: { pastMs: number; futureMs: number } = {
    pastMs: CALENDAR_PAST_MS,
    futureMs: CALENDAR_FUTURE_MS,
  },
) {
  const lo = now.getTime() - window.pastMs;
  const hi = now.getTime() + window.futureMs;
  const events = records
    .filter(({ row }) => row[5] && row[6])
    .map(({ row, record_id }) => ({
      id: record_id,
      title: str(row[0]) ?? '(untitled)',
      start: str(row[5]) as string,
      end: str(row[6]) as string,
      priority: first(row[2]) ?? 'P2',
    }))
    .filter((e) => {
      const t = Date.parse(e.start);
      return t >= lo && t <= hi;
    })
    .sort(byStartThenPriority);
  return { events };
}

// pending_writes → batch_update payload. Single select takes a plain string.
// Later entries for the same record win (toggle endpoint already dedupes).
export function buildBatchUpdate(
  writes: PendingWrite[],
  opts?: { completedField?: string | null },
) {
  const byId = new Map<string, PendingWrite>();
  for (const w of writes) {
    if (w?.record_id && typeof w.status === 'string') byId.set(w.record_id, w);
  }
  return [...byId].map(([record_id, w]) => {
    const fields: Record<string, string | boolean> = { Status: w.status as string };
    if (opts?.completedField && typeof w.completed === 'boolean') {
      fields[opts.completedField] = w.completed;
    }
    return { record_id, fields };
  });
}

// The wide records/search read is eventually consistent — right after a
// batch_update it can return the pre-write Status, which would flip a freshly
// clicked todo back to undone until the next round. Requeue the still-
// unsettled ids into pending_writes so the local done flags survive.
export function requeueWrites(
  local: Partial<TodoData> | null | undefined,
  unsettled: Set<string>,
): PendingWrite[] {
  const prev = new Map<string, PendingWrite>();
  for (const w of Array.isArray(local?.pending_writes) ? local!.pending_writes! : []) {
    if (w?.record_id && !prev.has(w.record_id)) prev.set(w.record_id, w);
  }
  const out: PendingWrite[] = [];
  for (const list of [local?.items, local?.done_items]) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      if (!it?.id || !unsettled.has(it.id)) continue;
      const w = prev.get(it.id);
      const rebuilt: PendingWrite = {
        ...(w ?? {}),
        record_id: it.id,
        status: it.done ? 'Done' : (it.prev_status ?? 'Inbox'),
        requested_at: typeof w?.requested_at === 'string' ? w.requested_at : new Date().toISOString(),
      };
      if (typeof w?.completed === 'boolean' || w?.schema === 'v2') {
        rebuilt.completed = it.done === true;
        rebuilt.schema = 'v2';
      }
      if (
        w &&
        (w.status !== rebuilt.status ||
          (typeof rebuilt.completed === 'boolean' && w.completed !== rebuilt.completed))
      ) {
        delete rebuilt.landed;
      }
      out.push(rebuilt);
      prev.delete(it.id);
    }
  }
  // unsettled ids that vanished from both lists — keep the queued write.
  for (const id of unsettled) {
    const w = prev.get(id);
    if (w) out.push(w);
  }
  return out;
}
