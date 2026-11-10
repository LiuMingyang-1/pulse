// Tasks live in D1 — no upstream to sync against. Widget payloads are
// computed from task rows at read time, so a toggle is one UPDATE and the
// next poll already reflects it. The todo/reminder/schedule/calendar widget
// JSON shapes are unchanged from the Feishu-sync era.

export interface TaskRow {
  id: string;
  title: string;
  type: string;            // Task | Reminder | Reading | Campus ...
  status: string;          // workflow label — completion is `done`, not Status
  done: number;            // 0 | 1
  due: string | null;
  priority: string;        // P0..P3
  plan_date: string | null; // 'YYYY-MM-DD' Shanghai day
  scheduled_start: string | null;
  scheduled_end: string | null;
  notes: string;
  project: string | null;
  tags: string | null;
  calendar_event_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const TASK_WIDGET_IDS = new Set(['todo', 'reminder', 'schedule', 'calendar']);

// ── Day helpers (Shanghai is the board's day boundary) ────────────────────
const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

export function shanghaiDayKey(now: Date): string {
  return SHANGHAI_DAY.format(now);
}

/** Calendar day of a plan-date value. `yyyy-MM-dd`/`yyyy/MM/dd` keeps its day; instants go through Shanghai. */
export function planDateKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const dateOnly = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (dateOnly) {
    // Reject out-of-range days — '2026-13-45' must not pass the regex check.
    const d = new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`);
    if (
      d.getUTCFullYear() !== +dateOnly[1] ||
      d.getUTCMonth() !== +dateOnly[2] - 1 ||
      d.getUTCDate() !== +dateOnly[3]
    ) return null;
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return SHANGHAI_DAY.format(d);
}

export function isTodayDate(iso: unknown, now: Date = new Date()): boolean {
  if (typeof iso !== 'string' || iso.trim() === '') return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return SHANGHAI_DAY.format(d) === SHANGHAI_DAY.format(now);
}

export function isValidSchedule(start: string | null | undefined, end: string | null | undefined): boolean {
  if (!start || !end) return false;
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Number.isFinite(s) && Number.isFinite(e) && e > s;
}

/** Start < next Shanghai midnight AND end > this Shanghai midnight, and end > start. */
export function intervalOverlapsShanghaiDay(startIso: string, endIso: string, now: Date): boolean {
  if (!isValidSchedule(startIso, endIso)) return false;
  const startMs = Date.parse(`${SHANGHAI_DAY.format(now)}T00:00:00.000+08:00`);
  const nextMs = startMs + 86_400_000;
  return Date.parse(startIso) < nextMs && Date.parse(endIso) > startMs;
}

// ── Sorting ───────────────────────────────────────────────────────────────
// 'P0' → 0 … 'P3' → 3; missing/unparsable sinks to 9.
function priorityRank(p: string | undefined): number {
  const n = Number(p?.replace('P', '') ?? '9');
  return Number.isFinite(n) ? n : 9;
}

const dueMs = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
};

function byDueThenPriority(a: { due: string | null; priority: string }, b: { due: string | null; priority: string }): number {
  const da = dueMs(a.due);
  const db = dueMs(b.due);
  if (da !== null && db !== null && da !== db) return da - db;
  if (da === null && db !== null) return 1;
  if (da !== null && db === null) return -1;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

function byStartThenPriority(
  a: { start: string; priority: string },
  b: { start: string; priority: string },
): number {
  const sa = Date.parse(a.start);
  const sb = Date.parse(b.start);
  if (sa !== sb) return sa - sb;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

// ── Widget payloads ───────────────────────────────────────────────────────
export interface TodoItem {
  id: string;
  title: string;
  due: string | null;
  priority: string;
  status?: string;
  done?: boolean;
  completed_at?: string;
  plan_date?: string | null;
}
export interface TodoData {
  pending_count: number;
  items: TodoItem[];
  done_items?: TodoItem[];
}

export const DONE_LIMIT = 20;

const toItem = (t: TaskRow): TodoItem => ({
  id: t.id,
  title: t.title,
  due: t.due,
  priority: t.priority || 'P2',
  status: t.status,
  plan_date: t.plan_date,
});

export function toTodo(tasks: TaskRow[], now: Date = new Date()): TodoData {
  const items = tasks
    .filter((t) => !t.done && t.type === 'Task')
    .map(toItem)
    .sort(byDueThenPriority);
  const done_items = tasks
    .filter((t) => t.done && t.type === 'Task' && isTodayDate(t.completed_at, now))
    .sort((a, b) => (dueMs(a.completed_at) ?? 0) - (dueMs(b.completed_at) ?? 0))
    .slice(-DONE_LIMIT)
    .map((t) => ({ ...toItem(t), done: true, completed_at: t.completed_at! }));
  return {
    pending_count: items.length,
    items,
    ...(done_items.length ? { done_items } : {}),
  };
}

export function toReminder(tasks: TaskRow[]) {
  const items = tasks
    .filter((t) => !t.done && t.type === 'Reminder' && t.due)
    .map((t) => ({ title: t.title, due: t.due as string }))
    .sort((a, b) => (dueMs(a.due) ?? 0) - (dueMs(b.due) ?? 0));
  return { items };
}

export interface ScheduleEvent {
  id?: string;
  title: string;
  start: string;
  end: string;
  priority: string;
}
export interface PlannedTask {
  id: string;
  title: string;
  priority: string;
  plan_date: string;
}

/**
 * 今日安排 is a union, not an intersection:
 * 1. timed — a valid Scheduled interval overlapping today (any type, not done)
 * 2. 今日选中 · 未排期 — plan_date is today, no valid interval, not done, not a Reminder
 * `status` plays no part; a scheduled reminder still lands on the timeline.
 */
export function toSchedule(tasks: TaskRow[], now: Date = new Date()) {
  const today = shanghaiDayKey(now);
  const events: ScheduleEvent[] = [];
  const planned: PlannedTask[] = [];
  for (const t of tasks) {
    if (t.done) continue;
    const start = t.scheduled_start;
    const end = t.scheduled_end;
    if (start && end && intervalOverlapsShanghaiDay(start, end, now)) {
      events.push({ id: t.id, title: t.title, start, end, priority: t.priority || 'P2' });
      continue;
    }
    if (t.plan_date === today && !isValidSchedule(start, end) && t.type !== 'Reminder') {
      planned.push({ id: t.id, title: t.title, priority: t.priority || 'P2', plan_date: today });
    }
  }
  events.sort(byStartThenPriority);
  planned.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { events, planned };
}

// calendar feed: any slotted task (Done blocks stay as history) whose start
// sits in a window around now. plan_date and done never add/remove events.
export const CALENDAR_PAST_MS = 3 * 24 * 3600 * 1000;
export const CALENDAR_FUTURE_MS = 14 * 24 * 3600 * 1000;

export function toCalendar(
  tasks: TaskRow[],
  now: Date = new Date(),
  window: { pastMs: number; futureMs: number } = { pastMs: CALENDAR_PAST_MS, futureMs: CALENDAR_FUTURE_MS },
) {
  const lo = now.getTime() - window.pastMs;
  const hi = now.getTime() + window.futureMs;
  const events = tasks
    .filter((t) => isValidSchedule(t.scheduled_start, t.scheduled_end))
    .map((t) => ({
      id: t.id,
      title: t.title,
      start: t.scheduled_start as string,
      end: t.scheduled_end as string,
      priority: t.priority || 'P2',
    }))
    // Overlap, not start-in-window — an event that began before the window
    // but is still running belongs on the feed.
    .filter((e) => Date.parse(e.start) <= hi && Date.parse(e.end) >= lo)
    .sort(byStartThenPriority);
  return { events };
}

// ── D1 access ─────────────────────────────────────────────────────────────
export async function listTasks(db: D1Database): Promise<TaskRow[]> {
  // datetime() normalizes the mixed Z/+08:00 formats to UTC — a plain lexical
  // ORDER BY would sort the same instant differently by suffix.
  const { results } = await db.prepare('SELECT * FROM tasks ORDER BY datetime(created_at)').all<TaskRow>();
  return results ?? [];
}

const TASK_WIDGET_TITLES: Record<string, string> = {
  todo: '待办',
  reminder: 'Reminder',
  schedule: '今日安排',
  calendar: '日程订阅',
};

export interface WidgetPayload {
  id: string;
  title: string;
  data: unknown;
  updated_at: string;
  source: string;
}

/** todo / reminder / schedule — computed per request, never stored. */
export async function boardTaskWidgets(db: D1Database, now: Date = new Date()): Promise<WidgetPayload[]> {
  const tasks = await listTasks(db);
  const nowIso = now.toISOString();
  const data: Record<string, unknown> = {
    todo: toTodo(tasks, now),
    reminder: toReminder(tasks),
    schedule: toSchedule(tasks, now),
  };
  return Object.entries(data).map(([id, d]) => ({
    id,
    title: TASK_WIDGET_TITLES[id],
    data: d,
    updated_at: nowIso,
    source: 'tasks',
  }));
}

/** The hidden calendar feed row for /api/calendar.ics. */
export async function calendarWidget(db: D1Database, now: Date = new Date()): Promise<WidgetPayload> {
  const tasks = await listTasks(db);
  return {
    id: 'calendar',
    title: TASK_WIDGET_TITLES.calendar,
    data: toCalendar(tasks, now),
    updated_at: now.toISOString(),
    source: 'tasks',
  };
}

/** The todo widget alone — toggle/create/update responses repaint from it. */
export async function todoWidget(db: D1Database, now: Date = new Date()): Promise<WidgetPayload> {
  const tasks = await listTasks(db);
  return {
    id: 'todo',
    title: TASK_WIDGET_TITLES.todo,
    data: toTodo(tasks, now),
    updated_at: now.toISOString(),
    source: 'tasks',
  };
}

// ── Writes ────────────────────────────────────────────────────────────────
/**
 * One todo check/undo. done=1 stamps completed_at (only on a real 0→1 flip)
 * and sets status='Done'; done=0 restores 'Inbox' only when the label is
 * 'Done' — a label set outside the completion flow (e.g. Waiting on a task
 * never checked) is left alone by an undo. A non-empty
 * note appends one line to `notes` in the same UPDATE, so the reflection can
 * never be split from the completion it describes.
 */
export async function toggleTask(
  db: D1Database,
  id: string,
  done: boolean,
  note: string | null,
  nowIso: string,
): Promise<{ ok: true } | { ok: false; error: 'item_not_found' }> {
  const r = await db.prepare(
    `UPDATE tasks SET
       done = ?,
       status = CASE WHEN ? = 1 THEN 'Done' WHEN status = 'Done' THEN 'Inbox' ELSE status END,
       completed_at = CASE WHEN done = 0 AND ? = 1 THEN ? ELSE completed_at END
       ${note ? `, notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END` : ''},
       updated_at = ?
     WHERE id = ?`,
  ).bind(
    done ? 1 : 0,           // done =
    done ? 1 : 0,           // WHEN ? = 1 (status)
    done ? 1 : 0, nowIso,   // WHEN done = 0 AND ? = 1 THEN ? (completed_at)
    ...(note ? [note, note] : []),
    nowIso,                 // updated_at
    id,
  ).run();
  return (r.meta?.changes ?? 0) > 0 ? { ok: true } : { ok: false, error: 'item_not_found' };
}

// ── Task CRUD (agent API) ─────────────────────────────────────────────────
const EDITABLE = new Set([
  'title', 'type', 'status', 'done', 'due', 'priority', 'plan_date',
  'scheduled_start', 'scheduled_end', 'notes', 'project', 'tags',
  'calendar_event_id', 'completed_at',
]);

export interface ParsedPatch {
  patch: Record<string, string | number | null>;
  error?: string;
}

// An instant must carry an explicit offset — '2026-11-10T09:00' without one is
// ambiguous (V8 reads it as local time, Workers as UTC) and Date.parse also
// accepts junk like "1". Bare dates stay legal only for plan_date.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function parseInstant(name: string, v: unknown, patch: Record<string, string | number | null>): string | null {
  if (v === null) { patch[name] = null; return null; }
  if (typeof v !== 'string' || !v.trim()) return `${name} must be an ISO string or null`;
  const s = v.trim();
  if (!ISO_INSTANT.test(s) || !Number.isFinite(Date.parse(s))) {
    return `${name} must be an ISO 8601 instant with an explicit offset (…Z or ±hh:mm)`;
  }
  patch[name] = s;
  return null;
}

/**
 * Whitelist + normalize an agent-supplied create/update body.
 * done accepts boolean/0/1; plan_date normalizes to a Shanghai day key;
 * due/scheduled_* must be parseable instants; completed_at is settable so a
 * backfill can say "done yesterday" — a 0→1 flip stamps it automatically.
 */
// NOT NULL columns: null would survive validation only to die as a 500 on the
// constraint — reject it up front so the client gets a 400.
const REQUIRED_COLS = new Set(['title', 'type', 'status', 'priority']);

export function parseTaskPatch(body: unknown, partial: boolean): ParsedPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { patch: {}, error: 'body must be a JSON object' };
  }
  const src = body as Record<string, unknown>;
  const patch: Record<string, string | number | null> = {};
  for (const key of Object.keys(src)) {
    if (!EDITABLE.has(key)) return { patch: {}, error: `unknown field: ${key}` };
    const v = src[key];
    if (key === 'done') {
      if (typeof v !== 'boolean' && v !== 0 && v !== 1) return { patch: {}, error: 'done must be true|false|0|1' };
      patch.done = v === true || v === 1 ? 1 : 0;
    } else if (key === 'plan_date') {
      if (v === null) { patch.plan_date = null; continue; }
      const day = planDateKey(v as string);
      if (day === null) return { patch: {}, error: 'plan_date must be a date' };
      patch.plan_date = day;
    } else if (key === 'due' || key === 'scheduled_start' || key === 'scheduled_end' || key === 'completed_at') {
      const err = parseInstant(key, v, patch);
      if (err) return { patch: {}, error: err };
    } else if (v === null) {
      if (REQUIRED_COLS.has(key)) return { patch: {}, error: `${key} cannot be null` };
      patch[key] = key === 'notes' ? '' : null;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      patch[key] = String(v);
    } else {
      return { patch: {}, error: `${key} must be a scalar` };
    }
  }
  if ('title' in patch && (typeof patch.title !== 'string' || patch.title.trim() === '')) {
    return { patch: {}, error: 'title must be a non-empty string' };
  }
  if (!partial && !('title' in patch)) {
    return { patch: {}, error: 'title is required' };
  }
  return { patch };
}

export async function createTask(
  db: D1Database,
  patch: Record<string, string | number | null>,
  nowIso: string,
): Promise<TaskRow> {
  const id = `t_${crypto.randomUUID()}`;
  const done = (patch.done as number) ?? 0;
  const row: TaskRow = {
    id,
    title: (patch.title as string) ?? '(untitled)',
    type: (patch.type as string) ?? 'Task',
    status: (patch.status as string) ?? (done ? 'Done' : 'Inbox'),
    done,
    due: (patch.due as string | null) ?? null,
    priority: (patch.priority as string) ?? 'P2',
    plan_date: (patch.plan_date as string | null) ?? null,
    scheduled_start: (patch.scheduled_start as string | null) ?? null,
    scheduled_end: (patch.scheduled_end as string | null) ?? null,
    notes: (patch.notes as string) ?? '',
    project: (patch.project as string | null) ?? null,
    tags: (patch.tags as string | null) ?? null,
    calendar_event_id: (patch.calendar_event_id as string | null) ?? null,
    // An explicit completed_at (even null) wins; auto-stamp only when absent.
    completed_at: 'completed_at' in patch
      ? (patch.completed_at as string | null)
      : (done ? nowIso : null),
    created_at: nowIso,
    updated_at: nowIso,
  };
  await db.prepare(
    `INSERT INTO tasks (id, title, type, status, done, due, priority, plan_date,
      scheduled_start, scheduled_end, notes, project, tags, calendar_event_id,
      completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.title, row.type, row.status, row.done, row.due, row.priority,
    row.plan_date, row.scheduled_start, row.scheduled_end, row.notes, row.project,
    row.tags, row.calendar_event_id, row.completed_at, row.created_at, row.updated_at,
  ).run();
  return row;
}

export async function updateTask(
  db: D1Database,
  id: string,
  patch: Record<string, string | number | null>,
  nowIso: string,
): Promise<{ ok: true; row: TaskRow } | { ok: false; error: 'item_not_found' | 'conflict' }> {
  // Optimistic concurrency: the UPDATE only lands when updated_at is still
  // what the SELECT saw, so a toggle-with-note (or another PATCH) landing in
  // between is never silently overwritten. Retry once on a lost race.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
    if (!cur) return { ok: false, error: 'item_not_found' };
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      (next as Record<string, unknown>)[k] = v;
    }
    // A 0→1 flip stamps completed_at unless the caller stamped it explicitly;
    // undo keeps the old stamp — same semantics as the toggle route.
    if (patch.done === 1 && cur.done === 0 && patch.completed_at === undefined) next.completed_at = nowIso;
    if (patch.done === 1 && cur.status !== 'Done' && patch.status === undefined) next.status = 'Done';
    if (patch.done === 0 && cur.status === 'Done' && patch.status === undefined) next.status = 'Inbox';
    next.updated_at = nowIso;
    const r = await db.prepare(
      `UPDATE tasks SET title=?, type=?, status=?, done=?, due=?, priority=?, plan_date=?,
        scheduled_start=?, scheduled_end=?, notes=?, project=?, tags=?, calendar_event_id=?,
        completed_at=?, updated_at=?
       WHERE id = ? AND updated_at = ?`,
    ).bind(
      next.title, next.type, next.status, next.done, next.due, next.priority, next.plan_date,
      next.scheduled_start, next.scheduled_end, next.notes, next.project, next.tags,
      next.calendar_event_id, next.completed_at, next.updated_at, id, cur.updated_at,
    ).run();
    if ((r.meta?.changes ?? 0) > 0) return { ok: true, row: next };
  }
  return { ok: false, error: 'conflict' };
}

export async function deleteTask(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function getTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
}
