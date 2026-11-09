// Tasks completion / plan-date cutover.
//
// Status used to mean three things at once: not done (Inbox), "on today's
// plan" (Doing), and done (Done). The replacement is two independent fields:
// a completion checkbox and a plan date. Scheduled Start/End stay time blocks.
// Due stays the deadline.
//
// The checkbox value alone cannot tell those modes apart. Feishu returns
// `false` both for an unchecked box and, from the reader's point of view, when
// the column was never part of the read. Authority is therefore a pair:
//
//   gate         operator switch, default legacy. Never implied by cell data.
//   capability   both configured field names exist on the table (field list,
//                matched by name). Unknown when the probe did not run or failed.
//
// Read authority is v2 only when gate === 'v2' AND capability === 'v2'.
// Otherwise completion stays Status === 'Done'. A checkbox false must not
// override Done until that pair is true, and a Status Done must not override
// an explicit false once it is.

export type TasksGate = 'legacy' | 'compat' | 'v2';
export type TasksCapability = 'unknown' | 'legacy' | 'v2';
export type TasksReadMode = 'legacy' | 'v2';

export const DEFAULT_COMPLETED_FIELD = '已完成';
export const DEFAULT_PLAN_DATE_FIELD = '计划日期';

const CORE_FIELDS = new Set([
  'Task', 'Due', 'Priority', 'Status', 'Type', 'Scheduled Start', 'Scheduled End',
]);

export interface TasksFieldNames {
  completed: string | null;
  planDate: string | null;
}

export interface TasksSchemaStamp {
  gate: TasksGate;
  read: TasksReadMode;
  capability: TasksCapability;
  completed_field: string | null;
  plan_date_field: string | null;
  probed_at?: string;
}

export interface PrimaryCells {
  status?: string;
  completed?: boolean;
}

const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

export function shanghaiDayKey(now: Date): string {
  return SHANGHAI_DAY.format(now);
}

export function parseTasksGate(raw: unknown): TasksGate {
  if (typeof raw !== 'string') return 'legacy';
  const v = raw.trim().toLowerCase();
  if (v === 'v2' || v === 'on') return 'v2';
  if (v === 'compat' || v === 'compatibility') return 'compat';
  return 'legacy';
}

/** Trimmed configured name, or null when it collides with a core column. */
export function configuredFieldName(raw: unknown, fallback: string): string | null {
  const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
  if (CORE_FIELDS.has(name)) return null;
  return name;
}

export function resolveFieldNames(env: {
  FEISHU_FIELD_COMPLETED?: string;
  FEISHU_FIELD_PLAN_DATE?: string;
}): TasksFieldNames {
  return {
    completed: configuredFieldName(env.FEISHU_FIELD_COMPLETED, DEFAULT_COMPLETED_FIELD),
    planDate: configuredFieldName(env.FEISHU_FIELD_PLAN_DATE, DEFAULT_PLAN_DATE_FIELD),
  };
}

/**
 * `present === null` means the field list was not probed. A probed list that
 * lacks either configured name is legacy — an unchecked box is not evidence
 * that the column exists.
 */
export function resolveCapability(
  present: ReadonlySet<string> | null,
  names: TasksFieldNames,
): TasksCapability {
  if (present === null) return 'unknown';
  if (!names.completed || !names.planDate) return 'legacy';
  return present.has(names.completed) && present.has(names.planDate) ? 'v2' : 'legacy';
}

export function tasksReadMode(gate: TasksGate, capability: TasksCapability): TasksReadMode {
  return gate === 'v2' && capability === 'v2' ? 'v2' : 'legacy';
}

/** Queue entries that only carry Status gain an explicit checkbox when dual-write is on. */
export function shouldUpgradeCompleted(gate: TasksGate, capability: TasksCapability): boolean {
  return capability === 'v2' && (gate === 'compat' || gate === 'v2');
}

export function parseCheckbox(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && parseCheckbox(v[0]);
  if (v && typeof v === 'object') {
    const o = v as { value?: unknown; text?: unknown };
    if ('value' in o) return parseCheckbox(o.value);
    if ('text' in o) return parseCheckbox(o.text);
    return false;
  }
  if (v === true || v === 1) return true;
  if (typeof v === 'string' && v.trim().toLowerCase() === 'true') return true;
  return false;
}

/**
 * Calendar date of a plan-date cell. `yyyy-MM-dd` / `yyyy/MM/dd` (no time) is
 * already a Shanghai calendar date. Instants go through the Shanghai day.
 * Empty stays empty — callers must not invent a day from Status or Scheduled.
 */
export function planDateKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const dateOnly = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return shanghaiDayKey(d);
}

export function isValidSchedule(start: string | null | undefined, end: string | null | undefined): boolean {
  if (!start || !end) return false;
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Number.isFinite(s) && Number.isFinite(e) && e > s;
}

/** Start < next Shanghai midnight AND end > this Shanghai midnight, and end > start. */
export function intervalOverlapsShanghaiDay(
  startIso: string,
  endIso: string,
  now: Date,
): boolean {
  if (!isValidSchedule(startIso, endIso)) return false;
  const startMs = Date.parse(`${shanghaiDayKey(now)}T00:00:00.000+08:00`);
  const nextMs = startMs + 86_400_000;
  return Date.parse(startIso) < nextMs && Date.parse(endIso) > startMs;
}

export interface UpgradeableWrite {
  record_id?: string;
  status?: string;
  completed?: boolean;
  schema?: string;
  landed?: boolean;
  upgraded_from?: string;
  [k: string]: unknown;
}

/**
 * Attach `completed` from the queued Status target. This upgrades a write the
 * user already queued; it does not scan rows or backfill 计划日期.
 * Status Doing/Inbox becomes completed false — Doing is not "in progress".
 * A newly attached checkbox clears `landed` so the next read has to see both.
 */
export function upgradePendingWrite<T extends UpgradeableWrite>(w: T, upgrade: boolean): T {
  if (!upgrade || !w?.record_id || typeof w.status !== 'string') return w;
  if (typeof w.completed === 'boolean') {
    return w.schema === 'v2' ? w : { ...w, schema: 'v2' };
  }
  const next: T = {
    ...w,
    completed: w.status === 'Done',
    schema: 'v2',
    upgraded_from: 'status',
  };
  delete next.landed;
  return next;
}

export function checkboxRequired(w: { completed?: unknown }, capability: TasksCapability): boolean {
  return typeof w.completed === 'boolean' && capability === 'v2';
}

/** Status match, plus the checkbox when this write is dual-writing it. */
export function writeMatches(
  cells: PrimaryCells | undefined,
  w: { status?: string; completed?: unknown },
  checkCompleted: boolean,
): boolean {
  if (!cells || cells.status !== w.status) return false;
  if (checkCompleted && typeof w.completed === 'boolean') return cells.completed === w.completed;
  return true;
}
