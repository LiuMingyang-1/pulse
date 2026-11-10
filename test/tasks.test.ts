import { describe, expect, it } from 'vitest';

import worker from '../src/worker';
import {
  intervalOverlapsShanghaiDay,
  isValidSchedule,
  parseTaskPatch,
  planDateKey,
  shanghaiDayKey,
  toCalendar,
  toReminder,
  toSchedule,
  toTodo,
  toggleTask,
} from '../src/tasks';
import { fakeDb, makeTask } from './fake-db';
import { SESSION_COOKIE, encodeSession } from '../src/session';

const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
const cookie = { Cookie: `${SESSION_COOKIE}=${encodeSession('secret')}` };
const bearer = { Authorization: 'Bearer secret' };

function envWith(
  init: Parameters<typeof fakeDb>[0] = {},
  hooks?: Parameters<typeof fakeDb>[1],
) {
  const fake = fakeDb(init, hooks);
  return {
    ...fake,
    env: {
      AGENT_TOKEN: 'secret',
      DB: fake.db,
      ASSETS: { fetch: async () => new Response('asset') },
    },
  };
}

const call = (env: unknown, url: string, init?: RequestInit) =>
  worker.fetch(new Request(url, init), env as any, ctx() as any);

const jsonCall = (env: unknown, url: string, init?: RequestInit) =>
  call(env, url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

// A fixed "now" inside Shanghai daytime so schedule tests are deterministic.
const NOW = new Date('2026-11-10T12:00:00+08:00');
const TODAY = '2026-11-10';

// ── Pure helpers ────────────────────────────────────────────────────────────
describe('date helpers', () => {
  it('planDateKey keeps a bare date, maps instants to the Shanghai day', () => {
    expect(planDateKey('2026-11-10')).toBe('2026-11-10');
    expect(planDateKey('2026/11/03')).toBe('2026-11-03');
    // 2026-11-09T20:00Z = 04:00 Nov 10 in Shanghai.
    expect(planDateKey('2026-11-09T20:00:00.000Z')).toBe('2026-11-10');
    expect(planDateKey('')).toBeNull();
    expect(planDateKey('garbage')).toBeNull();
    expect(planDateKey(null)).toBeNull();
    // Regex shape alone isn't enough — out-of-range days are rejected.
    expect(planDateKey('2026-13-45')).toBeNull();
    expect(planDateKey('2026-02-31')).toBeNull();
  });

  it('isValidSchedule needs both ends and end > start', () => {
    expect(isValidSchedule('2026-11-10T09:00:00+08:00', '2026-11-10T10:00:00+08:00')).toBe(true);
    expect(isValidSchedule('2026-11-10T10:00:00+08:00', '2026-11-10T09:00:00+08:00')).toBe(false);
    expect(isValidSchedule('2026-11-10T09:00:00+08:00', null)).toBe(false);
    expect(isValidSchedule('nope', 'nah')).toBe(false);
  });

  it('intervalOverlapsShanghaiDay covers overnight blocks', () => {
    const now = new Date('2026-11-10T12:00:00+08:00');
    // Started yesterday, ends today at 01:00 Shanghai → still today.
    expect(
      intervalOverlapsShanghaiDay('2026-11-09T23:00:00+08:00', '2026-11-10T01:00:00+08:00', now),
    ).toBe(true);
    // Ends exactly at today's Shanghai midnight → does not touch today.
    expect(
      intervalOverlapsShanghaiDay('2026-11-09T20:00:00+08:00', '2026-11-10T00:00:00+08:00', now),
    ).toBe(false);
    expect(shanghaiDayKey(now)).toBe(TODAY);
  });
});

// ── Widget transforms ───────────────────────────────────────────────────────
describe('toTodo', () => {
  it('lists not-done tasks, sinks today-completed into done_items', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'A', due: '2026-11-12T00:00:00+08:00', priority: 'P0' }),
      makeTask({ id: 'b', title: 'B', due: '2026-11-10T00:00:00+08:00', priority: 'P3' }),
      makeTask({
        id: 'c', title: 'C', done: 1, status: 'Done',
        completed_at: '2026-11-10T01:45:00+00:00', // 09:45 Shanghai → today
      }),
      makeTask({
        id: 'd', title: 'D', done: 1, status: 'Done',
        completed_at: '2026-11-08T01:45:00+00:00', // yesterday → not listed
      }),
      makeTask({ id: 'r', title: 'R', type: 'Reminder', due: '2026-11-10T09:00:00+08:00' }),
    ];
    const data = toTodo(tasks, NOW);
    expect(data.pending_count).toBe(2);
    expect(data.items.map((i) => i.id)).toEqual(['b', 'a']); // due asc first
    expect(data.done_items!.map((i) => i.id)).toEqual(['c']);
  });
});

