import { describe, expect, it } from 'vitest';
import {
  adaptRecord,
  buildBatchUpdate,
  requeueWrites,
  toCalendar,
  toSchedule,
  toTodo,
  type FeishuRecord,
} from '../src/feishu-transform';
import { toIcs } from '../src/ics';
import { schedule } from '../src/widgets/schedule';
import {
  intervalOverlapsShanghaiDay,
  parseTasksGate,
  resolveCapability,
  resolveFieldNames,
  tasksReadMode,
  upgradePendingWrite,
} from '../src/tasks-schema';
import { applyTodoToggle } from '../src/todo-toggle';

const NOW = new Date('2026-10-13T04:00:00.000Z'); // 12:00 Shanghai
const NOW_ISO = NOW.toISOString();
const ms = (iso: string) => new Date(iso).getTime();
const V2 = { read: 'v2' as const };
const FIELDS = { completedField: '已完成', planDateField: '计划日期' };
const none = () => new Set<string>();

function row(id: string, fields: Record<string, unknown>, adapt = false): FeishuRecord {
  return adaptRecord(
    { record_id: id, fields: { Task: id, Type: 'Task', ...fields } },
    adapt ? FIELDS : undefined,
  );
}

describe('schema gate', () => {
  it('defaults to legacy and refuses unknown values', () => {
    expect(parseTasksGate(undefined)).toBe('legacy');
    expect(parseTasksGate('')).toBe('legacy');
    expect(parseTasksGate('off')).toBe('legacy');
    expect(parseTasksGate('yes')).toBe('legacy');
    expect(parseTasksGate('v2')).toBe('v2');
    expect(parseTasksGate('compat')).toBe('compat');
  });

  it('names are configurable and never a field id; core names are rejected', () => {
    expect(resolveFieldNames({})).toEqual({ completed: '已完成', planDate: '计划日期' });
    expect(resolveFieldNames({
      FEISHU_FIELD_COMPLETED: ' 完成了 ',
      FEISHU_FIELD_PLAN_DATE: '计划日',
    })).toEqual({ completed: '完成了', planDate: '计划日' });
    expect(resolveFieldNames({ FEISHU_FIELD_COMPLETED: 'Status' }).completed).toBeNull();
    const names = resolveFieldNames({ FEISHU_FIELD_COMPLETED: '完成了', FEISHU_FIELD_PLAN_DATE: '计划日' });
    expect(resolveCapability(null, names)).toBe('unknown');
    expect(resolveCapability(new Set(['完成了']), names)).toBe('legacy');
    expect(resolveCapability(new Set(['完成了', '计划日']), names)).toBe('v2');
    expect(tasksReadMode('v2', 'legacy')).toBe('legacy');
    expect(tasksReadMode('v2', 'unknown')).toBe('legacy');
    expect(tasksReadMode('compat', 'v2')).toBe('legacy');
    expect(tasksReadMode('legacy', 'v2')).toBe('legacy');
    expect(tasksReadMode('v2', 'v2')).toBe('v2');
  });

  it('a false checkbox does not count as schema capability', () => {
    const names = resolveFieldNames({});
    expect(resolveCapability(new Set(), names)).toBe('legacy');
    const rec = row('a', { Status: 'Done', 已完成: false }, true);
    expect(rec.completed).toBe(false);
    expect(tasksReadMode('legacy', 'legacy')).toBe('legacy');
  });
});

