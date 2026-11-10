# Pulse

A self-hosted personal dashboard on Cloudflare Workers. Widget cards (iOS-style)
are rendered from D1 — tasks live in a `tasks` table that agents manage through
an authenticated CRUD API, and other agents (Hermes on NAS, Alma on Mac,
anything that can POST) push private data like stock positions to a
token-authed widget API. View it in any browser, or "添加到主屏幕" on iPhone
for a full-screen PWA.

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
migrations, (5) have me generate a random AGENT_TOKEN and set it as a secret,
(6) npm run deploy,
(7) verify the API works — GET /api/health, GET /api/widgets, one real
POST /api/widgets/:id round-trip, and a POST /api/tasks create (local seeding
uses seed.example.sql), (8)
help me add it to my iPhone home screen as a PWA. Read README.md first for
the full picture — your job is to get me from zero to a live worker URL.
Task management semantics are in docs/TASKS.md.
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
- **Storage**: two D1 tables — `tasks` (`migrations/0003_tasks.sql`) is the
  source of truth for todos/reminders/schedule/calendar (managed via
  `/api/tasks`, computed into widget payloads at read time), and `widgets`
  (`migrations/0001_widgets.sql`) holds pushed JSON blobs for agent-fed cards
  like stocks/courses.

## Widget data contract

Each card renders `data` as JSON. Two kinds of widgets:

- **task widgets** (`todo` / `reminder` / `schedule` / `calendar`) are computed
  from the `tasks` table on every read — never stored, never stale. Write
  tasks through `POST /api/tasks` / `PATCH /api/tasks/:id`; pushing these ids
  to `/api/widgets/:id` returns `400 managed_by_tasks`.
- **blob widgets** (`stocks`, `courses`, anything new) are rows pushed by
  agents to `POST /api/widgets/:id`.

```
schedule.data = { "events": [{ "id": string, "title": string,
                               "start": ISO8601, "end": ISO8601 }],
                  "planned": [{ "id": string, "title": string,
                                "priority": string, "plan_date": "YYYY-MM-DD" }] }
                union — timed intervals overlapping today (including across
                midnight) plus plan_date=today rows with no valid interval
                (今日选中 · 未排期). Done tasks drop off the card.
calendar.data = { "events": [{ "id": string,    // task id → stable ICS UID
                              "title": string,
                              "start": ISO8601, "end": ISO8601 }] }
                server-internal feed — any task with a Scheduled interval
                whose start is in a 3-days-back / 14-ahead window, done or
                not (history stays). UID is <id>@pulse. plan_date and done
                never add/remove feed events. Served by /api/calendar.ics.
courses.data  = { "events": [{ "id"?: string,   // upstream UID (xjtu-gmis / xjtu_calendar)
                              "title": string,
                              "start": ISO8601, "end": ISO8601,
                              "location"?: string, "description"?: string }] }
                second hidden feed row — the XJTU timetable push from
                scripts/sync-courses.mjs (whole semester + exams); merged
                into the same /api/calendar.ics subscription
reminder.data = { "items": [{ "title": string, "due": ISO8601 }] }
                type=Reminder tasks, not done, sorted by due
todo.data     = { "pending_count": number,      // unfinished Task rows
                  "items": [{ "id": string,       // task id (rec…/t_…)
                              "title": string, "due": ISO8601,
                              "priority": "P0"|"P1"|"P2"|"P3",
                              "status"?: string,       // workflow label
                              "plan_date"?: string }],
                  "done_items"?: [{ same shape + "done": true,
                                    "completed_at": ISO8601 }] }
                tapping a circle POSTs {id, done, note?} to /api/todo/toggle —
                one UPDATE, response is the recomputed widget. Checking off
                opens a skippable "记一笔？" prompt; the note appends one line
                to the task's notes atomically.
```

New widgets just need a new row + a renderer entry in `src/widgets/`.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler d1 create pulse-db          # paste database_id into wrangler.toml
npx wrangler d1 migrations apply pulse-db --remote
npx wrangler secret put AGENT_TOKEN      # agent bearer + browser login secret — make it random
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
(`AGENT_TOKEN`) stay set via `wrangler secret put` as above.

## Local dev

```sh
cp .dev.vars.example .dev.vars                    # fill in AGENT_TOKEN
npx wrangler d1 migrations apply pulse-db --local
npx wrangler d1 execute pulse-db --local --file=./seed.example.sql
npm run dev:worker                                # astro build + wrangler dev
```

## API

