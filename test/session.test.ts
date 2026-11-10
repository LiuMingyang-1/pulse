import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import {
  LOGIN_MAX_ATTEMPTS,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  decodeSession,
  encodeSession,
  resetLoginRateLimitForTests,
  splitTokenQuery,
  tokenMatches,
} from '../src/session';

function ctx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

function emptyDb() {
  const calls = { n: 0 };
  const db = {
    prepare(sql: string) {
      calls.n++;
      const stmt = {
        async first() { return null; },
        async all() { return { results: [] as unknown[] }; },
        // Empty tasks table — UPDATE/DELETE match nothing; widget upserts do.
        async run() { return { meta: { changes: /^(UPDATE|DELETE FROM) tasks/.test(sql) ? 0 : 1 } }; },
        bind() { return stmt; },
      };
      return stmt;
    },
  };
  return { db, calls };
}

function makeEnv(agentToken = 'secret') {
  const { db, calls } = emptyDb();
  return {
    AGENT_TOKEN: agentToken,
    DB: db,
    calls,
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
  };
}

function call(url: string, env: ReturnType<typeof makeEnv>, init?: RequestInit) {
  return worker.fetch(new Request(url, init), env as any, ctx() as any);
}

function setCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

function cookiePair(raw: string): string {
  return raw.split(';')[0] ?? '';
}

function expectSessionCookie(raw: string, token: string) {
  expect(raw.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  expect(raw).toContain('HttpOnly');
  expect(raw).toContain('Secure');
  expect(raw).toContain('SameSite=Lax');
  expect(raw).toContain('Path=/');
  expect(raw).toContain(`Max-Age=${SESSION_MAX_AGE}`);
  expect(raw).not.toMatch(/Domain=/i);
  const value = cookiePair(raw).slice(SESSION_COOKIE.length + 1);
  expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(value).not.toBe(token);
  expect(decodeSession(value)).toBe(token);
}

function login(env: ReturnType<typeof makeEnv>, token: string, ip = '203.0.113.10') {
  return call('https://pulse.test/api/login', env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ token }),
  });
}

beforeEach(() => resetLoginRateLimitForTests());

describe('session cookie helpers', () => {
  it('matches only the real token, including a different length', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('secret', 'secreT')).toBe(false);
    expect(tokenMatches('secret', 'secret-longer')).toBe(false);
    expect(tokenMatches('', 'secret')).toBe(false);
    expect(tokenMatches('secret', '')).toBe(false);
    expect(tokenMatches('Bearer ', undefined)).toBe(false);
  });

  it('round-trips unicode and characters that would break Set-Cookie', () => {
    for (const token of ['secret', '口令🔐', 'a; b=c\r\nHttpOnly']) {
      const encoded = encodeSession(token);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeSession(encoded)).toBe(token);
    }
    expect(decodeSession('@@@')).toBeNull();
    expect(decodeSession('')).toBeNull();
  });

  it('strips token from the redirect path and drops a header-breaking query', () => {
    expect(splitTokenQuery('https://pulse.test/board?b=2&token=secret&a=1')).toEqual({
      token: 'secret',
      location: '/board?b=2&a=1',
    });
    expect(splitTokenQuery('https://pulse.test/?token=a%26b')).toEqual({
      token: 'a&b',
      location: '/',
    });
    expect(splitTokenQuery('https://pulse.test/widgets')).toEqual({
      token: null,
      location: '/widgets',
    });
    const hostile = splitTokenQuery('https://pulse.test/?x=1%0d%0aSet-Cookie:%20pwned&token=secret');
    expect(hostile.token).toBe('secret');
    expect(hostile.location).toBe('/');
    expect(hostile.location).not.toMatch(/[\r\n]/);
  });
});

describe('POST /api/login and /api/logout', () => {
  it('sets an HttpOnly Secure SameSite=Lax cookie for ~30 days and does not echo the token', async () => {
    const token = 'super-secret-token';
    const env = makeEnv(token);
    const res = await login(env, token, '203.0.113.4');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true });
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toContain(token);
    expectSessionCookie(cookies[0]!, token);
  });

  it('401 on a wrong, missing, or non-string token and does not set a cookie', async () => {
    const env = makeEnv();
    for (const body of [{ token: 'nope' }, {}, { token: 1 }, { token: '' }]) {
      const res = await call('https://pulse.test/api/login', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
      expect(setCookies(res)).toHaveLength(0);
    }
  });

  it('400 on invalid or oversized JSON', async () => {
    const env = makeEnv();
    const bad = await call('https://pulse.test/api/login', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.6' },
      body: '{',
    });
    expect(bad.status).toBe(400);

    const huge = await call('https://pulse.test/api/login', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.62' },
      body: `{"token":"${'x'.repeat(9000)}"}`,
    });
    expect(huge.status).toBe(400);
    expect(setCookies(huge)).toHaveLength(0);
  });

  it('rate-limits further attempts, including a correct token, and isolates by IP', async () => {
    const env = makeEnv();
    const ip = '198.51.100.7';
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      const res = await login(env, 'nope', ip);
      expect(res.status).toBe(401);
    }
    const blocked = await login(env, 'secret', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });
    const retry = Number(blocked.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(setCookies(blocked)).toHaveLength(0);

    const other = await login(env, 'secret', '198.51.100.8');
    expect(other.status).toBe(200);
  });

  it('rejects every login when AGENT_TOKEN is empty', async () => {
    const env = makeEnv('');
    const res = await login(env, '', '203.0.113.9');
    expect(res.status).toBe(401);
    expect(setCookies(res)).toHaveLength(0);
    const bearer = await call('https://pulse.test/api/tasks', env, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' },
    });
    expect(bearer.status).toBe(401);
  });

  it('clears the cookie on logout', async () => {
    const env = makeEnv();
    const res = await call('https://pulse.test/api/logout', env, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [cookie] = setCookies(res);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    const session = await call('https://pulse.test/api/session', env, {
      headers: { Cookie: cookiePair(cookie!) },
    });
    expect(await session.json()).toEqual({ authenticated: false });
  });
});

