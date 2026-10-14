import { describe, it, expect, vi, afterEach } from 'vitest';
import { runFeishuSync } from '../src/feishu';

// Minimal fake D1: one in-memory widgets table, understands the 3 statements feishu.ts uses.
function fakeDB(initial: Record<string, { data: string; updated_at: string }>, onRead?: () => void) {
  const rows = { ...initial };
  const db = {
    rows,
    prepare(sql: string) {
      return {
        bind(...a: any[]) {
          return {
            async first() { const r = rows[a[0]]; onRead?.(); return r ? { ...r } : null; },
            async run() {
              let changes = 0;
              if (sql.startsWith('UPDATE')) {
                if (rows.todo && rows.todo.updated_at === a[3]) { rows.todo = { data: a[0], updated_at: a[1] }; changes = 1; }
              } else if (sql.includes('DO NOTHING')) {
                if (!rows.todo) { rows.todo = { data: a[0], updated_at: a[1] }; changes = 1; }
              } else { rows[a[0]] = { data: a[2], updated_at: a[3] }; changes = 1; }
              return { meta: { changes } };
            },
          };
        },
      };
    },
  };
  return db;
}

const env = (DB: any) => ({ DB, FEISHU_APP_ID: 'id', FEISHU_APP_SECRET: 's', FEISHU_BASE_TOKEN: 'b', FEISHU_TABLE_ID: 't' });

function mockFetch(batchCode = 0, opts: { staleReadBack?: boolean } = {}) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (url.includes('tenant_access_token')) return j({ code: 0, tenant_access_token: 'tok' });
    if (url.includes('records/search')) {
      const second = url.includes('page_token=p2');
      return j({ code: 0, data: second
        ? { items: [{ record_id: 'r2', fields: { Task: 'two', Status: 'Inbox', Type: 'Task' } }], has_more: false }
        : { items: [{ record_id: 'r1', fields: { Task: [{ text: 'one' }], Status: 'Doing', Type: 'Task' } }], has_more: true, page_token: 'p2' } });
    }
    if (url.includes('batch_update')) return j({ code: batchCode, msg: batchCode ? 'nope' : 'ok' });
    // Single-record read-back: pretend the write landed unless staleReadBack.
    const get = url.match(/records\/([\w-]+)\?field_names=Status/);
    if (get) {
      return j({ code: 0, data: { record: { record_id: get[1], fields: { Status: opts.staleReadBack ? 'Doing' : 'Done' } } } });
    }
    return new Response('?', { status: 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('runFeishuSync', () => {
  it('not_configured without secrets', async () => {
    expect(await runFeishuSync({ DB: fakeDB({}) as any })).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('paginates, drains writes with string select, writes widgets', async () => {
    const calls = mockFetch();
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', done: true, pending: true }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    const r = await runFeishuSync(env(db) as any);
    expect(r).toMatchObject({ ok: true, fetched: 2, writes: { acked: 1, failed: 0 }, todo: 'written' });
    expect(calls.find((c) => c.url.includes('batch_update'))!.body).toEqual({ records: [{ record_id: 'r1', fields: { Status: 'Done' } }] });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toBeUndefined();
    expect(todo.items.map((i: any) => i.title)).toEqual(['one', 'two']);
    expect(db.rows.reminder && db.rows.schedule).toBeTruthy();
  });

  it('keeps failed writes', async () => {
    mockFetch(1254000);
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', done: true }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    const r = await runFeishuSync(env(db) as any);
    expect(r.writes).toEqual({ acked: 0, failed: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toHaveLength(1);
    expect(todo.items.find((i: any) => i.id === 'r1').sync_failed).toBe(true);
  });

  it('stale read-back requeues the write and keeps local done', async () => {
    // batch_update succeeded but the narrow read-back still shows 'Doing' —
    // the write isn't visible yet, so the todo must not snap back to undone.
    mockFetch(0, { staleReadBack: true });
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Doing' }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    const r = await runFeishuSync(env(db) as any);
    expect(r.writes).toEqual({ acked: 0, failed: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toEqual([{ record_id: 'r1', status: 'Done', requested_at: expect.any(String) }]);
    expect(todo.items.find((i: any) => i.id === 'r1')).toMatchObject({ done: true, sync_failed: true });
  });

  it('skips todo write if row changed concurrently', async () => {
    mockFetch();
    const db = fakeDB({ todo: { data: '{"items":[]}', updated_at: 'T0' } }, () => { db.rows.todo = { data: '{"pending_writes":[{"record_id":"x","status":"Done"}]}', updated_at: 'T1' }; });
    const r = await runFeishuSync(env(db) as any);
    expect(r.todo).toBe('skipped_concurrent_edit');
    expect(db.rows.todo.updated_at).toBe('T1');
  });

  it('feishu error → ok:false, no widget writes, no secret in reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 99991672, msg: 'no scope' }), { status: 400 })));
    const db = fakeDB({});
    const r = await runFeishuSync(env(db) as any);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('99991672');
    expect(r.reason).not.toMatch(/\bs\b|app_secret/);
    expect(Object.keys(db.rows)).toEqual([]);
  });
});
