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

// Stateful Feishu fake: `state.primary` is the primary store (what batch_update
// writes and single-record GETs read); `state.staleWide` makes records/search
// keep serving r1's old Status — the multi-minute index lag. Mutate `state`
// between sync runs to simulate an index catch-up or an external edit.
function mockFetch(opts: { batchCode?: number; staleWide?: boolean } = {}) {
  const state = {
    staleWide: opts.staleWide ?? false,
    primary: { r1: 'Doing' as string | undefined, r2: 'Inbox' as string | undefined },
  };
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (url.includes('tenant_access_token')) return j({ code: 0, tenant_access_token: 'tok' });
    const recGet = url.match(/\/records\/([^/?]+)\?field_names=/);
    if (recGet) {
      const s = state.primary[recGet[1] as keyof typeof state.primary];
      if (s === undefined) return new Response('{}', { status: 404 });
      return j({ code: 0, data: { record: { fields: { Status: s } } } });
    }
    if (url.includes('records/search')) {
      const second = url.includes('page_token=p2');
      return j({ code: 0, data: second
        ? { items: [{ record_id: 'r2', fields: { Task: 'two', Status: state.primary.r2, Type: 'Task' } }], has_more: false }
        : { items: [{ record_id: 'r1', fields: { Task: [{ text: 'one' }], Status: state.staleWide ? 'Doing' : state.primary.r1, Type: 'Task' } }], has_more: true, page_token: 'p2' } });
    }
    if (url.includes('batch_update')) {
      if (opts.batchCode) return j({ code: opts.batchCode, msg: 'nope' });
      for (const r of body.records) state.primary[r.record_id as keyof typeof state.primary] = r.fields.Status;
      return j({ code: 0, msg: 'ok' });
    }
    return new Response('?', { status: 404 });
  }));
  const batchCalls = () => calls.filter((c) => c.url.includes('batch_update'));
  return { calls, state, batchCalls };
}

afterEach(() => vi.unstubAllGlobals());

describe('runFeishuSync', () => {
  it('not_configured without secrets', async () => {
    expect(await runFeishuSync({ DB: fakeDB({}) as any })).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('paginates, drains writes with string select, writes widgets', async () => {
    const m = mockFetch();
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', done: true, pending: true, completed_at: new Date().toISOString() }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    const r = await runFeishuSync(env(db) as any);
    expect(r).toMatchObject({ ok: true, fetched: 2, writes: { sent: 1, failed: 0, held: 0, unsettled: 0 }, todo: 'written' });
    expect(m.batchCalls()).toHaveLength(1);
    expect(m.batchCalls()[0].body).toEqual({ records: [{ record_id: 'r1', fields: { Status: 'Done' } }] });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toBeUndefined();
    // r1's write is visible in the wide read → sinks into done_items.
    expect(todo.items.map((i: any) => i.title)).toEqual(['two']);
    expect(todo.done_items.map((i: any) => i.id)).toEqual(['r1']);
    expect(db.rows.reminder && db.rows.schedule).toBeTruthy();
  });

  it('keeps failed writes', async () => {
    // Send fails → the write never lands; the index keeps the old Status.
    mockFetch({ batchCode: 1254000, staleWide: true });
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', done: true }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    const r = await runFeishuSync(env(db) as any);
    expect(r.writes).toEqual({ sent: 0, failed: 1, held: 0, unsettled: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toHaveLength(1);
    expect(todo.pending_writes[0].landed).toBeUndefined();
    expect(todo.items.find((i: any) => i.id === 'r1').sync_failed).toBe(true);
  });

  it('stale wide read holds the write and the local done flag', async () => {
    // batch_update landed but records/search still shows 'Doing' — the index
    // hasn't caught up. The item must stay done+pending (no failure ring) and
    // the write stays queued as `landed` — held for the index, not retried.
    const m = mockFetch({ staleWide: true });
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Doing' }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    const r = await runFeishuSync(env(db) as any);
    expect(r.writes).toEqual({ sent: 1, failed: 0, held: 1, unsettled: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toEqual([{ record_id: 'r1', status: 'Done', landed: true, requested_at: expect.any(String) }]);
    expect(todo.items.find((i: any) => i.id === 'r1')).toMatchObject({ done: true, pending: true });
    expect(todo.items.find((i: any) => i.id === 'r1').sync_failed).toBeUndefined();
    expect(m.batchCalls()).toHaveLength(1);
  });

  it('second sync while the index still lags holds without resending', async () => {
    // The PR#7 hole: once a write was acked the queue emptied, so the NEXT
    // sync with a still-stale read flipped the item back to undone. And the
    // PR#8 review: a held write must NOT be re-sent — that would clobber a
    // Feishu-side edit made during the lag.
    const m = mockFetch({ staleWide: true });
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Doing' }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    await runFeishuSync(env(db) as any);
    const r2 = await runFeishuSync(env(db) as any);
    expect(m.batchCalls()).toHaveLength(1); // landed write never re-sent
    expect(r2.writes).toEqual({ sent: 0, failed: 0, held: 1, unsettled: 1 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.items.find((i: any) => i.id === 'r1')).toMatchObject({ done: true, pending: true });
    expect(todo.pending_writes).toHaveLength(1);
  });

  it('external edit during index lag releases the write instead of resending', async () => {
    // Done landed but the index still lags; another editor flips the row back
    // in Feishu. The next sync sees the primary diverged → releases the write
    // (and the local done flag) rather than re-sending Done over their edit.
    const m = mockFetch({ staleWide: true });
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Doing' }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    await runFeishuSync(env(db) as any); // send → held
    m.state.primary.r1 = 'Doing'; // external edit on the Feishu side
    const r2 = await runFeishuSync(env(db) as any);
    expect(m.batchCalls()).toHaveLength(1); // no resend
    expect(r2.writes).toEqual({ sent: 0, failed: 0, held: 0, unsettled: 0 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.pending_writes).toBeUndefined();
    expect(todo.items.find((i: any) => i.id === 'r1').done).toBeUndefined();
  });

  it('a held completion lands in done_items with its completed_at once the index catches up', async () => {
    const completedAt = new Date().toISOString();
    const m = mockFetch({ staleWide: true });
    const db = fakeDB({ todo: { data: JSON.stringify({ items: [{ id: 'r1', title: 'one', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Doing', completed_at: completedAt }], pending_writes: [{ record_id: 'r1', status: 'Done' }] }), updated_at: 'T0' } });
    await runFeishuSync(env(db) as any); // held — item keeps done + completed_at
    m.state.staleWide = false; // index catches up → wide read shows 'Done'
    const r2 = await runFeishuSync(env(db) as any);
    expect(r2.writes).toEqual({ sent: 0, failed: 0, held: 0, unsettled: 0 });
    const todo = JSON.parse(db.rows.todo.data);
    expect(todo.done_items.map((i: any) => i.id)).toEqual(['r1']);
    expect(todo.done_items[0].completed_at).toBe(completedAt);
    expect(todo.pending_writes).toBeUndefined();
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
