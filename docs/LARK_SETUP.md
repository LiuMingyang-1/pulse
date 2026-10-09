# Feishu / Lark bitable setup for Pulse

The `todo`, `reminder`, and `schedule` widgets are fed by `scripts/sync-feishu.mjs`,
which reads a Feishu bitable (多维表格) and pushes the data to your Pulse worker.
This doc walks through getting that bitable into a usable state.

It is written to be followable by a coding agent — if you're setting this up by
hand, the same steps apply, just run the commands yourself.

## Step 0 — install + auth lark-cli

`sync-feishu.mjs` shells out to `lark-cli` for Feishu auth. Get it from
<https://github.com/jeking2/lark-cli> and follow its README for install + auth.
At minimum you need:

```sh
lark-cli auth status
# should show you logged in as a user (not just a bot)
```

If `lark-cli` is not installed, install it before continuing.

## Step 1 — create the bitable

You need a bitable with a table that has these fields (names are exact, the
script matches on them):

| Field name        | Type     | Notes                                        |
|-------------------|----------|----------------------------------------------|
| `Task`            | text     | primary field — the item title               |
| `Status`          | select   | options: `Inbox`, `Doing`, `Done` (single)   |
| `Type`            | select   | options: `Task`, `Reminder` (single)         |
| `Priority`        | select   | options: `P0`, `P1`, `P2` (single)           |
| `Due`             | datetime | deadline for tasks / reminders               |
| `Scheduled Start` | datetime | start time for today's schedule entries      |
| `Scheduled End`   | datetime | end time for today's schedule entries        |

One-shot create with lark-cli:

```sh
lark-cli base +base-create --name "Pulse Tasks" --table-name "Tasks" \
  --fields '[
    {"name":"Task","type":"text"},
    {"name":"Status","type":"select","multiple":false,"options":[{"name":"Inbox"},{"name":"Doing"},{"name":"Done"}]},
    {"name":"Type","type":"select","multiple":false,"options":[{"name":"Task"},{"name":"Reminder"}]},
    {"name":"Priority","type":"select","multiple":false,"options":[{"name":"P0"},{"name":"P1"},{"name":"P2"}]},
    {"name":"Due","type":"datetime"},
    {"name":"Scheduled Start","type":"datetime"},
    {"name":"Scheduled End","type":"datetime"}
  ]' --as user
```

The command returns a `base_token` and the `table_id` of the first table.
Save them — you'll use both as env vars.

If you'd rather reuse an existing base, find them with:

```sh
lark-cli base +table-list --base-token <base_token> --as user
lark-cli base +field-list --base-token <base_token> --table-id <table_id> --as user
```

and make sure the field names match the table above (`+field-create` /
`+field-update` for any that are missing).

## Step 2 — sanity check the sync script

The script just calls `lark-cli base +record-list` under the hood. Try it
manually first:

```sh
lark-cli base +record-list \
  --base-token <LARK_APP_TOKEN> --table-id <LARK_TABLE_ID> \
  --field-id Task --field-id Due --field-id Priority --field-id Status \
  --field-id Type --field-id "Scheduled Start" --field-id "Scheduled End" \
  --as user --format json
```

If that prints rows, you're good. Now dry-run the sync script (fetches +
transforms but doesn't POST):

```sh
LARK_APP_TOKEN=<base_token> LARK_TABLE_ID=<table_id> \
  node scripts/sync-feishu.mjs --dry-run
```

You should see `transformed → N tasks, M reminders, K scheduled` plus a JSON
dump of what would be pushed.

## Step 3 — push for real

```sh
LARK_APP_TOKEN=<base_token> LARK_TABLE_ID=<table_id> \
PULSE_URL=https://<your-worker>.workers.dev PULSE_TOKEN=<AGENT_TOKEN> \
node scripts/sync-feishu.mjs
```

`PULSE_TOKEN` is the `AGENT_TOKEN` secret you set with `wrangler secret put`.

## Step 4 — keep it running (macOS)

To run the sync every 5 min on a Mac, install the included launchd job:

```sh
cp scripts/com.pulse.sync-feishu.plist.example \
   ~/Library/LaunchAgents/com.pulse.sync-feishu.plist
```

Edit the copied plist:

- `/PATH/TO/node` → output of `which node`
- `/PATH/TO/pulse/scripts/sync-feishu.mjs` → absolute path to the script
- `PULSE_URL`, `PULSE_TOKEN`, `LARK_APP_TOKEN`, `LARK_TABLE_ID` → real values

Then:

```sh
launchctl load ~/Library/LaunchAgents/com.pulse.sync-feishu.plist
tail -f /tmp/pulse-sync-feishu.log
```

## How the fields map to widgets

- **`Type=Task`, `Status≠Done`** → `todo` widget (`pending_count` + items)
- **`Type=Reminder`, `Status≠Done`, has `Due`** → `reminder` widget (card
  filters to next 3 days client-side)
- **`Type=Task`, `Status=Doing`, both `Scheduled Start` and `Scheduled End`
  set** → `schedule` widget (today's slotted events)

So in everyday use: new items go in as `Inbox`, you promote to `Doing` and fill
in the Scheduled times to put them on today's schedule, and `Done` hides them.