describe('toSchedule', () => {
  it('timed events overlap the Shanghai day; plan_date today fills 未排期', () => {
    const tasks = [
      makeTask({
        id: 'timed', title: 'Timed',
        scheduled_start: '2026-11-10T14:00:00+08:00', scheduled_end: '2026-11-10T15:00:00+08:00',
      }),
      makeTask({ id: 'plan', title: 'Plan', plan_date: TODAY }),
      makeTask({ id: 'planOther', title: 'Other day', plan_date: '2026-11-12' }),
      makeTask({
        id: 'planClash', title: 'Clash', plan_date: TODAY,
        scheduled_start: '2026-11-12T14:00:00+08:00', scheduled_end: '2026-11-12T15:00:00+08:00',
      }),
      makeTask({ id: 'donePlan', title: 'Done plan', plan_date: TODAY, done: 1 }),
      makeTask({ id: 'remPlan', title: 'Reminder plan', type: 'Reminder', plan_date: TODAY }),
    ];
    const { events, planned } = toSchedule(tasks, NOW);
    expect(events.map((e) => e.id)).toEqual(['timed']);
    expect(planned.map((p) => p.id)).toEqual(['plan']);
  });

  it('a done task drops off today but a timed one stays in the ICS window', () => {
    const t = makeTask({
      id: 'x', title: 'X',
      scheduled_start: '2026-11-10T14:00:00+08:00', scheduled_end: '2026-11-10T15:00:00+08:00',
    });
    expect(toSchedule([t], NOW).events).toHaveLength(1);
    expect(toSchedule([{ ...t, done: 1 }], NOW).events).toHaveLength(0);
    expect(toCalendar([{ ...t, done: 1 }], NOW).events).toHaveLength(1);
  });
});

describe('toReminder / toCalendar', () => {
  it('reminder needs type=Reminder, not done, and a due', () => {
    const tasks = [
      makeTask({ id: 'r1', title: 'R1', type: 'Reminder', due: '2026-11-12T09:00:00+08:00' }),
      makeTask({ id: 'r2', title: 'R2', type: 'Reminder', due: '2026-11-10T09:00:00+08:00' }),
      makeTask({ id: 'r3', title: 'R3', type: 'Reminder' }), // no due → dropped
      makeTask({ id: 'r4', title: 'R4', type: 'Reminder', done: 1, due: '2026-11-10T09:00:00+08:00' }),
      makeTask({ id: 't', title: 'T', due: '2026-11-10T09:00:00+08:00' }), // Task → not a reminder
    ];
    expect(toReminder(tasks).items.map((i) => i.title)).toEqual(['R2', 'R1']);
  });

  it('calendar keeps scheduled tasks inside the window, ignores unscheduled', () => {
    const tasks = [
      makeTask({ id: 'in', title: 'In', scheduled_start: '2026-11-10T14:00:00+08:00', scheduled_end: '2026-11-10T15:00:00+08:00' }),
      makeTask({ id: 'far', title: 'Far', scheduled_start: '2027-11-10T14:00:00+08:00', scheduled_end: '2027-11-10T15:00:00+08:00' }),
      makeTask({ id: 'plan', title: 'Plan', plan_date: TODAY }), // plan alone never lands on the feed
      // Began 4 days ago, still running → window overlap keeps it.
      makeTask({ id: 'long', title: 'Long', scheduled_start: '2026-11-06T09:00:00+08:00', scheduled_end: '2026-11-11T18:00:00+08:00' }),
      // Inverted interval is invalid and never emits.
      makeTask({ id: 'bad', title: 'Bad', scheduled_start: '2026-11-10T15:00:00+08:00', scheduled_end: '2026-11-10T14:00:00+08:00' }),
    ];
    const { events } = toCalendar(tasks, NOW);
    expect(events.map((e) => e.id)).toEqual(['long', 'in']);
  });
});