describe('completion authority', () => {
  it('legacy keeps Status Done even when the checkbox cell is false', () => {
    const rec = row('a', { Status: 'Done', 已完成: false }, true);
    const local = {
      items: [{ id: 'a', title: 'a', due: null, priority: 'P2', done: true, completed_at: NOW_ISO }],
    };
    const t = toTodo([rec], local, none(), none(), none(), NOW_ISO);
    expect(t.items).toEqual([]);
    expect(t.done_items?.map((i) => i.id)).toEqual(['a']);
    expect(t.done_items?.[0].plan_date).toBeUndefined();
  });

  it('v2: explicit false wins over Status Done and does not bounce back', () => {
    const rec = row('a', { Status: 'Done', 已完成: false, '计划日期': null }, true);
    const t = toTodo([rec], null, none(), none(), none(), NOW_ISO, V2);
    expect(t.done_items).toBeUndefined();
    expect(t.items).toHaveLength(1);
    expect(t.items[0].done).toBeUndefined();
    expect(t.items[0].status).toBe('Done');
    expect(t.pending_count).toBe(1);
  });

  it('v2: checkbox true is done even while Status is still Inbox', () => {
    const rec = row('a', { Status: 'Inbox', 已完成: true }, true);
    const local = { items: [{ id: 'a', title: 'a', due: null, priority: 'P2', status: 'Inbox' }] };
    const t = toTodo([rec], local, none(), none(), none(), NOW_ISO, V2);
    expect(t.done_items?.[0]).toMatchObject({ id: 'a', done: true, status: 'Inbox', completed_at: NOW_ISO });
    expect(t.items).toEqual([]);
  });

  it('v2 undo stays undone while the checkbox index still says true', () => {
    const rec = row('u', { Status: 'Done', 已完成: true }, true);
    const local = {
      items: [{ id: 'u', title: 'u', due: null, priority: 'P2', done: false, pending: true, prev_status: 'Inbox' }],
      pending_writes: [{ record_id: 'u', status: 'Inbox', completed: false, schema: 'v2' }],
    };
    const t = toTodo([rec], local, none(), none(), new Set(['u']), NOW_ISO, V2);
    expect(t.items[0]).toMatchObject({ id: 'u', done: false, pending: true, prev_status: 'Inbox' });
    expect(t.done_items).toBeUndefined();
    expect(t.pending_writes).toEqual([
      { record_id: 'u', status: 'Inbox', completed: false, schema: 'v2' },
    ]);
  });

  it('historical checkbox-true without a stamp stays out of today', () => {
    const rec = row('old', { Status: 'Done', 已完成: true }, true);
    const t = toTodo([rec], null, none(), none(), none(), NOW_ISO, V2);
    expect(t.items).toEqual([]);
    expect(t.done_items).toBeUndefined();
  });

  it('keeps a previous completed_at when the checkbox is already true', () => {
    const stamp = '2026-10-13T01:00:00.000Z';
    const rec = row('a', { Status: 'Done', 已完成: true }, true);
    const local = {
      done_items: [{ id: 'a', title: 'a', due: null, priority: 'P2', done: true, completed_at: stamp }],
    };
    const t = toTodo([rec], local, none(), none(), none(), NOW_ISO, V2);
    expect(t.done_items?.[0].completed_at).toBe(stamp);
  });
});

describe('today union', () => {
  const day = (hm: string, delta = 0) => {
    const base = Date.parse(`2026-10-13T${hm}:00.000+08:00`) + delta * 86_400_000;
    return new Date(base).getTime();
  };

  function sched(id: string, extra: Record<string, unknown>) {
    return row(id, { Status: 'Inbox', ...extra }, true);
  }

  it('empty plan date + a today interval is scheduled; unscheduled today pick is separate', () => {
    const recs = [
      sched('old-slot', {
        已完成: false,
        'Scheduled Start': day('09:00'),
        'Scheduled End': day('10:00'),
      }),
      sched('pick', { 已完成: false, '计划日期': ms('2026-10-13T00:00:00+08:00') }),
      sched('both', {
        已完成: false,
        '计划日期': '2026/10/13',
        'Scheduled Start': day('11:00'),
        'Scheduled End': day('12:00'),
      }),
      sched('doing-bare', { Status: 'Doing', 已完成: false }),
      sched('done-slot', {
        Status: 'Done',
        已完成: true,
        'Scheduled Start': day('13:00'),
        'Scheduled End': day('14:00'),
      }),
    ];
    const s = toSchedule(recs, NOW, V2);
    expect(s.events.map((e) => e.title)).toEqual(['old-slot', 'both']);
    expect(s.planned.map((p) => p.id)).toEqual(['pick']);
    expect(s.events.every((e) => e.id)).toBe(true);
  });

  it('legacy schedule ignores plan date and still requires Doing + start today', () => {
    const recs = [
      row('slot', {
        Status: 'Doing',
        'Scheduled Start': ms('2026-10-13T01:00:00Z'),
        'Scheduled End': ms('2026-10-13T02:00:00Z'),
      }),
      row('pick', { Status: 'Inbox', '计划日期': ms('2026-10-13T00:00:00+08:00') }, true),
    ];
    const s = toSchedule(recs, NOW);
    expect(s.events.map((e) => e.title)).toEqual(['slot']);
    expect('planned' in s).toBe(false);
  });

  it('covers both midnight crossings and rejects broken intervals', () => {
    const recs = [
      sched('from-yesterday', {
        已完成: false,
        'Scheduled Start': day('23:00', -1),
        'Scheduled End': day('01:00'),
      }),
      sched('into-tomorrow', {
        已完成: false,
        'Scheduled Start': day('23:00'),
        'Scheduled End': day('01:00', 1),
      }),
      sched('tomorrow', {
        已完成: false,
        'Scheduled Start': day('00:30', 1),
        'Scheduled End': day('02:00', 1),
      }),
      sched('reversed', {
        已完成: false,
        '计划日期': '2026-10-13',
        'Scheduled Start': day('15:00'),
        'Scheduled End': day('14:00'),
      }),
      sched('only-start', {
        已完成: false,
        Status: 'Done',
        'Scheduled Start': day('09:00'),
      }),
    ];
    const s = toSchedule(recs, NOW, V2);
    expect(s.events.map((e) => e.title)).toEqual(['from-yesterday', 'into-tomorrow']);
    expect(s.planned.map((p) => p.id)).toEqual(['reversed']);
    expect(intervalOverlapsShanghaiDay(
      '2026-10-12T23:00:00.000+08:00',
      '2026-10-13T01:00:00.000+08:00',
      NOW,
    )).toBe(true);
    expect(intervalOverlapsShanghaiDay(
      '2026-10-13T15:00:00.000+08:00',
      '2026-10-13T14:00:00.000+08:00',
      NOW,
    )).toBe(false);
  });

  it('does not treat a plan-date string as a backfill of Doing', () => {
    const rec = row('d', { Status: 'Doing', 已完成: false }, true);
    expect(rec.planDate).toBeNull();
    expect(toSchedule([rec], NOW, V2).planned).toEqual([]);
    expect(toSchedule([rec], NOW, V2).events).toEqual([]);
  });
});

