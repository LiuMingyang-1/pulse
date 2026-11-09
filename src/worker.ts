import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { runFeishuSync, runFeishuSyncAfterPendingWrite } from './feishu';
import { toIcs, type IcsEvent } from './ics';
import { parseTasksGate, tasksReadMode } from './tasks-schema';
import { applyTodoToggle, type ToggleData } from './todo-toggle';
import {
  bearerMatches,
  checkLoginRateLimit,
  clearedSessionCookie,
  clientIp,
  feedToken,
  loginBodyTooLarge,
  sessionCookie,
  splitTokenQuery,
  tokenMatches,
  userMatches,
} from './session';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AGENT_TOKEN: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_BASE_TOKEN?: string;
  FEISHU_TABLE_ID?: string;
  /** Unset keeps legacy Status behavior. See docs/TASKS_V2.md. */
  TASKS_SCHEMA?: string;
  FEISHU_FIELD_COMPLETED?: string;
  FEISHU_FIELD_PLAN_DATE?: string;
}

interface WidgetRow {
  id: string;
  title: string;
  data: string;
  updated_at: string;
  source: string | null;
}

const ALLOWED_SOURCES = new Set(['cron', 'hermes', 'alma', 'manual', 'agent', 'feishu-cron']);

// Server-internal rows: never exposed by the anonymous widget reads — the
// `calendar` feed row would otherwise widen the public surface from today's
// schedule to a multi-day window. /api/calendar.ics reads D1 directly.
const HIDDEN_WIDGETS = new Set(['calendar']);

const app = new Hono<{ Bindings: Env }>();

// ── Auth ───────────────────────────────────────────────────────────────────

