// One todo check/undo. Mutates the widget blob the caller just parsed.
// Legacy blobs gain no extra keys. v2 / compat dual-write adds `completed`
// beside Status so a later rollback to Status still has the new completion,
// and a later return to v2 still has the checkbox.

export interface ToggleItem {
  id?: string;
  status?: string;
  done?: boolean;
  pending?: boolean;
  prev_status?: string;
  sync_failed?: boolean;
  completed_at?: string;
  [k: string]: unknown;
}

export interface ToggleWrite {
  record_id?: string;
  status?: string;
  completed?: boolean;
  schema?: string;
  requested_at?: string;
  [k: string]: unknown;
}

export interface ToggleAudit {
  at: string;
  record_id: string;
  done: boolean;
  status: string;
  completed: boolean | null;
  schema: 'legacy' | 'v2';
}

export interface ToggleData {
  items?: ToggleItem[];
  done_items?: ToggleItem[];
  pending_writes?: ToggleWrite[];
  pending_count?: number;
  write_audit?: ToggleAudit[];
  [k: string]: unknown;
}

export interface ToggleCtx {
  /** compat/v2 and the last probe saw both fields. */
  writeCompleted: boolean;
  /** v2 only when the operator gate and the probe both say so. */
  readMode: 'legacy' | 'v2';
}

const AUDIT_LIMIT = 20;

export function applyTodoToggle(
  data: ToggleData,
  id: string,
  nowDone: boolean,
  nowIso: string,
  ctx: ToggleCtx,
): { ok: true } | { ok: false; error: 'item_not_found' } {
  const items: ToggleItem[] = Array.isArray(data.items) ? data.items : [];
  const doneItems: ToggleItem[] = Array.isArray(data.done_items) ? data.done_items : [];
  const it = [...items, ...doneItems].find((x) => x.id === id);
  if (!it) return { ok: false, error: 'item_not_found' };

  it.done = nowDone;
  it.pending = true;
  delete it.sync_failed;
  // completed_at survives undo. The item moving back into `items` is what
  // keeps it out of the sunken section. Scheduled times are not touched.
  if (nowDone && !it.prev_status) {
    if (ctx.readMode === 'v2' || ctx.writeCompleted) {
      // Never invent Doing. A real previous Doing is preserved; a missing
      // status becomes Inbox.
      it.prev_status = it.status && it.status !== 'Done' ? it.status : 'Inbox';
    } else {
      it.prev_status = it.status ?? 'Doing';
    }
  }
  if (nowDone) it.completed_at = nowIso;

  const writes: ToggleWrite[] = Array.isArray(data.pending_writes) ? data.pending_writes : [];
  const queued = writes.findIndex((x) => x?.record_id === id);
  const entry: ToggleWrite = {
    record_id: id,
    status: nowDone ? 'Done' : (it.prev_status ?? 'Inbox'),
    requested_at: nowIso,
  };
  if (ctx.writeCompleted) {
    entry.completed = nowDone;
    entry.schema = 'v2';
  }
  if (queued >= 0) writes.splice(queued, 1, entry);
  else writes.push(entry);
  data.pending_writes = writes;

  if (!nowDone && !items.includes(it)) {
    items.push(it);
    data.done_items = doneItems.filter((x) => x !== it);
  }
  data.items = items;
  data.pending_count = items.filter((x) => !x.done).length;

  if (ctx.writeCompleted || ctx.readMode === 'v2') {
    const audit = Array.isArray(data.write_audit) ? data.write_audit : [];
    audit.push({
      at: nowIso,
      record_id: id,
      done: nowDone,
      status: entry.status as string,
      completed: ctx.writeCompleted ? nowDone : null,
      schema: ctx.readMode,
    });
    data.write_audit = audit.slice(-AUDIT_LIMIT);
  }

  return { ok: true };
}