describe('queue upgrade, retry, toggle', () => {
  it('upgrades a status-only payload without dropping it; Doing is not in-progress', () => {
    const done = upgradePendingWrite({ record_id: 'a', status: 'Done', landed: true, requested_at: 'T' }, true);
    expect(done).toMatchObject({ record_id: 'a', status: 'Done', completed: true, schema: 'v2', upgraded_from: 'status' });
    expect(done.landed).toBeUndefined();
    const doing = upgradePendingWrite({ record_id: 'b', status: 'Doing' }, true);
    expect(doing.completed).toBe(false);
    const inbox = upgradePendingWrite({ record_id: 'c', status: 'Inbox' }, true);
    expect(inbox.completed).toBe(false);
    const kept = upgradePendingWrite({ record_id: 'd', status: 'Done' }, false);
    expect(kept.completed).toBeUndefined();
    const invalid = upgradePendingWrite({ record_id: 'e' }, true);
    expect(invalid).toEqual({ record_id: 'e' });
  });

  it('batch update uses the configured checkbox name, not a field id', () => {
    expect(buildBatchUpdate(
      [
        { record_id: 'a', status: 'Done', completed: true },
        { record_id: 'a', status: 'Inbox', completed: false },
        { record_id: 'b', status: 'Done' },
      ],
      { completedField: '完成了' },
    )).toEqual([
      { record_id: 'a', fields: { Status: 'Inbox', 完成了: false } },
      { record_id: 'b', fields: { Status: 'Done' } },
    ]);
    expect(buildBatchUpdate([{ record_id: 'a', status: 'Done', completed: true }])).toEqual([
      { record_id: 'a', fields: { Status: 'Done' } },
    ]);
  });

  it('requeue keeps a failed uncheck and does not invent Doing', () => {
    const local = {
      items: [{ id: 'a', title: 'a', due: null, priority: 'P2', done: false, pending: true, prev_status: 'Inbox' }],
      pending_writes: [{
        record_id: 'a', status: 'Inbox', completed: false, schema: 'v2',
        requested_at: '2026-10-13T01:00:00.000Z', landed: true,
      }],
    };
    const out = requeueWrites(local, new Set(['a']));
    expect(out).toEqual([{
      record_id: 'a',
      status: 'Inbox',
      completed: false,
      schema: 'v2',
      requested_at: '2026-10-13T01:00:00.000Z',
      landed: true,
    }]);
    const rec = row('a', { Status: 'Done', 已完成: true }, true);
    const t = toTodo([rec], { ...local, pending_writes: out }, none(), new Set(['a']), none(), NOW_ISO, V2);
    expect(t.items[0]).toMatchObject({ done: false, pending: true, sync_failed: true });
    expect(t.pending_writes?.[0]).toMatchObject({ completed: false, status: 'Inbox' });
  });

  it('repeated toggle / undo collapses to one v2 write and keeps completed_at', () => {
    const data = {
      items: [{ id: 'a', title: 'a', status: 'Inbox', done: false, priority: 'P2' }],
      pending_count: 1,
    };
    const ctx = { writeCompleted: true, readMode: 'v2' as const };
    applyTodoToggle(data, 'a', true, '2026-10-13T01:00:00.000Z', ctx);
    applyTodoToggle(data, 'a', false, '2026-10-13T02:00:00.000Z', ctx);
    applyTodoToggle(data, 'a', true, '2026-10-13T03:00:00.000Z', ctx);
    expect(data.pending_writes).toEqual([{
      record_id: 'a',
      status: 'Done',
      completed: true,
      schema: 'v2',
      requested_at: '2026-10-13T03:00:00.000Z',
    }]);
    expect(data.items?.[0]).toMatchObject({
      done: true,
      prev_status: 'Inbox',
      completed_at: '2026-10-13T03:00:00.000Z',
    });
    expect(data.write_audit).toHaveLength(3);
    expect(data.items?.[0].prev_status).not.toBe('Doing');
  });

  it('legacy toggle still falls back to Doing and adds no checkbox key', () => {
    const data = { items: [{ id: 'a', title: 'a' }], pending_count: 1 };
    applyTodoToggle(data, 'a', true, NOW_ISO, { writeCompleted: false, readMode: 'legacy' });
    expect(data.items?.[0].prev_status).toBe('Doing');
    expect(data.pending_writes?.[0]).toEqual({ record_id: 'a', status: 'Done', requested_at: NOW_ISO });
    expect(data.write_audit).toBeUndefined();
    applyTodoToggle(data, 'a', false, NOW_ISO, { writeCompleted: false, readMode: 'legacy' });
    expect(data.pending_writes).toHaveLength(1);
    expect(data.pending_writes?.[0].status).toBe('Doing');
    expect(data.items?.[0].completed_at).toBe(NOW_ISO);
  });

  it('v2 with a missing status restores Inbox, not Doing', () => {
    const data = { items: [{ id: 'a', title: 'a', status: 'Doing' }] };
    applyTodoToggle(data, 'a', true, NOW_ISO, { writeCompleted: true, readMode: 'v2' });
    expect(data.items?.[0].prev_status).toBe('Doing');
    applyTodoToggle(data, 'a', false, NOW_ISO, { writeCompleted: true, readMode: 'v2' });
    expect(data.pending_writes?.[0]).toMatchObject({ status: 'Doing', completed: false });
    const bare = { items: [{ id: 'b', title: 'b' }] };
    applyTodoToggle(bare, 'b', true, NOW_ISO, { writeCompleted: true, readMode: 'v2' });
    expect(bare.items?.[0].prev_status).toBe('Inbox');
  });
});

