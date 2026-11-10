# Tasks

Tasks live in the D1 `tasks` table — Pulse is the source of truth, there is no
upstream sync. Widgets (`todo` / `reminder` / `schedule` / `calendar`) are
computed from task rows at read time, so a write is visible on the next poll.

## Task model

| Column | Meaning |
|---|---|
| `done` | The checkbox — the single completion authority. |
| `status` | Free-form workflow label (`Inbox` / `Doing` / `Waiting` / `Done` …). Flipping `done` sets it to `Done`; undo restores `Inbox` only from `Done`, so custom labels survive an undo. |
| `due` | ISO 8601 deadline. Independent of scheduling. |
| `priority` | `P0`–`P3` (default `P2`). |
| `type` | `Task`, `Reminder`, or anything else (`Reading`, `Campus`…). Only `Task` items list in the todo card; `Reminder` feeds the reminder card and is excluded from 今日选中. |
| `plan_date` | `YYYY-MM-DD` (Shanghai day). "Picked for that day but no time block" → lands under 今日选中 · 未排期. |
| `scheduled_start` / `scheduled_end` | ISO 8601 interval. A valid interval (`end > start`) overlapping the Shanghai day puts the task on today's timeline and on the ICS feed. |
| `notes` | Free text. Completion reflections append one line each. |
| `completed_at` | Stamped automatically when `done` flips 0→1; kept on undo. Today's completions sink to the todo card's done section. |
| `calendar_event_id`, `project`, `tags`, `created_at`, `updated_at` | Bookkeeping; `tags`/`project` are plain strings — rows migrated from Feishu may hold a JSON-array string in `tags`. |

Day boundaries are always Asia/Shanghai.

## What each widget shows

- **todo** — `type='Task'` rows: `items` = not done (due asc, then priority),
  `done_items` = `done` rows whose `completed_at` falls on today.
- **reminder** — `type='Reminder'`, not done, with a `due`, sorted by due.
- **schedule (今日安排)** — union, not intersection:
  1. `events` — valid Scheduled interval overlapping today, any type, not done;
  2. `planned` — `plan_date` = today **and** no valid interval, not done, not a
     Reminder → 今日选中 · 未排期 (title + priority, no time).
- **calendar (ICS feed)** — any task with a Scheduled interval whose start sits
  in a −3d/+14d window around now, **including done tasks** (history stays).
  `plan_date` and `done` never add/remove feed events.

## HTTP API

Auth: `Authorization: Bearer <AGENT_TOKEN>` (agents) or the browser session
cookie. All bodies are JSON.

```
GET    /api/tasks          → { tasks: [TaskRow, …] }
POST   /api/tasks          → create; 201 + row. { title, type?, status?,
                              done?, due?, priority?, plan_date?,
                              scheduled_start?, scheduled_end?, notes?,
                              project?, tags?, calendar_event_id?,
                              completed_at? }
GET    /api/tasks/:id      → row | 404
PATCH  /api/tasks/:id      → partial update, same fields. done 0→1 stamps
                              completed_at + status Done unless overridden
DELETE /api/tasks/:id      → { ok: true } | 404
POST   /api/todo/toggle    → { id, done, note? } → the recomputed todo widget;
                              `note` appends one line to notes atomically
```

Field rules: `done` accepts `true|false|0|1`; `plan_date` normalizes to a
Shanghai `YYYY-MM-DD`; `due`/`scheduled_*`/`completed_at` must be parseable
instants or `null`; unknown keys are rejected. Task ids: migrated Feishu rows
keep their `rec…` record_id (ICS UIDs `<id>@pulse` stay stable); new tasks get
`t_<uuid>`.

### Examples

```sh
# Create a task planned for today, no time block
curl -X POST https://<worker>/api/tasks \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"写周报","plan_date":"2026-11-10","priority":"P1"}'

# Slot a time block — lands on the timeline + ICS feed
curl -X PATCH https://<worker>/api/tasks/<id> \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"scheduled_start":"2026-11-10T14:00:00+08:00","scheduled_end":"2026-11-10T15:00:00+08:00"}'

# Complete with a reflection note (same call the board makes)
curl -X POST https://<worker>/api/todo/toggle \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<id>","done":true,"note":"写完初稿，明天补图表"}'
```

## Migrating from the Feishu bitable

One-off, after `0003_tasks.sql` is applied:

```sh
node scripts/migrate-feishu-tasks.mjs > tasks-import.sql   # needs lark-cli auth
npx wrangler d1 execute pulse-db --remote --file=tasks-import.sql
```

The script reads the whole table via lark-cli (`FEISHU_BASE_TOKEN` /
`FEISHU_TABLE_ID` env overrides, `LARK_AS=bot` default) and emits INSERTs that
preserve record_ids, Status, Due, priority, plan date, Scheduled times, Notes,
Project, Tags, and Calendar Event ID. `completed_at` is left NULL (the bitable
never had one), so history doesn't flood today's done section.

## Agent skill

Wrap the API in a skill for whichever agent runtime you use. The skill needs
`PULSE_URL` + `AGENT_TOKEN` and maps to: list → `GET /api/tasks`, add → `POST`,
update/slot/plan → `PATCH`, done → `PATCH {done:true}` (or the toggle route
when a reflection note applies), remove → `DELETE`.
