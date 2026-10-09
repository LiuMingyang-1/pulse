import { Hono } from 'hono';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AGENT_TOKEN: string;
  FINNHUB_API_KEY?: string;
}

interface WidgetRow {
  id: string;
  title: string;
  data: string;
  updated_at: string;
  source: string | null;
}

const ALLOWED_SOURCES = new Set(['cron', 'hermes', 'alma', 'manual', 'agent']);

// ── Stock holdings ─────────────────────────────────────────────────────────
// SAMPLE HOLDINGS — edit these to match your real positions.
// `avg_cost` is your cost basis per share in USD.
const POSITIONS: Array<{ symbol: string; shares: number; avg_cost: number }> = [
  { symbol: 'AAPL', shares: 10, avg_cost: 185.2 },
  { symbol: 'NVDA', shares: 5, avg_cost: 128.5 },
  { symbol: 'VOO', shares: 3, avg_cost: 511.4 },
];

interface StockUpdateResult {
  ok: boolean;
  reason?: string;
  fetched: number;
  failed: string[];
  data?: {
    total_pnl: number;
    currency: 'USD';
    positions: Array<{ symbol: string; shares: number; pnl: number; pct: number }>;
  };
}

// Fetch quotes from Finnhub, compute P&L, upsert the `stocks` widget row.
// Shared by the cron `scheduled` handler and POST /api/cron/run.
// Never throws — callers can fire-and-forget inside ctx.waitUntil.
async function runStockUpdate(env: Env): Promise<StockUpdateResult> {
  const apiKey = env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.log('[stocks] FINNHUB_API_KEY not set — skipping fetch');
    return { ok: false, reason: 'no_api_key', fetched: 0, failed: [] };
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const positions: Array<{
    symbol: string;
    shares: number;
    pnl: number;
    pct: number;
  }> = [];
  const failed: string[] = [];

  for (const pos of POSITIONS) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(pos.symbol)}&token=${apiKey}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const quote = (await res.json()) as { c?: number };
      const current = quote.c;
      if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
        throw new Error('bad quote payload');
      }
      const pnl = (current - pos.avg_cost) * pos.shares;
      const pct = ((current - pos.avg_cost) / pos.avg_cost) * 100;
      positions.push({
        symbol: pos.symbol,
        shares: pos.shares,
        pnl: round2(pnl),
        pct: round2(pct),
      });
    } catch (err) {
      console.error(`[stocks] fetch failed for ${pos.symbol}:`, err);
      failed.push(pos.symbol);
    }
  }

  // Don't clobber good data with an empty write if every fetch failed.
  if (positions.length === 0) {
    console.error('[stocks] all symbol fetches failed — widget not updated');
    return { ok: false, reason: 'all_failed', fetched: 0, failed };
  }

  const data = {
    total_pnl: round2(positions.reduce((sum, p) => sum + p.pnl, 0)),
    currency: 'USD' as const,
    positions,
  };

  await env.DB.prepare(
    `INSERT INTO widgets (id, title, data, updated_at, source)
     VALUES ('stocks', '美股持仓', ?, ?, 'cron')
     ON CONFLICT(id) DO UPDATE SET
       data = excluded.data,
       updated_at = excluded.updated_at,
       source = excluded.source`,
  )
    .bind(JSON.stringify(data), new Date().toISOString())
    .run();

  return { ok: true, fetched: positions.length, failed, data };
}

const app = new Hono<{ Bindings: Env }>();

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
app.post('/api/widgets/:id', async (c) => {
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${c.env.AGENT_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

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

  const row = await c.env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind(id)
    .first<WidgetRow>();
  return c.json(rowToWidget(row!));
});

// POST /api/dev/seed — dev helper: seeds the three built-in widgets with
// empty-state data. Same Bearer auth as the push endpoint. Does NOT overwrite
// rows that already have data (INSERT OR IGNORE per row).
app.post('/api/dev/seed', async (c) => {
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${c.env.AGENT_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const now = new Date().toISOString();
  const seeds: Array<[string, string, string]> = [
    ['schedule', '今日安排', JSON.stringify({ events: [] })],
    ['todo', '飞书待办', JSON.stringify({ pending_count: 0, items: [] })],
    [
      'stocks',
      '美股持仓',
      JSON.stringify({ total_pnl: 0, currency: 'USD', positions: [] }),
    ],
  ];

  const stmts = seeds.map(([id, title, data]) =>
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO widgets (id, title, data, updated_at, source)
       VALUES (?, ?, ?, ?, 'agent')`,
    ).bind(id, title, data, now),
  );
  await c.env.DB.batch(stmts);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM widgets ORDER BY id',
  ).all<WidgetRow>();
  return c.json({ seeded: true, widgets: (results ?? []).map(rowToWidget) });
});

// POST /api/cron/run — manually trigger the stock update (same logic as the
// cron trigger) so it can be tested without waiting for the schedule.
// Same Bearer auth as the widget push endpoint.
app.post('/api/cron/run', async (c) => {
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${c.env.AGENT_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const result = await runStockUpdate(c.env);
  // no_api_key is a config state, not an upstream failure — report 200 with
  // the reason so `curl` testing shows a clean JSON body instead of an error.
  const status = result.ok || result.reason === 'no_api_key' ? 200 : 502;
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
      runStockUpdate(env).catch((err) => {
        // Belt-and-suspenders: runStockUpdate never throws, but a rejected
        // waitUntil promise would surface as a cron failure — never let it.
        console.error('[stocks] unexpected error in scheduled run:', err);
      }),
    );
  },
};
