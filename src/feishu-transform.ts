// Pure Feishu → widget transforms, ported 1:1 from scripts/sync-feishu.mjs.
// No I/O here so it can be unit-tested (test/feishu-transform.test.ts).
//
// Records use the same positional shape lark-cli produced for the script:
//   row = [Task, Due, Priority, Status, Type, Scheduled Start, Scheduled End]
// adaptRecord() converts bitable OpenAPI records into that shape.

export const FIELD_NAMES = [
  'Task', 'Due', 'Priority', 'Status', 'Type',
  'Scheduled Start', 'Scheduled End',
] as const;
const DATE_FIELDS = new Set(['Due', 'Scheduled Start', 'Scheduled End']);
const SELECT_FIELDS = new Set(['Priority', 'Status', 'Type']);

export type Cell = string | string[] | null;
export interface FeishuRecord { row: Cell[]; record_id: string }

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
}
export interface PendingWrite { record_id?: string; status?: string; [k: string]: unknown }
export interface TodoData {
  pending_count: number;
  items: TodoItem[];
  done_items?: TodoItem[];
  pending_writes?: PendingWrite[];
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

export function adaptRecord(rec: { record_id: string; fields?: Record<string, unknown> }): FeishuRecord {
  const f = rec.fields ?? {};
  return { record_id: rec.record_id, row: FIELD_NAMES.map((n) => adaptValue(n, f[n])) };
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
  nowIso: string,
): TodoData {
  void acked; // kept for parity with the script's signature
  const now = new Date(nowIso);
  const localById = new Map<string, TodoItem>();
  for (const list of [local?.items, local?.done_items]) {
    if (Array.isArray(list)) for (const it of list) if (it?.id) localById.set(it.id, it);
  }
  const localWrites = Array.isArray(local?.pending_writes) ? local!.pending_writes! : [];
  const queuedIds = new Set(localWrites.map((w) => w?.record_id).filter(Boolean) as string[]);

  const items: TodoItem[] = pending(records, 'Task')
    .map(({ row, record_id: id }) => {
      const prev = localById.get(id);
      const it: TodoItem = {
        id,
        title: str(row[0]) ?? '(untitled)',
        due: str(row[1]) ?? null,
        priority: first(row[2]) ?? 'P2',
        status: first(row[3]),
      };
      if (prev?.done && (queuedIds.has(id) || failed.has(id))) {
        it.done = true;
        if (prev.prev_status) it.prev_status = prev.prev_status;
        it.pending = true;
        if (failed.has(id)) it.sync_failed = true;
      }
      return it;
    })
    .sort(byDueThenPriority);

  const mergedDone: TodoItem[] = records
    .filter(({ row }) => first(row[3]) === 'Done' && first(row[4]) === 'Task')
    .map(({ row, record_id: id }) => {
      const prev = localById.get(id);
      const it: TodoItem = {
        id,
        title: str(row[0]) ?? '(untitled)',
        due: str(row[1]) ?? null,
        priority: first(row[2]) ?? 'P2',
        status: 'Done',
        done: true,
      };
      if (prev?.completed_at) it.completed_at = prev.completed_at;
      else if (prev && prev.done !== true) it.completed_at = nowIso;
      if (prev?.prev_status) it.prev_status = prev.prev_status;
      if (prev && prev.done === false && (queuedIds.has(id) || failed.has(id))) {
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

  const pending_writes = localWrites.filter((w) => w?.record_id && failed.has(w.record_id));

  return {
    pending_count: items.filter((it) => !it.done).length,
    items,
    ...(sunken.length ? { done_items: sunken } : {}),
    ...(pending_writes.length ? { pending_writes } : {}),
  };
}

export function toReminder(records: FeishuRecord[]) {
  const items = pending(records, 'Reminder')
    .filter(({ row }) => row[1])
    .map(({ row }) => ({ title: str(row[0]) ?? '(untitled)', due: str(row[1]) as string }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  return { items };
}

export function toSchedule(records: FeishuRecord[], now: Date = new Date()) {
  const events = records
    .filter(({ row }) => first(row[3]) === 'Doing' && row[5] && row[6] && isTodayDate(row[5], now))
    .map(({ row }) => ({
      title: str(row[0]) ?? '(untitled)',
      start: str(row[5]) as string,
      end: str(row[6]) as string,
      priority: first(row[2]) ?? 'P2',
    }))
    .sort((a, b) => {
      // Start ascending by timestamp (isTodayDate already guarantees it
      // parses); same instant → higher priority (smaller P number) first,
      // same semantics as byDueThenPriority. Equal keys return 0.
      const sa = Date.parse(a.start);
      const sb = Date.parse(b.start);
      if (sa !== sb) return sa - sb;
      return priorityRank(a.priority) - priorityRank(b.priority);
    });
  return { events };
}

// pending_writes → batch_update payload. Single select takes a plain string.
// Later entries for the same record win (toggle endpoint already dedupes).
export function buildBatchUpdate(writes: PendingWrite[]) {
  const byId = new Map<string, string>();
  for (const w of writes) {
    if (w?.record_id && typeof w.status === 'string') byId.set(w.record_id, w.status);
  }
  return [...byId].map(([record_id, status]) => ({ record_id, fields: { Status: status } }));
}
