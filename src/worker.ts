import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { toIcs, type IcsEvent } from './ics';
import {
  TASK_WIDGET_IDS,
  boardTaskWidgets,
  calendarWidget,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  parseTaskPatch,
  todoWidget,
  toggleTask,
  updateTask,
} from './tasks';
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
}

interface WidgetRow {
  id: string;
  title: string;
  data: string;
  updated_at: string;
  source: string | null;
}

const ALLOWED_SOURCES = new Set(['cron', 'hermes', 'alma', 'manual', 'agent', 'feishu-cron', 'xjtu-cron']);

// Server-internal rows: never exposed by the anonymous widget reads — the
// `calendar` feed row would otherwise widen the public surface from today's
// schedule to a multi-day window; `courses` holds the whole semester.
// /api/calendar.ics reads D1 directly.
const HIDDEN_WIDGETS = new Set(['calendar', 'courses']);

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

// GET /api/widgets -> JSON array: stored widget blobs plus the task-derived
// cards computed live from the tasks table (todo / reminder / schedule).
// Task widgets are never stored — nothing can go stale.
app.get('/api/widgets', async (c) => {
  const [{ results }, taskWidgets] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM widgets ORDER BY id').all<WidgetRow>(),
    boardTaskWidgets(c.env.DB),
  ]);
  const taskIds = new Set(taskWidgets.map((w) => w.id));
  const blobs = (results ?? [])
    .filter((r) => !HIDDEN_WIDGETS.has(r.id) && !taskIds.has(r.id))
    .map(rowToWidget);
  return c.json([...blobs, ...taskWidgets]);
});

app.get('/api/widgets/:id', async (c) => {
  const id = c.req.param('id');
  if (HIDDEN_WIDGETS.has(id)) {
    return c.json({ error: 'not_found', id }, 404);
  }
  if (TASK_WIDGET_IDS.has(id)) {
    const w = (await boardTaskWidgets(c.env.DB)).find((x) => x.id === id);
    return w ? c.json(w) : c.json({ error: 'not_found', id }, 404);
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
  // Task-derived widgets are computed from the tasks table — push /api/tasks.
  if (TASK_WIDGET_IDS.has(id)) {
    return c.json({ error: 'managed_by_tasks', id }, 400);
  }

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

// POST /api/todo/toggle — flip one task's done state. A non-empty `note`
// appends to the task's notes in the same UPDATE, so the reflection can't be
// split from the completion. Returns the recomputed todo widget.
// Body: { "id": "<task_id>", "done": true|false, "note"?: string }.
app.post('/api/todo/toggle', requireUser, async (c) => {
  let body: { id?: unknown; done?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.id !== 'string' || typeof body.done !== 'boolean') {
    return c.json({ error: 'missing_field', field: 'id|done' }, 400);
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
  const now = new Date();
  const applied = await toggleTask(c.env.DB, body.id, body.done, note || null, now.toISOString());
  if (!applied.ok) return c.json({ error: applied.error, id: body.id }, 404);
  return c.json(await todoWidget(c.env.DB, now));
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

// GET /api/calendar.ics — iCalendar feed computed from the tasks table.
// iOS Calendar fetches cookieless on its own refresh cycle, so the
// subscription URL carries ?token=<feed credential> — derived from
// AGENT_TOKEN (see session.ts feedToken), it reads the feed and nothing else.
// A signed-in browser session or Bearer works too.
app.get('/api/calendar.ics', async (c) => {
  const authed =
    userMatches(c.req.header('Authorization'), c.req.header('Cookie'), c.env.AGENT_TOKEN) ||
    tokenMatches(c.req.query('token') ?? '', await feedToken(c.env.AGENT_TOKEN));
  if (!authed) return c.json({ error: 'unauthorized' }, 401);

  const [{ data: calData }, courseData] = await Promise.all([
    calendarWidget(c.env.DB),
    widgetData(c.env, 'courses'),
  ]);
  const events = (calData as { events?: IcsEvent[] }).events;
  // The `courses` row (XJTU timetable push) merges into the same feed — one
  // subscription URL covers both task time blocks and class meetings.
  const courseEvents = (courseData as { events?: IcsEvent[] } | null)?.events;
  const merged = [
    ...(Array.isArray(events) ? events : []),
    ...(Array.isArray(courseEvents) ? courseEvents : []),
  ];
  return new Response(toIcs(merged), {
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

// ── Tasks API (agent writes + board reads) ────────────────────────────────
// GET    /api/tasks        → all task rows
// POST   /api/tasks        → create { title, type?, status?, done?, due?,
//                              priority?, plan_date?, scheduled_*?, notes?,
//                              project?, tags?, calendar_event_id? }
// GET    /api/tasks/:id    → one row
// PATCH  /api/tasks/:id    → partial update (same fields; done 0→1 stamps
//                            completed_at and lifts status to Done)
// DELETE /api/tasks/:id    → remove
app.get('/api/tasks', requireUser, async (c) => {
  return c.json({ tasks: await listTasks(c.env.DB) });
});

app.post('/api/tasks', requireUser, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { patch, error } = parseTaskPatch(body, false);
  if (error) return c.json({ error }, 400);
  const row = await createTask(c.env.DB, patch, new Date().toISOString());
  return c.json(row, 201);
});

app.get('/api/tasks/:id', requireUser, async (c) => {
  const row = await getTask(c.env.DB, c.req.param('id'));
  return row ? c.json(row) : c.json({ error: 'item_not_found' }, 404);
});

app.patch('/api/tasks/:id', requireUser, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { patch, error } = parseTaskPatch(body, true);
  if (error) return c.json({ error }, 400);
  const r = await updateTask(c.env.DB, c.req.param('id'), patch, new Date().toISOString());
  return r.ok ? c.json(r.row) : c.json({ error: r.error }, 404);
});

app.delete('/api/tasks/:id', requireUser, async (c) => {
  const ok = await deleteTask(c.env.DB, c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'item_not_found' }, 404);
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

export default { fetch: app.fetch };
