import { describe, it, expect } from 'vitest';
import {
  adaptRecord, adaptValue, msToShanghaiIso, isTodayDate, toTodo, toReminder, toSchedule,
  buildBatchUpdate, type FeishuRecord,
} from '../src/feishu-transform';

const NOW = new Date('2026-10-13T04:00:00.000Z'); // 12:00 Shanghai
const ms = (iso: string) => new Date(iso).getTime();
const rec = (id: string, f: Record<string, unknown>) => adaptRecord({ record_id: id, fields: f });

describe('adapter', () => {
  it('formats dates like lark-cli (+08:00)', () => {
    expect(msToShanghaiIso(ms('2026-10-14T07:00:00Z'))).toBe('2026-10-14T15:00:00.000+08:00');
    expect(msToShanghaiIso(ms('2026-10-13T16:30:00Z'))).toBe('2026-10-14T00:30:00.000+08:00');
  });
  it('maps text/select/date/missing', () => {
    const r = rec('r1', {
      Task: [{ type: 'text', text: 'Write ' }, { type: 'text', text: 'docs' }],
      Due: ms('2026-10-14T07:00:00Z'), Priority: 'P1', Status: 'Doing', Type: 'Task',
    });
    expect(r).toEqual({
      record_id: 'r1',
      row: ['Write docs', '2026-10-14T15:00:00.000+08:00', ['P1'], ['Doing'], ['Task'], null, null],
    });
    expect(adaptValue('Task', 'plain')).toBe('plain');
    expect(adaptValue('Due', '1760000000000')).toBe(msToShanghaiIso(1760000000000));
    expect(adaptValue('Status', [])).toBeNull();
    expect(adaptValue('Task', [])).toBeNull();
  });
});

describe('isTodayDate', () => {
  it('uses Shanghai day boundaries', () => {
    expect(isTodayDate('2026-10-13T23:59:00.000+08:00', NOW)).toBe(true);
    expect(isTodayDate('2026-10-14T00:00:00.000+08:00', NOW)).toBe(false);
    expect(isTodayDate('2026-10-12T16:00:00.000Z', NOW)).toBe(true);
    expect(isTodayDate('', NOW)).toBe(false);
    expect(isTodayDate('garbage', NOW)).toBe(false);
  });
});

const T = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  rec(id, { Task: id, Status: status, Type: 'Task', ...extra });

describe('toTodo', () => {
  it('sorts by due then priority, undated last, defaults P2', () => {
    const recs: FeishuRecord[] = [
      T('a', 'Inbox', { Priority: 'P2', Due: ms('2026-10-15T00:00:00Z') }),
      T('b', 'Doing', { Priority: 'P0' }),
      T('c', 'Inbox', { Priority: 'P2', Due: ms('2026-10-14T00:00:00Z') }),
      T('d', 'Inbox'),
      rec('r', { Task: 'rem', Status: 'Inbox', Type: 'Reminder' }),
    ];
    const t = toTodo(recs, null, new Set(), new Set(), NOW.toISOString());
    expect(t.items.map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(t.pending_count).toBe(4);
    expect(t.items[3].priority).toBe('P2');
    expect(t.done_items).toBeUndefined();
    expect(t.pending_writes).toBeUndefined();
  });

  it('same due → priority (P0 first); equal keys keep input order', () => {
    const due = ms('2026-10-14T10:00:00Z');
    const recs: FeishuRecord[] = [
      T('p2', 'Inbox', { Priority: 'P2', Due: due }),
      T('p0', 'Inbox', { Priority: 'P0', Due: due }),
      T('p1a', 'Inbox', { Priority: 'P1', Due: due }),
      T('p1b', 'Inbox', { Priority: 'P1', Due: due }),
      T('early', 'Inbox', { Priority: 'P3', Due: ms('2026-10-14T09:00:00Z') }),
      T('nd3', 'Inbox', { Priority: 'P3' }),
      T('nd0', 'Inbox', { Priority: 'P0' }),
    ];
    const t = toTodo(recs, null, new Set(), new Set(), NOW.toISOString());
    expect(t.items.map((i) => i.id)).toEqual(['early', 'p0', 'p1a', 'p1b', 'p2', 'nd0', 'nd3']);
  });

  it('keeps local done while queued; drops acked writes; keeps failed', () => {
    const recs = [T('a', 'Doing'), T('b', 'Doing'), T('c', 'Doing')];
    const local = {
      items: [
        { id: 'a', title: 'a', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Doing' },
        { id: 'b', title: 'b', due: null, priority: 'P2', done: true, pending: true, prev_status: 'Inbox' },
        { id: 'c', title: 'c', due: null, priority: 'P2', done: true, pending: true },
      ],
      pending_writes: [{ record_id: 'a', status: 'Done' }, { record_id: 'b', status: 'Done' }],
    };
    const t = toTodo(recs, local, new Set(['a']), new Set(['b']), NOW.toISOString());
    const by = Object.fromEntries(t.items.map((i) => [i.id, i]));
    expect(by.a).toMatchObject({ done: true, pending: true, prev_status: 'Doing' });
    expect(by.a.sync_failed).toBeUndefined();
    expect(by.b).toMatchObject({ done: true, sync_failed: true, prev_status: 'Inbox' });
    expect(by.c.done).toBeUndefined(); // superseded: not queued → Feishu truth
    expect(t.pending_count).toBe(1);
    expect(t.pending_writes).toEqual([{ record_id: 'b', status: 'Done' }]);
  });

  it('stamps completed_at only for newly completed; done_items today-only', () => {
    const recs = [T('new', 'Done'), T('old', 'Done'), T('kept', 'Done'), T('yday', 'Done')];
    const local = {
      items: [{ id: 'new', title: 'new', due: null, priority: 'P2', status: 'Doing' }],
      done_items: [
        { id: 'kept', title: 'k', due: null, priority: 'P2', done: true, completed_at: '2026-10-13T01:00:00.000Z' },
        { id: 'yday', title: 'y', due: null, priority: 'P2', done: true, completed_at: '2026-10-12T10:00:00.000Z' },
      ],
    };
    const t = toTodo(recs, local, new Set(), new Set(), NOW.toISOString());
    expect(t.done_items!.map((i) => i.id)).toEqual(['new', 'kept']);
    expect(t.done_items![0].completed_at).toBe(NOW.toISOString());
    expect(t.items).toEqual([]);
  });

  it('pending undo lifts a Done row back into items', () => {
    const recs = [T('u', 'Done')];
    const local = {
      items: [{ id: 'u', title: 'u', due: null, priority: 'P2', done: false, pending: true, prev_status: 'Doing' }],
      pending_writes: [{ record_id: 'u', status: 'Doing' }],
    };
    const t = toTodo(recs, local, new Set(['u']), new Set(), NOW.toISOString());
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ id: 'u', done: false, pending: true, prev_status: 'Doing' });
    expect(t.pending_count).toBe(1);
  });

  it('caps done_items at 20', () => {
    const recs = Array.from({ length: 25 }, (_, i) => T(`d${i}`, 'Done'));
    const local = { items: recs.map((r) => ({ id: r.record_id, title: 'x', due: null, priority: 'P2' })) };
    expect(toTodo(recs, local, new Set(), new Set(), NOW.toISOString()).done_items).toHaveLength(20);
  });
});