describe('ICS window and UID', () => {
  it('keeps Done history, record_id UID, and the start window', () => {
    const start = '2026-10-12T01:00:00.000Z';
    const recs = [
      row('recStable', {
        Status: 'Done',
        已完成: true,
        '计划日期': '2026-10-13',
        'Scheduled Start': ms(start),
        'Scheduled End': ms(start) + 3600_000,
      }, true),
      row('only-start', { Status: 'Done', 'Scheduled Start': ms(start) }),
      row('reversed', {
        Status: 'Done',
        'Scheduled Start': ms('2026-10-13T02:00:00Z'),
        'Scheduled End': ms('2026-10-13T01:00:00Z'),
      }),
      row('old-overlap', {
        Status: 'Inbox',
        'Scheduled Start': ms('2026-09-01T01:00:00Z'),
        'Scheduled End': ms('2026-10-13T06:00:00Z'),
      }),
    ];
    const events = toCalendar(recs, NOW).events;
    expect(events.map((e) => e.id)).toEqual(['recStable', 'reversed']);
    const ics = toIcs(events, 'Pulse 日程', NOW);
    const again = toIcs(toCalendar(recs, NOW).events, 'Pulse 日程', NOW);
    expect(ics).toContain('UID:recStable@pulse');
    expect(again).toContain('UID:recStable@pulse');
    expect(ics).not.toContain('UID:reversed@pulse');
    expect(ics).not.toContain('only-start');
    expect(ics).not.toContain('old-overlap');
  });
});

describe('schedule card', () => {
  const ev = {
    title: '时间块',
    start: '2026-10-13T09:00:00.000+08:00',
    end: '2026-10-13T10:00:00.000+08:00',
  };

  it('legacy payload has no unscheduled section', () => {
    const html = schedule.render({ events: [ev] });
    expect(html).toContain('时间块');
    expect(html).not.toContain('未排期');
    expect(html).not.toContain('已排期');
  });

  it('shows timed and unscheduled picks as two groups', () => {
    const html = schedule.render({
      events: [ev],
      planned: [{ id: 'p', title: '只选今天', priority: 'P1', plan_date: '2026-10-13' }],
    });
    expect(html).toContain('已排期');
    expect(html).toContain('今日选中 · 未排期');
    expect(html).toContain('只选今天');
    expect(html.indexOf('时间块')).toBeLessThan(html.indexOf('只选今天'));
  });
});
