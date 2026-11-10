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
- **Cron**: hourly at minute 0 (`0 * * * *`, UTC) runs the Feishu sync (see below).

## Widget data contract

Each card renders `data` as JSON:

```
schedule.data = { "events": [{ "title": string,
                               "start": ISO8601, "end": ISO8601,
                               "id"?: string }],
                  "planned"?: [{ "id": string, "title": string,
                                 "priority": string, "plan_date": "YYYY-MM-DD" }],
                  "schema"?: "v2" }
                legacy (default): events are Status=Doing with both Scheduled
                times and Scheduled Start today. After TASKS_SCHEMA=v2 the
                card is a union — timed intervals that overlap today (including
                across midnight) plus 计划日期=today with no valid interval.
                `planned` is absent on legacy payloads; old clients ignore it.
calendar.data = { "events": [{ "id"?: string,   // Feishu record_id → stable ICS UID
                              "title": string,
                              "start": ISO8601, "end": ISO8601 }] }
                server-internal feed row — excluded from /api/widgets reads
                and never rendered; any record with both Scheduled times whose
                start is in a 3-days-back / 14-ahead window, any Status
                (Done keeps its times). UID is record_id@pulse.
                Plan date and the completion checkbox do not change this feed.
                Served by /api/calendar.ics. No Apple or Feishu calendar write.
courses.data  = { "events": [{ "id"?: string,   // upstream UID (xjtu-gmis / xjtu_calendar)
                              "title": string,
                              "start": ISO8601, "end": ISO8601,
                              "location"?: string, "description"?: string }] }
                second hidden feed row — the XJTU timetable push from
                scripts/sync-courses.mjs (whole semester + exams); merged
                into the same /api/calendar.ics subscription
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
                  "done_items"?: [{ same shape }],  // completed today. Legacy:
                                                    // Status=Done. v2: checkbox
                                                    // true, Status is not OR'd in
                  "pending_writes"?: [{ "record_id": string,
                                       "status": string,       // always, so rollback can drain
                                       "completed"?: bool,    // checkbox target; absent on old entries
                                       "schema"?: "v2",
                                       "requested_at": ISO8601 }],
                  "tasks_schema"?: { "gate", "read", "capability",
                                     "completed_field", "plan_date_field" },
                  "write_audit"?: [{ "at", "record_id", "done", "status", "completed" }] }
                Default gate is legacy: no new fields, Status is still authority.
                Cutover, dual-write, and rollback: docs/TASKS_V2.md
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
GET  /api/widgets                   → [widget, ...]          (no login)
GET  /api/widgets/:id               → widget | 404           (no login)
GET  /api/session                   → { authenticated }
POST /api/login                     → { ok: true } + session cookie; body { token }
POST /api/logout                    → clears the session cookie
POST /api/widgets/:id               → upsert (Bearer only)
POST /api/todo/toggle               → flip a todo item {id, done} (cookie or Bearer)
POST /api/feishu/sync               → run the Feishu sync now (cookie or Bearer)
GET  /api/calendar.ics              → text/calendar feed (cookie, Bearer, or ?token=<feed credential>)
GET  /api/calendar-link             → { feed, subscribe } URLs (cookie or Bearer)
```

`POST /api/widgets/:id` takes `Authorization: Bearer <AGENT_TOKEN>` only, so a
browser session cannot push widget blobs.

`POST /api/todo/toggle` and `POST /api/feishu/sync` take that same Bearer
header or the session cookie. `POST /api/login` compares the JSON `token`
to `AGENT_TOKEN` and nothing else. On a match it sets
`pulse_session` (`HttpOnly`; `Secure`; `SameSite=Lax`; `Path=/`; about 30
days). `POST /api/logout` clears it. Login attempts are limited to 5 per
minute per client IP, per isolate. The dashboard reads (`GET /api/widgets`)
stay open without a session.

### Browser writes (sign in, check-off, immediate sync)

The board is readable without signing in. Checking off a todo and the refresh
button's immediate Feishu sync require a session.

Click **登录**, enter `AGENT_TOKEN`, and the top bar switches to the avatar and
**退出**. The cookie is HttpOnly, so page scripts never see the secret. A
desktop shortcut or home-screen icon only needs the site URL — sign in once
in that window. Do not put the token in the shortcut.

A link that still has `?token=<AGENT_TOKEN>` signs you in (same cookie) and
the token is removed from the address bar. A token left in `localStorage`
(`pulse_token`) from older builds is exchanged for the cookie once, then
deleted.

After that, tapping a circle in 飞书待办 calls `POST /api/todo/toggle`
(`{ "id", "done" }`, cookie session) — the Worker flips the item and queues a
`pending_writes` entry in one read-modify-write. Without a session the circle
still flips locally (with a shake hint) but the change is gone on refresh.
The refresh button, when signed in, POSTs `/api/feishu/sync` and then reloads
widgets. Repeat clicks inside 15 seconds skip the Feishu call. Signed out,
the button only reloads widgets. The page's 60s poll never triggers a sync.

The cookie is `Secure`. Browsers store it on `localhost` and on HTTPS. A
non-localhost `http://` dev host will not keep the session — use the deployed
URL or localhost.

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

**Recommended: in-Worker cron.** `src/feishu.ts` runs on the Worker's hourly
cron (`0 * * * *`, UTC): it gets a `tenant_access_token`
from `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, reads the bitable set in
`wrangler.toml` `[vars]` (`FEISHU_BASE_TOKEN`, `FEISHU_TABLE_ID`), drains
`todo.data.pending_writes` back to Feishu, and writes `todo` / `reminder` /
`schedule` / `calendar` straight into D1 (`source = 'feishu-cron'`). No host needs to stay
awake. Setup (Feishu app permissions + secrets) is in
[docs/LARK_SETUP.md](docs/LARK_SETUP.md#option-a--worker-cron-recommended).

```sh
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
# trigger once without waiting for cron:
curl -X POST -H "Authorization: Bearer $AGENT_TOKEN" https://<worker>/api/feishu/sync
```

A sync that overlaps another run, or lands inside the 15s cooldown, returns
`200` `{ "ok": true, "skipped": true, "reason": "in_progress" | "recently_synced" }`
and does not call Feishu again. `not_configured` stays
`200` `{ "ok": false, "reason": "not_configured" }`. The guard row lives in
`migrations/0002_feishu_sync_guard.sql` — apply it with the other D1 migrations
(`npx wrangler d1 migrations apply pulse-db --remote`). Until that migration
is applied, syncs are still serialized inside one isolate.

Don't run the Worker cron and the external script at the same time.

**Fallback: external script.** `scripts/sync-feishu.mjs` pulls tasks from a Feishu bitable via
[lark-cli](https://github.com/jeking2/lark-cli) and pushes the `todo`,
`reminder`, `schedule`, and `calendar` widgets. Run it on whatever host has your Feishu
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
The feed mirrors the slotted `Scheduled Start`/`Scheduled End` blocks (3 days
back, 14 ahead) written by the Feishu sync into the `calendar` row — a
server-internal row excluded from `/api/widgets` reads, so the wider window
is not anonymously readable. A second hidden row, `courses`, is merged into
the same feed when present (XJTU timetable, see below). No separate calendar
write or Feishu-calendar sync is needed. If `AGENT_TOKEN` rotates, the
derived credential rotates too and the old feed URL 401s; subscribe again.

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
`scripts/com.pulse.sync-courses.plist.example` like the Feishu plist above.

## Cost notes

Everything fits comfortably in free tiers: D1 reads/writes plus cron are well
under quota for a single-user dashboard.
