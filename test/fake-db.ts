// In-memory D1 fake for route/unit tests. Dispatches on the SQL text — every
// statement src/worker.ts and src/tasks.ts issue is handled here, so tests
// exercise real bind positions and row flow rather than stubbed returns.
import type { TaskRow } from '../src/tasks';

export interface FakeWidgetRow {
  id: string;
  title: string;
  data: string;
  updated_at: string;
  source: string | null;
}

export function makeTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title'>): TaskRow {
  return {
    type: 'Task',
    status: 'Inbox',
    done: 0,
    due: null,
    priority: 'P2',
    plan_date: null,
    scheduled_start: null,
    scheduled_end: null,
    notes: '',
    project: null,
    tags: null,
    calendar_event_id: null,
    completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

const TASK_COLS: (keyof TaskRow)[] = [
  'id', 'title', 'type', 'status', 'done', 'due', 'priority', 'plan_date',
  'scheduled_start', 'scheduled_end', 'notes', 'project', 'tags',
  'calendar_event_id', 'completed_at', 'created_at', 'updated_at',
];

export function fakeDb(init: { tasks?: TaskRow[]; widgets?: FakeWidgetRow[] } = {}) {
  const tasks = [...(init.tasks ?? [])];
  const widgets = [...(init.widgets ?? [])];

  function runSelect(sql: string, binds: unknown[]): unknown[] {
    if (/^SELECT \* FROM tasks ORDER BY/.test(sql)) {
      return [...tasks].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    }
    if (/^SELECT \* FROM tasks WHERE id/.test(sql)) {
      return tasks.filter((t) => t.id === binds[0]);
    }
    if (/^SELECT \* FROM widgets ORDER BY id/.test(sql)) {
      return [...widgets].sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    if (/^SELECT \* FROM widgets WHERE id/.test(sql)) {
      return widgets.filter((w) => w.id === binds[0]);
    }
    if (/^SELECT data FROM widgets WHERE id/.test(sql)) {
      const w = widgets.find((x) => x.id === binds[0]);
      return w ? [{ data: w.data }] : [];
    }
    if (/^SELECT title FROM widgets WHERE id/.test(sql)) {
      const w = widgets.find((x) => x.id === binds[0]);
      return w ? [{ title: w.title }] : [];
    }
    throw new Error(`fakeDb: unhandled SELECT: ${sql}`);
  }

  // Mirror toggleTask's CASE-WHEN semantics: binds are
  // [done, done, done, stamp, (note, note)?, updated_at, id].
  function runToggle(binds: unknown[]): number {
    const id = binds[binds.length - 1];
    const t = tasks.find((x) => x.id === id);
    if (!t) return 0;
    const done = binds[0] === 1;
    t.status = done ? 'Done' : t.status === 'Done' ? 'Inbox' : t.status;
    if (t.done === 0 && done) t.completed_at = binds[3] as string;
    t.done = done ? 1 : 0;
    t.updated_at = binds[binds.length - 2] as string;
    return 1;
  }

  function runUpdate(binds: unknown[]): number {
    const id = binds[binds.length - 1];
    const t = tasks.find((x) => x.id === id);
    if (!t) return 0;
    // UPDATE tasks SET title=?, type=?, ... updated_at=? — 15 columns in order.
    const cols = TASK_COLS.filter((c) => c !== 'id' && c !== 'created_at');
    cols.forEach((c, i) => {
      (t as Record<string, unknown>)[c] = binds[i];
    });
    return 1;
  }

  function runWrite(sql: string, binds: unknown[]): number {
    if (/^UPDATE tasks SET\s+done/.test(sql)) {
      const changed = runToggle(binds);
      if (changed && /notes = CASE/.test(sql)) {
        const t = tasks.find((x) => x.id === binds[binds.length - 1]);
        const note = binds[4] as string;
        t!.notes = t!.notes === '' ? note : `${t!.notes}\n${note}`;
      }
      return changed;
    }
    if (/^UPDATE tasks SET title/.test(sql)) return runUpdate(binds);
    if (/^INSERT INTO tasks/.test(sql)) {
      const row = {} as Record<string, unknown>;
      TASK_COLS.forEach((c, i) => (row[c] = binds[i]));
      tasks.push(row as unknown as TaskRow);
      return 1;
    }
    if (/^DELETE FROM tasks/.test(sql)) {
      const i = tasks.findIndex((x) => x.id === binds[0]);
      if (i < 0) return 0;
      tasks.splice(i, 1);
      return 1;
    }
    if (/^INSERT INTO widgets/.test(sql)) {
      const [id, title, data, updated_at, source] = binds as string[];
      const i = widgets.findIndex((w) => w.id === id);
      const row = { id, title, data, updated_at, source };
      if (i < 0) widgets.push(row);
      else widgets[i] = row;
      return 1;
    }
    throw new Error(`fakeDb: unhandled write: ${sql}`);
  }

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) {
          binds = b;
          return stmt;
        },
        async first<T>() {
          return (runSelect(sql, binds)[0] ?? null) as T;
        },
        async all<T>() {
          return { results: runSelect(sql, binds) as T[] };
        },
        async run() {
          return { meta: { changes: runWrite(sql, binds) } };
        },
      };
      return stmt;
    },
  };

  return { db: db as unknown as D1Database, tasks, widgets };
}
