import { describe, expect, it } from 'vitest';

import worker from '../src/worker';
import { SESSION_COOKIE, encodeSession, feedToken } from '../src/session';
import { fakeDb, makeTask, type FakeWidgetRow } from './fake-db';
import type { TaskRow } from '../src/tasks';

const DAY = 24 * 3600 * 1000;
// ICS feed events come from tasks.scheduled_* inside a window around now
// (past 3d / future 14d) — build dates relative to test-run time.
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
// '2026-10-14T06:00:00.000Z' → '20261014T060000Z'
const icsStamp = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const FEED_TASK: TaskRow = makeTask({
  id: 'recFeed1',
  title: 'Review sprint demo',
  priority: 'P1',
  scheduled_start: iso(DAY),
  scheduled_end: iso(DAY + 3600 * 1000),
});

function envWith(init: { tasks?: TaskRow[]; widgets?: FakeWidgetRow[] }) {
  const { db, tasks, widgets } = fakeDb(init);
  return {
    env: {
      AGENT_TOKEN: 'secret',
      DB: db,
      ASSETS: { fetch: async () => new Response('asset') },
    },
    tasks,
    widgets,
  };
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
const get = (env: unknown, url: string, headers?: Record<string, string>) =>
  worker.fetch(new Request(url, { headers }), env as any, ctx() as any);
const cookie = { Cookie: `${SESSION_COOKIE}=${encodeSession('secret')}` };

describe('GET /api/calendar.ics', () => {
  const url = 'https://pulse.test/api/calendar.ics';

  it('401 without any credential', async () => {
    const { env } = envWith({ tasks: [FEED_TASK] });
    const res = await get(env, url);
    expect(res.status).toBe(401);
  });

  it('401 with a wrong token or the raw AGENT_TOKEN', async () => {
    const { env } = envWith({ tasks: [FEED_TASK] });
    const res = await get(env, `${url}?token=nope`);
    expect(res.status).toBe(401);
    // The subscription credential is a derived feed token, not the admin one —
    // a leaked feed URL must not carry write access.
    const admin = await get(env, `${url}?token=secret`);
    expect(admin.status).toBe(401);
  });

  it('200 with the derived feed token, emits ICS, no-store', async () => {
    const { env } = envWith({ tasks: [FEED_TASK] });
    const res = await get(env, `${url}?token=${await feedToken('secret')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('UID:recFeed1@pulse');
    expect(body).toContain(`DTSTART:${icsStamp(FEED_TASK.scheduled_start!)}`);
    expect(body).toContain('SUMMARY:Review sprint demo');
  });

  it('200 with the session cookie', async () => {
    const { env } = envWith({ tasks: [FEED_TASK] });
    const res = await get(env, url, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UID:recFeed1@pulse');
  });

  it('feeds from tasks.scheduled_*, ignoring any stale schedule blob', async () => {
    const { env } = envWith({
      tasks: [FEED_TASK],
      widgets: [
        {
          id: 'schedule',
          title: '今日安排',
          data: JSON.stringify({
            events: [{ title: 'Ghost event', start: iso(DAY), end: iso(DAY + 1000) }],
          }),
          updated_at: iso(0),
          source: 'test',
        },
      ],
    });
    const res = await get(env, `${url}?token=${await feedToken('secret')}`);
    const body = await res.text();
    expect(body).toContain('SUMMARY:Review sprint demo');
    expect(body).not.toContain('Ghost event');
  });

  it('done tasks keep their time blocks on the feed (history)', async () => {
    const { env } = envWith({
      tasks: [makeTask({ ...FEED_TASK, done: 1, status: 'Done', completed_at: iso(0) })],
    });
    const res = await get(env, `${url}?token=${await feedToken('secret')}`);
    expect(await res.text()).toContain('UID:recFeed1@pulse');
  });

  it('merges the courses row into the same feed', async () => {
    const { env } = envWith({
      tasks: [FEED_TASK],
      widgets: [
        {
          id: 'courses',
          title: '课程',
          data: JSON.stringify({
            events: [
              {
                id: 'abc123@xjtu',
                title: '信号与系统',
                start: iso(DAY),
                end: iso(DAY + 6600000),
                location: '创新港校区 A-1001',
              },
            ],
          }),
          updated_at: iso(0),
          source: 'test',
        },
      ],
    });
    const res = await get(env, `${url}?token=${await feedToken('secret')}`);
    const body = await res.text();
    expect(body).toContain('UID:recFeed1@pulse');
    expect(body).toContain('UID:abc123@xjtu@pulse');
    expect(body).toContain('SUMMARY:信号与系统');
    expect(body).toContain('LOCATION:创新港校区 A-1001');
  });

  it('serves the courses feed even without task events', async () => {
    const { env } = envWith({
      widgets: [
        {
          id: 'courses',
          title: '课程',
          data: JSON.stringify({
            events: [{ title: '课', start: iso(DAY), end: iso(DAY + 3600000) }],
          }),
          updated_at: iso(0),
          source: 'test',
        },
      ],
    });
    const res = await get(env, `${url}?token=${await feedToken('secret')}`);
    expect(await res.text()).toContain('SUMMARY:课');
  });

  it('no rows still returns a subscribable (empty) calendar', async () => {
    const { env } = envWith({});
    const res = await get(env, `${url}?token=${await feedToken('secret')}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('BEGIN:VEVENT');
  });
});

describe('GET /api/calendar-link', () => {
  const url = 'https://pulse.test/api/calendar-link';

  it('401 when signed out', async () => {
    const { env } = envWith({});
    const res = await get(env, url);
    expect(res.status).toBe(401);
  });

  it('returns feed + webcal subscribe URLs carrying the feed token', async () => {
    const { env } = envWith({});
    const res = await get(env, url, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    const ft = await feedToken('secret');
    expect(body.feed).toBe(`https://pulse.test/api/calendar.ics?token=${ft}`);
    expect(body.subscribe).toBe(`webcal://pulse.test/api/calendar.ics?token=${ft}`);
    expect(body.feed).not.toContain('token=secret');
  });
});

describe('task-derived and hidden widget rows', () => {
  it('todo/reminder/schedule compute live; calendar/courses stay hidden', async () => {
    const { env } = envWith({
      tasks: [FEED_TASK],
      widgets: [
        {
          id: 'courses',
          title: '课程',
          data: '{"events":[]}',
          updated_at: iso(0),
          source: 'test',
        },
      ],
    });

    const list = await get(env, 'https://pulse.test/api/widgets');
    expect(list.status).toBe(200);
    const widgets = await list.json();
    expect(widgets.map((w: { id: string }) => w.id)).toEqual(['todo', 'reminder', 'schedule']);

    for (const id of ['calendar', 'courses']) {
      const single = await get(env, `https://pulse.test/api/widgets/${id}`);
      expect(single.status).toBe(404);
    }

    const schedule = await get(env, 'https://pulse.test/api/widgets/schedule');
    expect(schedule.status).toBe(200);
    const body = await schedule.json();
    // FEED_TASK slots tomorrow — today's card stays empty but computes fine.
    expect(body).toMatchObject({ id: 'schedule', source: 'tasks' });
    expect(body.data).toEqual({ events: [], planned: [] });
  });
});
