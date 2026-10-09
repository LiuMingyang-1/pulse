# Pulse

A self-hosted personal dashboard on Cloudflare Workers. Widget cards (iOS-style)
are rendered from a D1 table — a cron pulls public data like US stock quotes,
and agents (Hermes on NAS, Alma on Mac, anything that can POST) push private
data like Lark todos to a token-authed API. View it in any browser, or "添加到
主屏幕" on iPhone for a full-screen PWA.

---

## 🤖 Set it up with an agent (recommended)

Don't want to read the whole thing? Copy this into Claude Code / Codex / Cursor /
any coding agent and let it drive:

```
I want to self-host Pulse — a personal dashboard on Cloudflare Workers with
widget cards fed by a D1 database and agent pushes. Clone the repo, then walk
me through setup end to end, asking for each secret/config value when you need
it: (1) npm install, (2) wrangler login, (3) create a D1 database named
pulse-db and paste its database_id into wrangler.toml, (4) apply the
migration, (5) have me generate a random AGENT_TOKEN and set it as a secret,
optionally set FINNHUB_API_KEY for the stocks widget, (6) npm run deploy,
(7) verify the API works — GET /api/health, GET /api/widgets, and one real
POST /api/widgets/:id round-trip (local seeding uses seed.example.sql), (8)
help me add it to my iPhone home screen as a PWA. Read README.md first for
the full picture — your job is to get me from zero to a live worker URL.

Optional follow-up: if I want the Feishu/Lark todo widget wired up too, read
docs/LARK_SETUP.md — it covers creating the bitable with the right fields,
installing lark-cli, and running scripts/sync-feishu.mjs on a schedule.
```

The agent will pause whenever it needs something only you can provide (Cloudflare
login, secret values, whether you want the optional bits). Everything it needs
to know is in this README.

(The same text lives in `SETUP_PROMPT.txt` for easy copying.)

---

## Architecture

- **Frontend**: Astro static build (`src/pages/index.astro` + Tailwind) served
  via Workers Static Assets (`[assets]` in `wrangler.toml`). The page polls
  `/api/widgets` every 60s and renders card bodies client-side.
- **API**: Hono app in `src/worker.ts` mounted on `/api/*`; everything else
  falls through to `ASSETS`.
- **Storage**: one D1 table `widgets` (`migrations/0001_widgets.sql`) — a row
  per widget holding its latest `data` JSON blob.
- **Cron**: every 5 min (`*/5 * * * *`) fetches Finnhub quotes for the
  `POSITIONS` list, computes P&L, upserts the `stocks` row.

## Widget data contract

Each card renders `data` as JSON:

```
schedule.data = { "events": [{ "title": string,
                               "start": ISO8601, "end": ISO8601 }] }
                only today's slotted events; the card sorts/marks live/past
                client-side so it stays correct between syncs
reminder.data = { "items": [{ "title": string, "due": ISO8601 }] }
                card shows the next-3-days window
todo.data     = { "pending_count": number,
                  "items": [{ "title": string, "due": ISO8601,
                              "priority": "P0"|"P1"|"P2" }] }
stocks.data   = { "total_pnl": number (USD, signed), "currency": "USD",
                  "positions": [{ "symbol": string, "shares": number,
                                  "pnl": number, "pct": number }] }
```

New widgets just need a new row + a renderer entry in `src/widgets/`.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler d1 create pulse-db          # paste database_id into wrangler.toml
npx wrangler d1 migrations apply pulse-db --remote
npx wrangler secret put AGENT_TOKEN      # bearer token for agent pushes — make it random
npx wrangler secret put FINNHUB_API_KEY  # free key at finnhub.io (optional, stocks widget)
npm run deploy
```

`AGENT_TOKEN` is the only auth on the write endpoints. Generate a real one:

```sh
openssl rand -hex 32
```

## Local dev

```sh
cp .dev.vars.example .dev.vars                    # fill in AGENT_TOKEN + FINNHUB_API_KEY
npx wrangler d1 migrations apply pulse-db --local
npx wrangler d1 execute pulse-db --local --file=./seed.example.sql
npm run dev:worker                                # astro build + wrangler dev
```

## API

```
GET  /api/health                    → { ok, ts }
GET  /api/widgets                   → [widget, ...]
GET  /api/widgets/:id               → widget | 404
POST /api/widgets/:id               → upsert (auth required)
POST /api/cron/run                  → run the stock fetch now (auth required)
```

Authed routes take `Authorization: Bearer <AGENT_TOKEN>`.

POST body: `{ "data": <any JSON>, "title"?: string, "source"?: string }` —
`data` is required; `title` falls back to the existing row's title; `source`
is a free-form tag like `"cron"`, `"hermes"`, `"alma"`, `"manual"`.

### Agent push example

```sh
curl -X POST https://<your-worker>.workers.dev/api/widgets/todo \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "my-agent",
    "data": {
      "pending_count": 2,
      "items": [
        { "title": "Write the API design doc", "due": "2026-10-10T18:00:00+08:00", "priority": "P1" },
        { "title": "Reply to design review", "due": "2026-10-09T18:00:00+08:00", "priority": "P2" }
      ]
    }
  }'
```

## Feishu / Lark sync (optional)

`scripts/sync-feishu.mjs` pulls tasks from a Feishu bitable via
[lark-cli](https://github.com/jeking2/lark-cli) and pushes the `todo`,
`reminder`, and `schedule` widgets. Run it on whatever host has your Feishu
credentials (your Mac, a NAS — anywhere), not in the Worker.

```sh
# one-shot, dry run (no POST):
LARK_APP_TOKEN=xxx LARK_TABLE_ID=yyy node scripts/sync-feishu.mjs --dry-run

# real sync:
LARK_APP_TOKEN=xxx LARK_TABLE_ID=yyy \
PULSE_URL=https://<your-worker>.workers.dev PULSE_TOKEN=<AGENT_TOKEN> \
node scripts/sync-feishu.mjs
```

Both IDs come from the bitable URL:
`https://xxx.feishu.cn/base/<LARK_APP_TOKEN>?table=<LARK_TABLE_ID>&view=...`

To run it every 5 min on a Mac, copy
`scripts/com.pulse.sync-feishu.plist.example` to
`~/Library/LaunchAgents/com.pulse.sync-feishu.plist`, fill in your paths and
env vars, then `launchctl load` it.

## Editing stock holdings

`POSITIONS` at the top of `src/worker.ts` — symbol, shares, avg cost per share
in USD. Edit and redeploy.

## iPhone

Open the deployed URL in Safari → Share → 添加到主屏幕. `manifest.webmanifest`,
`sw.js` and icons are already wired up; it launches standalone.

## Cost notes

Everything fits comfortably in free tiers: Finnhub's 60 calls/min limit is fine
for a handful of symbols every 5 min, and D1 reads/writes plus cron are well
under quota for a single-user dashboard.