describe('session probe and route policy', () => {
  it('reports anonymous until the cookie or bearer is present', async () => {
    const env = makeEnv();
    const anon = await call('https://pulse.test/api/session', env);
    expect(anon.headers.get('cache-control')).toBe('no-store');
    expect(await anon.json()).toEqual({ authenticated: false });

    const loggedIn = await login(env, 'secret', '203.0.113.20');
    const authed = await call('https://pulse.test/api/session', env, {
      headers: { Cookie: cookiePair(setCookies(loggedIn)[0]!) },
    });
    expect(await authed.json()).toEqual({ authenticated: true });

    const bearer = await call('https://pulse.test/api/session', env, {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(await bearer.json()).toEqual({ authenticated: true });
  });

  it('serves widgets without a session', async () => {
    const env = makeEnv();
    const res = await call('https://pulse.test/api/widgets', env);
    expect(res.status).toBe(200);
    // Empty DB → no blobs, but the three task-derived cards always compute.
    const widgets = await res.json();
    expect(widgets.map((w: { id: string }) => w.id)).toEqual(['todo', 'reminder', 'schedule']);
    expect(env.calls.n).toBe(2); // widgets + tasks reads
  });

  it('accepts cookie or bearer for toggle and tasks, and bearer only for widget push', async () => {
    const env = makeEnv();
    const loggedIn = await login(env, 'secret', '203.0.113.21');
    const cookie = cookiePair(setCookies(loggedIn)[0]!);

    const toggleAnon = await call('https://pulse.test/api/todo/toggle', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'r1', done: true }),
    });
    expect(toggleAnon.status).toBe(401);

    const toggleCookie = await call('https://pulse.test/api/todo/toggle', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: 'r1', done: true }),
    });
    // Auth passed; the empty D1 has no such task.
    expect(toggleCookie.status).toBe(404);

    const toggleBearer = await call('https://pulse.test/api/todo/toggle', env, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Cookie: `${SESSION_COOKIE}=not-the-session`,
      },
      body: JSON.stringify({ id: 'r1', done: true }),
    });
    expect(toggleBearer.status).toBe(404);

    const tasksAnon = await call('https://pulse.test/api/tasks', env);
    expect(tasksAnon.status).toBe(401);

    const tasksCookie = await call('https://pulse.test/api/tasks', env, {
      headers: { Cookie: cookie },
    });
    expect(tasksCookie.status).toBe(200);
    expect(await tasksCookie.json()).toEqual({ tasks: [] });

    const pushCookie = await call('https://pulse.test/api/widgets/stocks', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ data: { total_pnl: 0 } }),
    });
    expect(pushCookie.status).toBe(401);

    const writesBeforeBearer = env.calls.n;
    const pushBearer = await call('https://pulse.test/api/widgets/stocks', env, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Cookie: cookie,
      },
      body: JSON.stringify({ data: { total_pnl: 0 } }),
    });
    expect(pushBearer.status).toBe(200);
    expect(env.calls.n).toBeGreaterThan(writesBeforeBearer);
  });
});

describe('?token= auto login', () => {
  it('sets the cookie and redirects to the same path without the token', async () => {
    const env = makeEnv();
    const res = await call('https://pulse.test/board?b=2&token=secret&a=1', env, {
      headers: { 'CF-Connecting-IP': '203.0.113.30' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const loc = new URL(res.headers.get('location')!, 'https://pulse.test');
    expect(loc.pathname).toBe('/board');
    expect(loc.search).toBe('?b=2&a=1');
    expect(loc.search).not.toContain('token');
    expectSessionCookie(setCookies(res)[0]!, 'secret');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('still strips a wrong token, without setting a cookie', async () => {
    const env = makeEnv();
    const res = await call('https://pulse.test/?token=nope', env, {
      headers: { 'CF-Connecting-IP': '203.0.113.31' },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'https://pulse.test');
    expect(loc.pathname + loc.search).toBe('/');
    expect(setCookies(res)).toHaveLength(0);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('does not turn an API url into a login redirect', async () => {
    const env = makeEnv();
    const res = await call('https://pulse.test/api/health?token=secret', env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(setCookies(res)).toHaveLength(0);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('shares the login rate limit and will not set a cookie once the bucket is full', async () => {
    const env = makeEnv();
    const ip = '203.0.113.32';
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      const res = await call(`https://pulse.test/?token=guess-${i}`, env, {
        headers: { 'CF-Connecting-IP': ip },
      });
      expect(res.status).toBe(302);
      expect(setCookies(res)).toHaveLength(0);
    }
    const res = await call('https://pulse.test/?token=secret', env, {
      headers: { 'CF-Connecting-IP': ip },
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!, 'https://pulse.test').search).not.toContain('token');
    expect(setCookies(res)).toHaveLength(0);
  });

  it('drops a CRLF in other query params instead of reflecting it into Location', async () => {
    const env = makeEnv();
    const res = await call('https://pulse.test/?x=1%0d%0aSet-Cookie:%20pwned&token=secret', env, {
      headers: { 'CF-Connecting-IP': '203.0.113.33' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toMatch(/pwned/);
    expectSessionCookie(cookies[0]!, 'secret');
  });
});
