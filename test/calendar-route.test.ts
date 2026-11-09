import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/feishu', () => ({
  runFeishuSync: vi.fn(),
  runFeishuSyncAfterPendingWrite: vi.fn(),
}));

import worker from '../src/worker';
import { SESSION_COOKIE, encodeSession, feedToken } from '../src/session';

const CAL_ROW = JSON.stringify({
  events: [
    {
      id: 'recFeed1',
      title: 'Review sprint demo',
      start: '2026-10-14T14:00:00.000+08:00',
      end: '2026-10-14T15:00:00.000+08:00',
      priority: 'P1',
    },
  ],
});
const SCHED_ROW = JSON.stringify({
  events: [
    {
      title: 'Morning standup',
      start: '2026-10-13T09:30:00.000+08:00',
      end: '2026-10-13T09:45:00.000+08:00',
    },
  ],
});

function envWith(rows: Record<string, string>) {
  return {
    AGENT_TOKEN: 'secret',
    DB: {
      prepare: () => ({
        bind: (id: string) => ({
          first: async () => (id in rows ? { data: rows[id] } : null),
        }),
        all: async () => ({
          results: Object.entries(rows).map(([id, data]) => ({
            id,
            title: id,
            data,
            updated_at: '2026-10-13T00:00:00.000Z',
            source: 'test',
          })),
        }),
      }),
    },
    ASSETS: { fetch: async () => new Response('asset') },
  };
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
const get = (env: unknown, url: string, headers?: Record<string, string>) =>
  worker.fetch(new Request(url, { headers }), env as any, ctx() as any);
const cookie = { Cookie: `${SESSION_COOKIE}=${encodeSession('secret')}` };

describe('GET /api/calendar.ics', () => {
  const url = 'https://pulse.test/api/calendar.ics';

  it('401 without any credential', async () => {
    const res = await get(envWith({ calendar: CAL_ROW }), url);
    expect(res.status).toBe(401);
  });

  it('401 with a wrong token or the raw AGENT_TOKEN', async () => {
    const res = await get(envWith({ calendar: CAL_ROW }), `${url}?token=nope`);
    expect(res.status).toBe(401);
    // The subscription credential is a derived feed token, not the admin one —
    // a leaked feed URL must not carry write access.
    const admin = await get(envWith({ calendar: CAL_ROW }), `${url}?token=secret`);
    expect(admin.status).toBe(401);
  });

  it('200 with the derived feed token, emits ICS, no-store', async () => {
    const res = await get(
      envWith({ calendar: CAL_ROW }),
      `${url}?token=${await feedToken('secret')}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('UID:recFeed1@pulse');
    expect(body).toContain('DTSTART:20261014T060000Z');
    expect(body).toContain('SUMMARY:Review sprint demo');
  });

  it('200 with the session cookie', async () => {
    const res = await get(envWith({ calendar: CAL_ROW }), url, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UID:recFeed1@pulse');
  });

  it('prefers calendar over schedule, falls back when absent', async () => {
    const ft = await feedToken('secret');
    let res = await get(envWith({ calendar: CAL_ROW, schedule: SCHED_ROW }), `${url}?token=${ft}`);
    expect(await res.text()).toContain('UID:recFeed1@pulse');

    res = await get(envWith({ schedule: SCHED_ROW }), `${url}?token=${ft}`);
    const body = await res.text();
    expect(body).toContain('SUMMARY:Morning standup');
    expect(body).not.toContain('recFeed1');
  });

  it('no rows still returns a subscribable (empty) calendar', async () => {
    const res = await get(envWith({}), `${url}?token=${await feedToken('secret')}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).not.toContain('BEGIN:VEVENT');
  });
});

describe('GET /api/calendar-link', () => {
  const url = 'https://pulse.test/api/calendar-link';

  it('401 when signed out', async () => {
    const res = await get(envWith({}), url);
    expect(res.status).toBe(401);
  });

  it('returns feed + webcal subscribe URLs carrying the feed token', async () => {
    const res = await get(envWith({}), url, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    const ft = await feedToken('secret');
    expect(body.feed).toBe(`https://pulse.test/api/calendar.ics?token=${ft}`);
    expect(body.subscribe).toBe(`webcal://pulse.test/api/calendar.ics?token=${ft}`);
    expect(body.feed).not.toContain('token=secret');
  });
});

describe('hidden widget rows', () => {
  it('calendar is excluded from GET /api/widgets and 404s on :id', async () => {
    const env = envWith({ calendar: CAL_ROW, schedule: SCHED_ROW });

    const list = await get(env, 'https://pulse.test/api/widgets');
    expect(list.status).toBe(200);
    const widgets = await list.json();
    expect(widgets.map((w: { id: string }) => w.id)).toEqual(['schedule']);

    const single = await get(env, 'https://pulse.test/api/widgets/calendar');
    expect(single.status).toBe(404);
  });
});