// Bearer only — agent pushes. A missing/empty AGENT_TOKEN never matches.
const requireBearer: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!bearerMatches(c.req.header('Authorization'), c.env.AGENT_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

// Cookie session or Bearer. Used by the browser (todo toggle, manual sync).
const requireUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!userMatches(c.req.header('Authorization'), c.req.header('Cookie'), c.env.AGENT_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

function noStore(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'no-store');
}

app.get('/api/health', (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

// GET /api/session — whether this browser's cookie (or a Bearer header) is the
// current AGENT_TOKEN. The cookie is HttpOnly, so the page cannot read it.
app.get('/api/session', (c) => {
  noStore(c);
  const authenticated = userMatches(
    c.req.header('Authorization'),
    c.req.header('Cookie'),
    c.env.AGENT_TOKEN,
  );
  return c.json({ authenticated });
});

// POST /api/login — body { token }. Sets the session cookie on a match.
// Compared only to AGENT_TOKEN. Short per-IP rate limit (see session.ts).
app.post('/api/login', async (c) => {
  noStore(c);
  const limit = checkLoginRateLimit(clientIp(c.req.header('CF-Connecting-IP')));
  if (!limit.ok) {
    c.header('Retry-After', String(limit.retryAfter));
    return c.json({ error: 'rate_limited' }, 429);
  }

  let token = '';
  try {
    const text = await c.req.text();
    if (loginBodyTooLarge(text)) return c.json({ error: 'invalid_json' }, 400);
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object' && 'token' in body && typeof body.token === 'string') {
      token = body.token;
    }
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!tokenMatches(token, c.env.AGENT_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.header('Set-Cookie', sessionCookie(c.env.AGENT_TOKEN));
  return c.json({ ok: true });
});

// POST /api/logout — clear the session cookie. Idempotent.
app.post('/api/logout', (c) => {
  noStore(c);
  c.header('Set-Cookie', clearedSessionCookie());
  return c.json({ ok: true });
});

// Parse the stored `data` JSON column into a real object before sending.
function rowToWidget(row: WidgetRow) {
  let data: unknown = null;
  try {
    data = JSON.parse(row.data);
  } catch {
    data = null;
  }
  return {
    id: row.id,
    title: row.title,
    data,
    updated_at: row.updated_at,
    source: row.source,
  };
}

// GET /api/widgets -> JSON array of all widgets (ordered by id).
app.get('/api/widgets', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM widgets ORDER BY id',
  ).all<WidgetRow>();
  return c.json(
    (results ?? []).filter((r) => !HIDDEN_WIDGETS.has(r.id)).map(rowToWidget),
  );
});

app.get('/api/widgets/:id', async (c) => {
  const id = c.req.param('id');
  if (HIDDEN_WIDGETS.has(id)) {
    return c.json({ error: 'not_found', id }, 404);
  }
  const row = await c.env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind(id)
    .first<WidgetRow>();
  if (!row) {
    return c.json({ error: 'not_found', id }, 404);
  }
  return c.json(rowToWidget(row));
});

// POST /api/widgets/:id — agent push. Requires `Authorization: Bearer <AGENT_TOKEN>`.
// Body: { title?: string, data: any, source?: 'cron'|'hermes'|'alma'|'manual'|'agent' }
// Upserts the row; title falls back to existing row's title, then to :id.
app.post('/api/widgets/:id', requireBearer, async (c) => {
  const id = c.req.param('id');

  let body: { title?: unknown; data?: unknown; source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (body === null || typeof body !== 'object' || body.data === undefined) {
    return c.json({ error: 'missing_field', field: 'data' }, 400);
  }

  const source =
    typeof body.source === 'string' && ALLOWED_SOURCES.has(body.source)
      ? body.source
      : 'agent';

  const existing = await c.env.DB.prepare(
    'SELECT title FROM widgets WHERE id = ?',
  )
    .bind(id)
    .first<{ title: string }>();

  const title =
    typeof body.title === 'string' && body.title.length > 0
      ? body.title
      : (existing?.title ?? id);

  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO widgets (id, title, data, updated_at, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       data = excluded.data,
       updated_at = excluded.updated_at,
       source = excluded.source`,
  )
    .bind(id, title, JSON.stringify(body.data), now, source)
    .run();

  // Same shape as rowToWidget — the DB holds nothing we didn't just write.
  return c.json({ id, title, data: body.data, updated_at: now, source });
});

// POST /api/todo/toggle — flip one item's done state inside the Worker so the
// read-modify-write happens in a single invocation (the old GET→flip→POST-blob
// flow raced with the sync's own push and with rapid clicks).
// Body: { "id": "<record_id>", "done": true|false }. Returns the updated widget.
app.post('/api/todo/toggle', requireUser, async (c) => {
  let body: { id?: unknown; done?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.id !== 'string' || typeof body.done !== 'boolean') {
    return c.json({ error: 'missing_field', field: 'id|done' }, 400);
  }

  const row = await c.env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind('todo')
    .first<WidgetRow>();
  if (!row) return c.json({ error: 'not_found', id: 'todo' }, 404);

  let data: {
    items?: unknown;
    done_items?: unknown;
    pending_writes?: unknown;
    pending_count?: number;
    tasks_schema?: { capability?: unknown };
    write_audit?: unknown;
    [k: string]: unknown;
  };
  try {
    data = JSON.parse(row.data);
  } catch {
    return c.json({ error: 'bad_widget_data' }, 500);
  }

  const gate = parseTasksGate(c.env.TASKS_SCHEMA);
  const capability = data.tasks_schema?.capability === 'v2' ? 'v2' as const : 'unknown' as const;
  const applied = applyTodoToggle(data as ToggleData, body.id, body.done, new Date().toISOString(), {
    writeCompleted: (gate === 'compat' || gate === 'v2') && capability === 'v2',
    readMode: tasksReadMode(gate, capability),
  });
  if (!applied.ok) return c.json({ error: applied.error, id: body.id }, 404);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE widgets SET data = ?, updated_at = ?, source = 'manual' WHERE id = ?",
  )
    .bind(JSON.stringify(data), now, 'todo')
    .run();

  // Push the queued write to Feishu right away instead of waiting for the
  // hourly cron — the response can't await it or the click feels frozen.
  // A busy slot or the short cooldown waits (bounded) and tries once more
  // so the new pending write is not stuck until the next hour.
  c.executionCtx.waitUntil(
    runFeishuSyncAfterPendingWrite(c.env).catch((err) => {
      console.error('[feishu] toggle-triggered sync failed:', err?.message ?? err);
    }),
  );

  return c.json({
    id: 'todo',
    title: row.title,
    data,
    updated_at: now,
    source: 'manual',
  });
});

// Parse a widget row's data blob, tolerating missing rows and bad JSON.
async function widgetData(env: Env, id: string): Promise<unknown> {
  const row = await env.DB.prepare('SELECT data FROM widgets WHERE id = ?')
    .bind(id)
    .first<{ data: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

// GET /api/calendar.ics — iCalendar feed of the hidden `calendar` widget
// (falling back to `schedule`). iOS Calendar fetches cookieless on its own
// refresh cycle, so the subscription URL carries ?token=<feed credential> —
// derived from AGENT_TOKEN (see session.ts feedToken), it reads the feed and
// nothing else. A signed-in browser session or Bearer works too.
app.get('/api/calendar.ics', async (c) => {
  const authed =
    userMatches(c.req.header('Authorization'), c.req.header('Cookie'), c.env.AGENT_TOKEN) ||
    tokenMatches(c.req.query('token') ?? '', await feedToken(c.env.AGENT_TOKEN));
  if (!authed) return c.json({ error: 'unauthorized' }, 401);

  const data = (await widgetData(c.env, 'calendar')) ?? (await widgetData(c.env, 'schedule'));
  const events = (data as { events?: IcsEvent[] } | null)?.events;
  return new Response(toIcs(Array.isArray(events) ? events : []), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="pulse.ics"',
      'Cache-Control': 'no-store',
    },
  });
});

// GET /api/calendar-link — the feed-credential URL for this deployment,
// handed only to a signed-in session (the HttpOnly cookie hides it from page
// JS). `subscribe` swaps to webcal:// so tapping it opens iOS Calendar's
// subscribe sheet.
app.get('/api/calendar-link', requireUser, async (c) => {
  noStore(c);
  const base = new URL(c.req.url);
  const feed =
    `${base.protocol}//${base.host}/api/calendar.ics` +
    `?token=${encodeURIComponent((await feedToken(c.env.AGENT_TOKEN)) ?? '')}`;
  return c.json({ feed, subscribe: feed.replace(/^https:/, 'webcal:') });
});

// POST /api/feishu/sync — run the Feishu bitable sync now (same as cron).
app.post('/api/feishu/sync', requireUser, async (c) => {
  const result = await runFeishuSync(c.env);
  const status = result.ok || result.reason === 'not_configured' ? 200 : 502;
  return c.json(result, status);
});

app.all('/api/*', (c) => {
  return c.json({ error: 'not_found' }, 404);
});

app.all('*', (c) => {
  // ?token=<AGENT_TOKEN> signs the browser in (same cookie as POST /api/login)
  // and bounces to the URL with that param removed. Wrong tokens still drop
  // the param so the secret does not stay in the address bar. API routes are
  // matched above and are not redirected.
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const { token, location } = splitTokenQuery(c.req.url);
    if (token !== null) {
      const headers = new Headers({
        Location: location,
        'Cache-Control': 'no-store',
      });
      const limit = checkLoginRateLimit(clientIp(c.req.header('CF-Connecting-IP')));
      if (limit.ok && c.env.AGENT_TOKEN && tokenMatches(token, c.env.AGENT_TOKEN)) {
        headers.append('Set-Cookie', sessionCookie(c.env.AGENT_TOKEN));
      }
      return new Response(null, { status: 302, headers });
    }
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runFeishuSync(env).catch((err) => {
        console.error('[feishu] unexpected error in scheduled run:', err?.message ?? err);
      }),
    );
  },
};