describe('toReminder / toSchedule', () => {
  it('reminders: pending with due, sorted', () => {
    const recs = [
      rec('1', { Task: 'b', Status: 'Inbox', Type: 'Reminder', Due: ms('2026-10-15T00:00:00Z') }),
      rec('2', { Task: 'a', Status: 'Inbox', Type: 'Reminder', Due: ms('2026-10-14T00:00:00Z') }),
      rec('3', { Task: 'nodue', Status: 'Inbox', Type: 'Reminder' }),
      rec('4', { Task: 'done', Status: 'Done', Type: 'Reminder', Due: ms('2026-10-14T00:00:00Z') }),
    ];
    expect(toReminder(recs).items.map((i) => i.title)).toEqual(['a', 'b']);
  });
  it('schedule: Doing + both times + starts today, any Type', () => {
    const recs = [
      rec('1', { Task: 'late', Status: 'Doing', Type: 'Task', 'Scheduled Start': ms('2026-10-13T08:00:00Z'), 'Scheduled End': ms('2026-10-13T09:00:00Z') }),
      rec('2', { Task: 'early', Status: 'Doing', Type: 'Reading', 'Scheduled Start': ms('2026-10-13T01:00:00Z'), 'Scheduled End': ms('2026-10-13T02:00:00Z') }),
      rec('3', { Task: 'tomorrow', Status: 'Doing', 'Scheduled Start': ms('2026-10-14T01:00:00Z'), 'Scheduled End': ms('2026-10-14T02:00:00Z') }),
      rec('4', { Task: 'noend', Status: 'Doing', 'Scheduled Start': ms('2026-10-13T01:00:00Z') }),
      rec('5', { Task: 'inbox', Status: 'Inbox', 'Scheduled Start': ms('2026-10-13T01:00:00Z'), 'Scheduled End': ms('2026-10-13T02:00:00Z') }),
    ];
    const ev = toSchedule(recs, NOW).events;
    expect(ev.map((e) => e.title)).toEqual(['early', 'late']);
    expect(ev[0].start).toBe('2026-10-13T09:00:00.000+08:00');
  });
  it('schedule: same start → higher priority first, default P2, stable on ties', () => {
    const S = ms('2026-10-13T07:00:00Z'), E = ms('2026-10-13T10:00:00Z');
    const recs = [
      rec('1', { Task: 'p3', Priority: 'P3', Status: 'Doing', 'Scheduled Start': S, 'Scheduled End': E }),
      rec('2', { Task: 'none', Status: 'Doing', 'Scheduled Start': S, 'Scheduled End': E }),
      rec('3', { Task: 'p0', Priority: 'P0', Status: 'Doing', 'Scheduled Start': S, 'Scheduled End': E }),
      rec('4', { Task: 'p2a', Priority: 'P2', Status: 'Doing', 'Scheduled Start': S, 'Scheduled End': E }),
      rec('5', { Task: 'earlier', Priority: 'P3', Status: 'Doing', 'Scheduled Start': ms('2026-10-13T06:00:00Z'), 'Scheduled End': E }),
    ];
    const ev = toSchedule(recs, NOW).events;
    expect(ev.map((e) => e.title)).toEqual(['earlier', 'p0', 'none', 'p2a', 'p3']);
    expect(ev.find((e) => e.title === 'none')!.priority).toBe('P2');
  });
});

describe('buildBatchUpdate', () => {
  it('uses string single-select, last write wins, skips invalid', () => {
    expect(buildBatchUpdate([
      { record_id: 'a', status: 'Done' }, { record_id: 'a', status: 'Doing' },
      { record_id: 'b' }, { status: 'Done' }, { record_id: 'c', status: 'Done' },
    ])).toEqual([
      { record_id: 'a', fields: { Status: 'Doing' } },
      { record_id: 'c', fields: { Status: 'Done' } },
    ]);
  });
});