// ── parseTaskPatch ──────────────────────────────────────────────────────────
describe('parseTaskPatch', () => {
  it('requires a title on create but not on patch', () => {
    expect(parseTaskPatch({}, false).error).toBe('title is required');
    expect(parseTaskPatch({}, true).error).toBeUndefined();
    expect(parseTaskPatch({ title: 'x' }, false).patch.title).toBe('x');
  });

  it('rejects unknown fields, arrays, and non-scalars', () => {
    expect(parseTaskPatch({ evil: 1 }, true).error).toMatch('unknown field');
    expect(parseTaskPatch([], true).error).toMatch('JSON object');
    expect(parseTaskPatch({ due: { x: 1 } }, true).error).toMatch('due');
  });

  it('normalizes done and plan_date', () => {
    expect(parseTaskPatch({ done: true }, true).patch.done).toBe(1);
    expect(parseTaskPatch({ done: 0 }, true).patch.done).toBe(0);
    expect(parseTaskPatch({ done: 'yes' }, true).error).toMatch('done');
    expect(parseTaskPatch({ plan_date: '2026/11/03' }, true).patch.plan_date).toBe('2026-11-03');
    expect(parseTaskPatch({ plan_date: 'garbage' }, true).error).toMatch('plan_date');
    expect(parseTaskPatch({ plan_date: null }, true).patch.plan_date).toBeNull();
  });

  it('validates instants and clears notes to empty string', () => {
    expect(parseTaskPatch({ due: 'tomorrow-ish' }, true).error).toMatch('due');
    expect(parseTaskPatch({ due: null }, true).patch.due).toBeNull();
    expect(parseTaskPatch({ notes: null }, true).patch.notes).toBe('');
    expect(parseTaskPatch({ notes: 'hi' }, true).patch.notes).toBe('hi');
  });
});

// ── toggleTask on the fake DB ───────────────────────────────────────────────
describe('toggleTask', () => {
  const stamp = '2026-11-10T04:00:00.000Z';

  it('flips done, stamps completed_at, lifts status to Done', async () => {
    const { db, tasks } = fakeDb({ tasks: [makeTask({ id: 't1', title: 'T' })] });
    expect(await toggleTask(db, 't1', true, null, stamp)).toEqual({ ok: true });
    expect(tasks[0]).toMatchObject({ done: 1, status: 'Done', completed_at: stamp });
  });

  it('appends a note in the same write', async () => {
    const { db, tasks } = fakeDb({
      tasks: [makeTask({ id: 't1', title: 'T', notes: 'earlier line' })],
    });
    await toggleTask(db, 't1', true, 'reflected', stamp);
    expect(tasks[0].notes).toBe('earlier line\nreflected');
  });

  it('undo restores Inbox only from Done and keeps the completion stamp', async () => {
    const { db, tasks } = fakeDb({
      tasks: [
        makeTask({ id: 't1', title: 'T', done: 1, status: 'Done', completed_at: stamp }),
        makeTask({ id: 't2', title: 'T2', done: 1, status: 'Waiting', completed_at: stamp }),
      ],
    });
    await toggleTask(db, 't1', false, null, stamp);
    expect(tasks[0]).toMatchObject({ done: 0, status: 'Inbox', completed_at: stamp });
    await toggleTask(db, 't2', false, null, stamp);
    expect(tasks[1].status).toBe('Waiting'); // custom label survives undo
  });

  it('missing id → item_not_found', async () => {
    const { db } = fakeDb();
    expect(await toggleTask(db, 'nope', true, null, stamp)).toEqual({
      ok: false,
      error: 'item_not_found',
    });
  });
});

