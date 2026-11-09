import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFeishuSync } from '../src/feishu';
import { resetFeishuSyncGuardForTests } from '../src/feishu-sync-guard';

function fakeDB(todo: { data: string; updated_at: string } | null) {
  const rows: Record<string, { data: string; updated_at: string }> = {};
  if (todo) rows.todo = { ...todo };
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...a: unknown[]) {
          return {
            async first() {
              if (sql.includes('feishu_sync_guard')) return { state: 'idle', until_ms: 0 };
              const r = rows[a[0] as string];
              return r ? { ...r } : null;
            },
            async run() {
              if (sql.includes('feishu_sync_guard')) return { meta: { changes: 1 } };
              if (sql.startsWith('UPDATE') && sql.includes("id = 'todo'")) {
                if (rows.todo && rows.todo.updated_at === a[3]) {
                  rows.todo = { data: a[0] as string, updated_at: a[1] as string };
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              rows[a[0] as string] = { data: a[2] as string, updated_at: a[3] as string };
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function mockFeishu(opts: {
  fields?: string[];
  fieldCode?: number;
  batchCode?: number;
  record?: Record<string, unknown>;
  primary?: Record<string, unknown>;
}) {
  const calls: { url: string; body: unknown }[] = [];
  const primary = { ...(opts.primary ?? opts.record ?? {}) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.includes('tenant_access_token')) return j({ code: 0, tenant_access_token: 'tok' });
    if (url.includes('/fields?') || url.includes('/fields')) {
      if (opts.fieldCode) return j({ code: opts.fieldCode, msg: 'no fields' }, 400);
      const items = (opts.fields ?? ['Task', 'Status', '已完成', '计划日期']).map((field_name) => ({ field_name, field_id: `fld_${field_name}` }));
      return j({ code: 0, data: { items, has_more: false } });
    }
    if (url.includes('records/search')) {
      return j({ code: 0, data: { items: [{ record_id: 'r1', fields: opts.record ?? primary }], has_more: false } });
    }
    if (url.includes('batch_update')) {
      if (opts.batchCode) return j({ code: opts.batchCode, msg: 'nope' });
      for (const r of (body as { records: { record_id: string; fields: Record<string, unknown> }[] }).records) {
        Object.assign(primary, r.fields);
      }
      return j({ code: 0, msg: 'ok' });
    }
    if (/\/records\/[^/?]+(\?|$)/.test(url)) {
      return j({ code: 0, data: { record: { fields: primary } } });
    }
    return new Response('?', { status: 404 });
  }));
  return {
    calls,
    primary,
    batches: () => calls.filter((c) => c.url.includes('batch_update')),
    fieldLists: () => calls.filter((c) => c.url.includes('/fields')),
  };
}

const base = {
  FEISHU_APP_ID: 'id',
  FEISHU_APP_SECRET: 's',
  FEISHU_BASE_TOKEN: 'b',
  FEISHU_TABLE_ID: 't',
};

beforeEach(() => resetFeishuSyncGuardForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  resetFeishuSyncGuardForTests();
});

describe('runFeishuSync tasks schema', () => {
  it('does not probe or change Status authority when the gate is unset', async () => {
    const m = mockFeishu({
      record: { Task: 'one', Status: 'Done', Type: 'Task', 已完成: false },
    });
    const db = fakeDB({
      data: JSON.stringify({
        items: [],
        done_items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, completed_at: new Date().toISOString() }],
      }),
      updated_at: 'T0',
    });
    const r = await runFeishuSync({ ...base, DB: db } as never);
    expect(r.ok).toBe(true);
    expect(m.fieldLists()).toHaveLength(0);
    expect(m.batches()).toHaveLength(0);
    const search = m.calls.find((c) => c.url.includes('records/search'));
    expect(search?.body).toMatchObject({ field_names: ['Task', 'Due', 'Priority', 'Status', 'Type', 'Scheduled Start', 'Scheduled End'] });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.tasks_schema).toBeUndefined();
    expect(todo.done_items.map((i: { id: string }) => i.id)).toEqual(['r1']);
  });

  it('v2 false beats a lingering Done and does not write', async () => {
    mockFeishu({
      record: { Task: 'one', Status: 'Done', Type: 'Task', 已完成: false },
    });
    const db = fakeDB({ data: JSON.stringify({ items: [], pending_writes: [] }), updated_at: 'T0' });
    const r = await runFeishuSync({ ...base, DB: db, TASKS_SCHEMA: 'v2' } as never);
    expect(r.ok).toBe(true);
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.tasks_schema).toMatchObject({ gate: 'v2', read: 'v2', capability: 'v2', completed_field: '已完成' });
    expect(todo.items[0]).toMatchObject({ id: 'r1', status: 'Done' });
    expect(todo.items[0].done).toBeUndefined();
    expect(todo.done_items).toBeUndefined();
    expect(todo.pending_writes).toBeUndefined();
  });

  it('refuses v2 when the checkbox column is missing', async () => {
    mockFeishu({
      fields: ['Task', 'Status', '计划日期'],
      record: { Task: 'one', Status: 'Done', Type: 'Task' },
    });
    const db = fakeDB({
      data: JSON.stringify({
        done_items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, completed_at: new Date().toISOString() }],
      }),
      updated_at: 'T0',
    });
    await runFeishuSync({ ...base, DB: db, TASKS_SCHEMA: 'v2' } as never);
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.tasks_schema).toMatchObject({ gate: 'v2', read: 'legacy', capability: 'legacy' });
    expect(todo.done_items.map((i: { id: string }) => i.id)).toEqual(['r1']);
  });

  it('upgrades a status-only queue entry and dual-writes under the configured name', async () => {
    const m = mockFeishu({
      fields: ['Task', 'Status', '完成了', '计划日'],
      record: { Task: 'one', Status: 'Inbox', Type: 'Task', 完成了: false },
      primary: { Status: 'Inbox', 完成了: false },
    });
    const db = fakeDB({
      data: JSON.stringify({
        items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Inbox', completed_at: new Date().toISOString() }],
        pending_writes: [{ record_id: 'r1', status: 'Done', requested_at: '2026-10-13T01:00:00.000Z' }],
      }),
      updated_at: 'T0',
    });
    await runFeishuSync({
      ...base,
      DB: db,
      TASKS_SCHEMA: 'v2',
      FEISHU_FIELD_COMPLETED: '完成了',
      FEISHU_FIELD_PLAN_DATE: '计划日',
    } as never);
    expect(m.batches()[0].body).toEqual({
      records: [{ record_id: 'r1', fields: { Status: 'Done', 完成了: true } }],
    });
  });

  it('keeps the upgraded write when the batch fails', async () => {
    mockFeishu({
      batchCode: 1254000,
      record: { Task: 'one', Status: 'Inbox', Type: 'Task', 已完成: false },
      primary: { Status: 'Inbox', 已完成: false },
    });
    const db = fakeDB({
      data: JSON.stringify({
        items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Inbox' }],
        pending_writes: [{ record_id: 'r1', status: 'Done', requested_at: '2026-10-13T01:00:00.000Z' }],
      }),
      updated_at: 'T0',
    });
    const r = await runFeishuSync({ ...base, DB: db, TASKS_SCHEMA: 'compat' } as never);
    expect(r.writes).toMatchObject({ sent: 0, failed: 1, unsettled: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.tasks_schema.read).toBe('legacy');
    expect(todo.pending_writes[0]).toMatchObject({
      record_id: 'r1',
      status: 'Done',
      completed: true,
      schema: 'v2',
      requested_at: '2026-10-13T01:00:00.000Z',
    });
    expect(todo.pending_writes[0].landed).toBeUndefined();
    expect(todo.items.find((i: { id: string }) => i.id === 'r1').sync_failed).toBe(true);
  });

  it('an uncheck stays queued while the wide read still shows the old checkbox', async () => {
    const m = mockFeishu({
      record: { Task: 'one', Status: 'Done', Type: 'Task', 已完成: true },
      primary: { Status: 'Inbox', 已完成: false },
    });
    const db = fakeDB({
      data: JSON.stringify({
        items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: false, pending: true, prev_status: 'Inbox' }],
        pending_writes: [{ record_id: 'r1', status: 'Inbox', completed: false, schema: 'v2', requested_at: 'T0' }],
      }),
      updated_at: 'T0',
    });
    const r = await runFeishuSync({ ...base, DB: db, TASKS_SCHEMA: 'v2' } as never);
    expect(m.batches()).toHaveLength(0);
    expect(r.writes).toMatchObject({ sent: 0, held: 1, unsettled: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.items.find((i: { id: string }) => i.id === 'r1')).toMatchObject({ done: false, pending: true });
    expect(todo.pending_writes[0]).toMatchObject({ status: 'Inbox', completed: false, landed: true });
  });
});