```
GET    /api/health                  → { ok, ts }
GET    /api/widgets                 → [widget, ...]          (no login)
GET    /api/widgets/:id             → widget | 404           (no login)
GET    /api/session                 → { authenticated }
POST   /api/login                   → { ok: true } + session cookie; body { token }
POST   /api/logout                  → clears the session cookie
POST   /api/widgets/:id             → upsert a blob widget (Bearer only)
GET    /api/tasks                   → { tasks: [TaskRow, ...] } (cookie or Bearer)
POST   /api/tasks                   → create a task (cookie or Bearer)
GET    /api/tasks/:id               → one task (cookie or Bearer)
PATCH  /api/tasks/:id               → partial update (cookie or Bearer)
DELETE /api/tasks/:id               → remove (cookie or Bearer)
POST   /api/todo/toggle             → flip a task {id, done, note?} (cookie or Bearer)
GET    /api/calendar.ics            → text/calendar feed (cookie, Bearer, or ?token=<feed credential>)
GET    /api/calendar-link           → { feed, subscribe } URLs (cookie or Bearer)
```

`POST /api/widgets/:id` takes `Authorization: Bearer <AGENT_TOKEN>` only, so a
browser session cannot push widget blobs — and task widget ids are rejected
there anyway (`managed_by_tasks`); tasks go through `/api/tasks`.

`/api/tasks*` and `POST /api/todo/toggle` take that same Bearer
header or the session cookie. `POST /api/login` compares the JSON `token`
to `AGENT_TOKEN` and nothing else. On a match it sets
`pulse_session` (`HttpOnly`; `Secure`; `SameSite=Lax`; `Path=/`; about 30
days). `POST /api/logout` clears it. Login attempts are limited to 5 per
minute per client IP, per isolate. The dashboard reads (`GET /api/widgets`)
stay open without a session.

### Browser writes (sign in, check-off)

The board is readable without signing in. Checking off a todo requires a
session.

Click **登录**, enter `AGENT_TOKEN`, and the top bar switches to the avatar and
**退出**. The cookie is HttpOnly, so page scripts never see the secret. A
desktop shortcut or home-screen icon only needs the site URL — sign in once
in that window. Do not put the token in the shortcut.

A link that still has `?token=<AGENT_TOKEN>` signs you in (same cookie) and
the token is removed from the address bar. A token left in `localStorage`
(`pulse_token`) from older builds is exchanged for the cookie once, then
deleted.

After that, tapping a circle in 待办 calls `POST /api/todo/toggle`
(`{ "id", "done", "note"? }`, cookie session) — one D1 UPDATE, and the
response is the recomputed todo widget, so the board reflects the write
immediately. Checking off opens a skippable prompt ("记一笔？"): Enter
submits the text as `note`, appended as a new line to the task's `notes` in
the same UPDATE. Esc / backdrop / 跳过 completes with no note. Undo never
prompts. Without a session the circle still flips locally (with a shake
hint) but the change is gone on refresh.
The refresh button just reloads widgets — every read is already live, there
is nothing to sync. The page polls every 60s.

The cookie is `Secure`. Browsers store it on `localhost` and on HTTPS. A
non-localhost `http://` dev host will not keep the session — use the deployed
URL or localhost.

POST body: `{ "data": <any JSON>, "title"?: string, "source"?: string }` —
`data` is required; `title` falls back to the existing row's title; `source`
is a free-form tag like `"cron"`, `"hermes"`, `"alma"`, `"manual"`.

### Agent push example (blob widget)

```sh
curl -X POST https://<your-worker>.workers.dev/api/widgets/stocks \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "my-agent",
    "data": {
      "total_pnl": 1243.87,
      "currency": "USD",
      "positions": [{ "symbol": "AAPL", "shares": 10, "pnl": 482.30, "pct": 21.4 }]
    }
  }'
```

## Tasks (agent-managed, D1-backed)

