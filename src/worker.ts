import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { runFeishuSync } from './feishu';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AGENT_TOKEN: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_BASE_TOKEN?: string;
  FEISHU_TABLE_ID?: string;
}

interface WidgetRow {
  id: string;
  title: string;
  data: string;
  updated_at: string;
  source: string | null;
}

const ALLOWED_SOURCES = new Set(['cron', 'hermes', 'alma', 'manual', 'agent', 'feishu-cron']);

const app = new Hono<{ Bindings: Env }>();

// ── Auth ───────────────────────────────────────────────────────────────────

// Constant-time string comparison — pad to the same length and accumulate the
// XOR diff without early return so response timing doesn't leak the token.
// (No node:crypto here: the worker doesn't enable nodejs_compat.)
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt past the end returns NaN, which XORs as 0 — that plus the
    // length seed above keeps the loop running full length on a mismatch.
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Middleware: require `Authorization: Bearer <AGENT_TOKEN>` on agent-facing
// routes. A missing/empty AGENT_TOKEN never matches, so the route 401s.
const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const expected = `Bearer ${c.env.AGENT_TOKEN ?? ''}`;
  if (!safeEqual(auth, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

app.get('/api/health', (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
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
  return c.json((results ?? []).map(rowToWidget));
});

app.get('/api/widgets/:id', async (c) => {
  const id = c.req.param('id');
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
app.post('/api/widgets/:id', requireAuth, async (c) => {
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
interface TodoItem {
  id?: string;
  status?: string;
  done?: boolean;
  pending?: boolean;
  prev_status?: string;
  sync_failed?: boolean;
  completed_at?: string;
  [k: string]: unknown;
}
interface PendingWrite {
  record_id?: string;
  status?: string;
  requested_at?: string;
  [k: string]: unknown;
}

app.post('/api/todo/toggle', requireAuth, async (c) => {
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
    items?: TodoItem[];
    done_items?: TodoItem[];
    pending_writes?: PendingWrite[];
    pending_count?: number;
    [k: string]: unknown;
  };
  try {
    data = JSON.parse(row.data);
  } catch {
    return c.json({ error: 'bad_widget_data' }, 500);
  }

  const items: TodoItem[] = Array.isArray(data.items) ? data.items : [];
  const doneItems: TodoItem[] = Array.isArray(data.done_items) ? data.done_items : [];
  const it = [...items, ...doneItems].find((x) => x.id === body.id);
  if (!it) return c.json({ error: 'item_not_found', id: body.id }, 404);

  const nowDone = body.done;
  it.done = nowDone;
  it.pending = true; // until sync confirms the Feishu write
  delete it.sync_failed;
  // On completion stash the item's real Feishu status so undo restores it —
  // 'Doing' is only the fallback when sync data predates the status field.
  // completed_at is the server-side completion stamp sync uses to keep
  // done_items today-only; it survives undo (history — the item being back
  // in `items` already keeps it out of the sunken section).
  if (nowDone && !it.prev_status) it.prev_status = it.status ?? 'Doing';
  if (nowDone) it.completed_at = new Date().toISOString();

  const writes: PendingWrite[] = Array.isArray(data.pending_writes) ? data.pending_writes : [];
  // A toggle on an already-queued record replaces the queued target — keeps
  // rapid check→undo→check from stacking contradictory writes.
  const queued = writes.findIndex((x) => x?.record_id === body.id);
  const entry: PendingWrite = {
    record_id: body.id,
    // Undo writes prev_status back to Feishu; 'Inbox' only when an item was
    // completed before prev_status existed — rare, so a mild surprise is fine.
    status: nowDone ? 'Done' : (it.prev_status ?? 'Inbox'),
    requested_at: new Date().toISOString(),
  };
  if (queued >= 0) writes.splice(queued, 1, entry);
  else writes.push(entry);
  data.pending_writes = writes;

  // Undo on a Feishu-acked item lives in done_items — lift it back into items.
  if (!nowDone && !items.includes(it)) {
    items.push(it);
    data.done_items = doneItems.filter((x) => x !== it);
  }
  // Done toggles stay in `items` (locally sunken); sync moves them to
  // done_items once Feishu confirms.
  data.items = items;
  data.pending_count = items.filter((x) => !x.done).length;

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE widgets SET data = ?, updated_at = ?, source = 'manual' WHERE id = ?",
  )
    .bind(JSON.stringify(data), now, 'todo')
    .run();

  return c.json({
    id: 'todo',
    title: row.title,
    data,
    updated_at: now,
    source: 'manual',
  });
});

// POST /api/feishu/sync — run the Feishu bitable sync now (same as cron).
app.post('/api/feishu/sync', requireAuth, async (c) => {
  const result = await runFeishuSync(c.env);
  const status = result.ok || result.reason === 'not_configured' ? 200 : 502;
  return c.json(result, status);
});

app.all('/api/*', (c) => {
  return c.json({ error: 'not_found' }, 404);
});

app.all('*', (c) => {
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
