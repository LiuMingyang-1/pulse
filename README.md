# Pulse

A self-hosted personal dashboard on Cloudflare Workers. Widget cards (iOS-style)
are rendered from a D1 table — a cron syncs a Feishu bitable,
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
(6) npm run deploy,
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
- **Cron**: every 5 min (`*/5 * * * *`) runs the Feishu sync (see below).

## Widget data contract

Each card renders `data` as JSON:

```
schedule.data = { "events": [{ "title": string,
                               "start": ISO8601, "end": ISO8601 }] }
                only today's slotted events; the card sorts/marks live/past
                client-side so it stays correct between syncs
reminder.data = { "items": [{ "title": string, "due": ISO8601 }] }
                card shows the next-3-days window
todo.data     = { "pending_count": number,    // unfinished only
                  "items": [{ "id"?: string,  // Feishu record_id; items without
                                              // one render a static circle
                              "title": string, "due": ISO8601,
                              "priority": "P0"|"P1"|"P2",
                              "status"?: string,    // current Feishu Status
                              "done"?: bool,        // locally checked off
                              "pending"?: bool,     // write-back queued
                              "prev_status"?: string, // restored on undo
                              "completed_at"?: ISO8601, // first observed Done —
                                                    // toggles stamp it, sync
                                                    // carries/stamps it
                              "sync_failed"?: bool }],
                  "done_items"?: [{ same shape }],  // Status=Done in Feishu AND
                                                    // completed today
                                                    // (completed_at stamped on
                                                    // first observation);
                                                    // sunken below the pager
                  "pending_writes"?: [{ "record_id": string,
                                       "status": string,
                                       "requested_at": ISO8601 }] }
                tapping a circle sinks the item into a grayed, struck-through
                done section (tap again to undo); the browser POSTs the whole
                blob and each sync drains `pending_writes` back to Feishu
```

New widgets just need a new row + a renderer entry in `src/widgets/`.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler d1 create pulse-db          # paste database_id into wrangler.toml
npx wrangler d1 migrations apply pulse-db --remote
npx wrangler secret put AGENT_TOKEN      # bearer token for agent pushes — make it random
npm run deploy
```

`AGENT_TOKEN` is the only auth on the write endpoints. Generate a real one:

```sh
openssl rand -hex 32
```

### Auto-deploy on push (GitHub Actions)

`.github/workflows/deploy.yml` runs `astro build` + `wrangler deploy` on every
push to `main` (or manually via Actions → Deploy → Run workflow). Set two repo
secrets under Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — dash.cloudflare.com → My Profile → API Tokens →
  create with the **Edit Cloudflare Workers** template (it includes Workers,
  D1, and cron permissions; scope it to this account)
- `CLOUDFLARE_ACCOUNT_ID` — any Workers/D1 page in the dash shows it in the
  right sidebar, or `wrangler whoami`

The workflow only redeploys the Worker — D1 schema changes still need a manual
`npx wrangler d1 migrations apply pulse-db --remote`, and secrets
(`AGENT_TOKEN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`) stay set via `wrangler secret put` as above.

## Local dev

```sh
cp .dev.vars.example .dev.vars                    # fill in AGENT_TOKEN
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
POST /api/todo/toggle               → flip a todo item {id, done} (auth required)
```

Authed routes take `Authorization: Bearer <AGENT_TOKEN>`.

### Browser writes (todo check-off)

Open the page once with `?token=<AGENT_TOKEN>` — the page stores it in
`localStorage` and strips it from the address bar. After that, tapping a circle
in 飞书待办 calls `POST /api/todo/toggle` (`{ "id", "done" }`, Bearer auth) —
the Worker flips the item and queues a `pending_writes` entry in one
read-modify-write; add the `?token=` URL to your home-screen bookmark. Without
a token the circle still flips locally (with a shake hint) but the change is
gone on refresh.

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

**Recommended: in-Worker cron.** `src/feishu.ts` runs on the Worker's own
`*/5` cron: it gets a `tenant_access_token`
from `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, reads the bitable set in
`wrangler.toml` `[vars]` (`FEISHU_BASE_TOKEN`, `FEISHU_TABLE_ID`), drains
`todo.data.pending_writes` back to Feishu, and writes `todo` / `reminder` /
`schedule` straight into D1 (`source = 'feishu-cron'`). No host needs to stay
awake. Setup (Feishu app permissions + secrets) is in
[docs/LARK_SETUP.md](docs/LARK_SETUP.md#option-a--worker-cron-recommended).

```sh
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
# trigger once without waiting for cron:
curl -X POST -H "Authorization: Bearer $AGENT_TOKEN" https://<worker>/api/feishu/sync
```

Don't run the Worker cron and the external script at the same time.

**Fallback: external script.** `scripts/sync-feishu.mjs` pulls tasks from a Feishu bitable via
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

The script hits lark-cli as `user` by default (your OAuth login). To run as
the app/bot instead — e.g. on a server without a user session — set
`LARK_AS=bot`. It also drains the todo card's `pending_writes` queue each run,
writing `Status` back via `lark-cli base +record-batch-update`, so check-offs
in the browser reach Feishu within one sync cycle.

To run it every 5 min on a Mac, copy
`scripts/com.pulse.sync-feishu.plist.example` to
`~/Library/LaunchAgents/com.pulse.sync-feishu.plist`, fill in your paths and
env vars, then `launchctl load` it.

## iPhone

Open the deployed URL in Safari → Share → 添加到主屏幕. `manifest.webmanifest`,
`sw.js` and icons are already wired up; it launches standalone.

## Cost notes

Everything fits comfortably in free tiers: D1 reads/writes plus cron are well
under quota for a single-user dashboard.