Tasks are first-class D1 rows, not pushed blobs — the todo, reminder, today
schedule, and ICS feed all compute from `tasks` at read time. Agents create
and update them through `POST`/`PATCH`/`DELETE /api/tasks`; the browser's
check-off hits `POST /api/todo/toggle` (optional completion `note` appends to
the task's notes in the same write). Full field semantics, per-widget rules,
API details, and Feishu import instructions: **[docs/TASKS.md](docs/TASKS.md)**.

```sh
curl -X POST https://<your-worker>.workers.dev/api/tasks \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Write the API design doc","due":"2026-10-10T18:00:00+08:00","priority":"P1"}'
```

## iPhone and desktop shortcuts

Open the deployed URL in Safari → Share → 添加到主屏幕. Then open the icon and
tap **登录** once. The home-screen app does not share Safari's cookies, and
the shortcut URL should be the plain site — no `?token=`. `manifest.webmanifest`,
`sw.js` and icons are already wired up; it launches standalone.

A desktop shortcut is the same: point it at the site, open it, and sign in.
The session lasts about 30 days. You do not need the token in the URL.

### Subscribe to the calendar feed

While signed in, the top bar shows a calendar button; tapping it opens iOS
Calendar's subscribe sheet via `webcal://<worker>/api/calendar.ics?token=…`
(iOS fetches without cookies, so the credential lives in the URL — it is a
feed-only token derived from `AGENT_TOKEN` by SHA-256, not the admin token
itself; a leaked link reads the feed but grants no API write access).
iOS then re-pulls the feed on its own schedule — 设置 → 日历 → 账户 →
获取新数据 picks hourly/daily/manual — and updates events in place by UID.
The feed computes from the `tasks` table: slotted `scheduled_start`/
`scheduled_end` blocks whose start sits 3 days back / 14 ahead, done or not
(history stays). A second hidden row, `courses`, is merged into the same
feed when present (XJTU timetable, see below). If `AGENT_TOKEN` rotates,
the derived credential rotates too and the old feed URL 401s; subscribe
again.

## XJTU timetable (optional)

Adds your 西安交通大学 timetable into the same `/api/calendar.ics`
subscription — classroom in `LOCATION`, teacher/week info in `DESCRIPTION`.
Two sources, picked by `XJTU_MODE` (`auto`/`ehall`/`gmis`, default `auto` =
ehall when `uvx` is on PATH else gmis):

- **研究生 / graduate → `gmis`** (`scripts/xjtu-gmis.py`, stdlib-only):
  GMIS `pyxx/pygl/xskbcx` page → parse → expand. This is the mode you want if
  eHall CAS greets you with `Required Access Policy not matched` — the eHall
  「我的课表」app is undergraduate-only and refuses graduate NetIDs.
- **本科 / undergrad → `ehall`**: eHall「我的课表」via
  [xjtu-timetable-calendar](https://github.com/XLJFZ/xjtu-timetable-calendar),
  which also covers exams.

Both expand teaching-weeks→dates and the winter/summer schedule switch using
the same config dir `~/.xjtu-timetable-calendar/` (`semesters/<key>.json` +
`schedules/schedule.json`), so configure once regardless of mode.

### Graduate (GMIS) setup

One-time, in a foreground terminal:

```sh
# browser pops up at GMIS OAuth — finish SSO/MFA yourself; state is saved
# under ~/.xjtu-gmis/session/
uv run --with playwright python scripts/xjtu-gmis.py login
# school calendar + class-period schedule (shared with the ehall tool —
# if you already configured it there, skip):
$EDITOR ~/.xjtu-timetable-calendar/semesters/2026-fall.json
$EDITOR ~/.xjtu-timetable-calendar/schedules/schedule.json
python3 scripts/xjtu-gmis.py doctor --semester 2026-fall   # exit 0 = ready
python3 scripts/xjtu-gmis.py pull   --semester 2026-fall   # optional: preview events JSON
```

Then push into the feed:

```sh
PULSE_URL=https://<your-worker>.workers.dev PULSE_TOKEN=<AGENT_TOKEN> \
XJTU_MODE=gmis node scripts/sync-courses.mjs
```

`--no-fetch` re-pushes from the last cached GMIS snapshot; `--dry-run` prints
events without POSTing. Session expiry → re-run the `login` line. The daily
launchd job (below) works for both modes — set `XJTU_MODE=gmis` in its
EnvironmentVariables for a graduate account.

### Undergrad (eHall) setup

With uv nothing gets installed — `uvx` runs the tool in a cached ephemeral
env (first run resolves it, later runs are instant):

```sh
alias xjtu-calendar='uvx --from "xjtu-timetable-calendar[http,browser]" xjtu-calendar'
xjtu-calendar login            # browser pops up — finish SSO yourself
$EDITOR ~/.xjtu-timetable-calendar/semesters/2026-fall.json   # first_week_monday etc.
mkdir -p ~/.xjtu-timetable-calendar/schedules
# copy the tool's schedule.example.json (real XJTU 作息, incl. 10-01 winter
# switch) — or `xjtu-calendar schedule --url <官方作息页> --apply`
xjtu-calendar doctor --semester 2026-fall   # exit 0 = ready

PULSE_URL=https://<your-worker>.workers.dev PULSE_TOKEN=<AGENT_TOKEN> \
node scripts/sync-courses.mjs           # fetch + export + push
node scripts/sync-courses.mjs --no-fetch   # re-push from the cached snapshot
node scripts/sync-courses.mjs --dry-run    # print events, no POST
```

(No uv? `pip install "xjtu-timetable-calendar[http,browser]"` and set
`XJTU_CMD='python3 -m xjtu_calendar'` for the sync script.)

When the saved eHall session expires (fetch exits 3), the script still pushes
the last cached snapshot and logs a reminder — re-run
`xjtu-calendar login --force` to refresh it.

### Shared notes

The semester key defaults to `<year>-fall` (Aug–Jan) / `<year>-spring`
(Feb–Jul); override with `XJTU_SEMESTER` to match the filename under
`semesters/`. Events carry stable UIDs, so 调课 changes update in place on the
next iOS fetch. To run it daily, copy
`scripts/com.pulse.sync-courses.plist.example` to `~/Library/LaunchAgents/`
and `launchctl load` it.

## Cost notes

Everything fits comfortably in free tiers: D1 reads/writes are well under
quota for a single-user dashboard.