// ── Route level: /api/tasks CRUD + auth ────────────────────────────────────
describe('/api/tasks', () => {
  it('401 for anonymous reads and writes', async () => {
    const { env } = envWith();
    for (const [method, url] of [
      ['GET', 'https://pulse.test/api/tasks'],
      ['POST', 'https://pulse.test/api/tasks'],
      ['PATCH', 'https://pulse.test/api/tasks/x'],
      ['DELETE', 'https://pulse.test/api/tasks/x'],
    ]) {
      const res = await call(env, url, { method });
      expect(res.status).toBe(401);
    }
  });

  it('create → get → patch → delete round trip', async () => {
    const { env, tasks } = envWith();

    const created = await jsonCall(env, 'https://pulse.test/api/tasks', {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({
        title: 'Ship it', priority: 'P1', plan_date: '2026/11/10',
        scheduled_start: '2026-11-10T14:00:00+08:00', scheduled_end: '2026-11-10T15:00:00+08:00',
      }),
    });
    expect(created.status).toBe(201);
    const task = await created.json();
    expect(task.id).toMatch(/^t_/);
    expect(task).toMatchObject({
      title: 'Ship it', type: 'Task', status: 'Inbox', done: 0,
      priority: 'P1', plan_date: '2026-11-10', notes: '',
    });

    const got = await call(env, `https://pulse.test/api/tasks/${task.id}`, { headers: bearer });
    expect(got.status).toBe(200);
    expect((await got.json()).title).toBe('Ship it');

    const patched = await jsonCall(env, `https://pulse.test/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ done: true, notes: 'shipped it' }),
    });
    expect(patched.status).toBe(200);
    const after = await patched.json();
    expect(after.done).toBe(1);
    expect(after.status).toBe('Done');
    expect(after.completed_at).toBeTruthy(); // auto-stamped on the 0→1 flip

    const listed = await call(env, 'https://pulse.test/api/tasks', { headers: bearer });
    expect((await listed.json()).tasks).toHaveLength(1);
    expect(tasks).toHaveLength(1);

    const del = await call(env, `https://pulse.test/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: bearer,
    });
    expect(del.status).toBe(200);
    const gone = await call(env, `https://pulse.test/api/tasks/${task.id}`, { headers: bearer });
    expect(gone.status).toBe(404);
  });

  it('an explicit completed_at on done:true wins over auto-stamping', async () => {
    const { env } = envWith({ tasks: [makeTask({ id: 't1', title: 'T' })] });
    const res = await jsonCall(env, 'https://pulse.test/api/tasks/t1', {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ done: true, completed_at: '2026-11-01T00:00:00.000Z' }),
    });
    expect((await res.json()).completed_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('400 on invalid json, missing title, unknown field, bad done', async () => {
    const { env } = envWith();
    const bad = (init?: RequestInit) =>
      call(env, 'https://pulse.test/api/tasks', { method: 'POST', ...init });
    expect((await bad({ headers: bearer, body: '{' })).status).toBe(400);
    expect(
      (await jsonCall(env, 'https://pulse.test/api/tasks', {
        method: 'POST', headers: bearer, body: JSON.stringify({ priority: 'P0' }),
      })).status,
    ).toBe(400);
    for (const body of [{ title: 'x', nope: 1 }, { title: 'x', done: 'yes' }]) {
      const res = await jsonCall(env, 'https://pulse.test/api/tasks', {
        method: 'POST', headers: bearer, body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('null on a required column is a 400, not a DB-level 500', async () => {
    const { env } = envWith({ tasks: [makeTask({ id: 't1', title: 'T' })] });
    for (const body of [{ title: null }, { type: null }, { status: null }, { priority: null }]) {
      const res = await jsonCall(env, 'https://pulse.test/api/tasks/t1', {
        method: 'PATCH', headers: bearer, body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    // Empty-string title is rejected on both create and patch.
    for (const method of ['POST', 'PATCH']) {
      const url = method === 'POST' ? '/api/tasks' : '/api/tasks/t1';
      const res = await jsonCall(env, `https://pulse.test${url}`, {
        method, headers: bearer, body: JSON.stringify({ title: '  ' }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('instants require an explicit offset — bare dates and junk are rejected', async () => {
    const { env } = envWith({ tasks: [makeTask({ id: 't1', title: 'T' })] });
    for (const due of ['2026-11-10T09:00', '2026-11-10', '1', 'next friday']) {
      const res = await jsonCall(env, 'https://pulse.test/api/tasks/t1', {
        method: 'PATCH', headers: bearer, body: JSON.stringify({ due }),
      });
      expect(res.status).toBe(400);
    }
    for (const due of ['2026-11-10T09:00:00Z', '2026-11-10T09:00+08:00']) {
      const res = await jsonCall(env, 'https://pulse.test/api/tasks/t1', {
        method: 'PATCH', headers: bearer, body: JSON.stringify({ due }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('an explicit completed_at: null on create beats the auto-stamp', async () => {
    const { env } = envWith();
    const res = await jsonCall(env, 'https://pulse.test/api/tasks', {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({ title: 'Backfill', done: true, completed_at: null }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.done).toBe(1);
    expect(task.completed_at).toBeNull();
  });

  it('PATCH retries when a concurrent write moved updated_at', async () => {
    // Simulate the race: the SELECT sees updated_at=A, then a concurrent
    // write bumps it to B before our UPDATE — the optimistic WHERE misses,
    // we re-read and land the patch on top of their write.
    let raced = false;
    const { env, tasks } = envWith(
      { tasks: [makeTask({ id: 't1', title: 'T' })] },
      {
        beforeWrite(sql, rows) {
          if (!raced && /^UPDATE tasks SET title/.test(sql)) {
            raced = true;
            rows[0]!.updated_at = '2099-01-01T00:00:00.000Z';
            rows[0]!.notes = 'their note'; // concurrent append survives our patch
          }
        },
      },
    );
    const res = await jsonCall(env, 'https://pulse.test/api/tasks/t1', {
      method: 'PATCH', headers: bearer, body: JSON.stringify({ priority: 'P0' }),
    });
    expect(res.status).toBe(200);
    const row = await res.json();
    expect(row.priority).toBe('P0');
    expect(row.notes).toBe('their note'); // not silently overwritten
    expect(tasks[0]!.priority).toBe('P0');
  });

  it('PATCH returns 409 when the row keeps moving', async () => {
    let n = 0;
    const { env } = envWith(
      { tasks: [makeTask({ id: 't1', title: 'T' })] },
      {
        beforeWrite(sql, rows) {
          if (/^UPDATE tasks SET title/.test(sql)) {
            rows[0]!.updated_at = `2099-01-01T00:00:00.0${++n}Z`;
          }
        },
      },
    );
    // Every UPDATE attempt finds a newer updated_at, so both miss.
    const res = await jsonCall(env, 'https://pulse.test/api/tasks/t1', {
      method: 'PATCH', headers: bearer, body: JSON.stringify({ priority: 'P0' }),
    });
    expect(res.status).toBe(409);
  });
});

// ── Route level: toggle + widget merge ─────────────────────────────────────
describe('POST /api/todo/toggle', () => {
  it('repaints the todo widget; a note lands on the row in one write', async () => {
    const { env, tasks } = envWith({
      tasks: [makeTask({ id: 't1', title: 'Reflect me', notes: 'old' })],
    });
    const res = await jsonCall(env, 'https://pulse.test/api/todo/toggle', {
      method: 'POST',
      headers: cookie,
      body: JSON.stringify({ id: 't1', done: true, note: 'did the thing' }),
    });
    expect(res.status).toBe(200);
    const widget = await res.json();
    expect(widget.id).toBe('todo');
    expect(widget.data.items).toHaveLength(0);
    expect(widget.data.done_items[0].id).toBe('t1');
    expect(tasks[0]).toMatchObject({ done: 1, status: 'Done', notes: 'old\ndid the thing' });
  });

  it('404 on an unknown id; 400 on bad shape — including a null body', async () => {
    const { env } = envWith();
    const missing = await jsonCall(env, 'https://pulse.test/api/todo/toggle', {
      method: 'POST',
      headers: cookie,
      body: JSON.stringify({ id: 'ghost', done: true }),
    });
    expect(missing.status).toBe(404);
    for (const raw of ['null', '{"id":"x","done":"yes"}', '42']) {
      const res = await call(env, 'https://pulse.test/api/todo/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie },
        body: raw,
      });
      expect(res.status).toBe(400);
    }
  });

  it('a note on undo is ignored — notes only attach to completions', async () => {
    const { env, tasks } = envWith({
      tasks: [makeTask({ id: 't1', title: 'T', done: 1, status: 'Done', notes: 'kept' })],
    });
    const res = await jsonCall(env, 'https://pulse.test/api/todo/toggle', {
      method: 'POST',
      headers: cookie,
      body: JSON.stringify({ id: 't1', done: false, note: 'should not land' }),
    });
    expect(res.status).toBe(200);
    expect(tasks[0]!.notes).toBe('kept');
    expect(tasks[0]!.done).toBe(0);
  });
});

describe('GET /api/widgets merge', () => {
  it('computed task widgets join stored blobs; a stale todo blob is shadowed', async () => {
    const { env } = envWith({
      tasks: [makeTask({ id: 't1', title: 'Real task' })],
      widgets: [
        {
          id: 'todo', title: '飞书待办',
          data: '{"pending_count":9,"items":[]}',
          updated_at: '2026-10-01T00:00:00.000Z', source: 'old',
        },
        {
          id: 'stocks', title: '美股持仓',
          data: '{"total_pnl":1}',
          updated_at: '2026-10-01T00:00:00.000Z', source: 'cron',
        },
      ],
    });
    const res = await call(env, 'https://pulse.test/api/widgets');
    const widgets = await res.json();
    const byId = Object.fromEntries(widgets.map((w: { id: string }) => [w.id, w]));
    expect(byId.todo.data.items[0].title).toBe('Real task'); // computed, not the blob
    expect(byId.todo.data.pending_count).toBe(1);
    expect(byId.stocks.data.total_pnl).toBe(1);
    expect(byId.schedule).toBeTruthy();
    expect(byId.reminder).toBeTruthy();
  });

  it('a task-widget push is rejected — writes go through /api/tasks', async () => {
    const { env } = envWith();
    for (const id of ['todo', 'reminder', 'schedule', 'calendar']) {
      const res = await jsonCall(env, `https://pulse.test/api/widgets/${id}`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ data: {} }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('managed_by_tasks');
    }
  });
});
