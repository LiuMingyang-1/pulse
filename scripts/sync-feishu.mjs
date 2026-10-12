#!/usr/bin/env node
// sync-feishu.mjs — pull tasks from Feishu bitable → push to Pulse widget API.
// Run on the agent host (Mac/NAS), not in the Worker. Uses lark-cli for Feishu auth.
//
// Usage:
//   node scripts/sync-feishu.mjs                    # one-shot sync
//   node scripts/sync-feishu.mjs --dry-run          # fetch + transform, don't POST
//   PULSE_URL=https://pulse.<you>.workers.dev PULSE_TOKEN=xxx node scripts/sync-feishu.mjs
//
// Env (in order): process.env → .dev.vars at repo root → defaults.
//   PULSE_URL        (default http://localhost:8787)
//   PULSE_TOKEN      (required unless --dry-run — same as AGENT_TOKEN)
//   PULSE_SOURCE     (optional — the `source` tag on pushed rows; default 'alma')
//   LARK_APP_TOKEN   (required — your bitable "app token", from the base URL)
//   LARK_TABLE_ID    (required — the table id inside that base)
//   LARK_AS          (optional — lark-cli identity: 'user' default, or 'bot')
//
// The todo widget also round-trips user clicks: the browser POSTs a
// `pending_writes` queue into todo.data, and each sync drains it by writing
// Status back to Feishu via `lark-cli base +record-batch-update`.
//
// So on your own machine you can just drop them in .dev.vars once and run
// `node scripts/sync-feishu.mjs` without prefixing env vars every time.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const execFileP = promisify(execFile);

// Load .dev.vars (same file wrangler dev uses) — env vars from the shell
// still take precedence.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const devVarsPath = join(repoRoot, '.dev.vars');
if (existsSync(devVarsPath)) {
  for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const nonempty = (v) => (v && v.trim() !== '' ? v : undefined);
const PULSE_URL = nonempty(process.env.PULSE_URL) ?? 'http://localhost:8787';
const PULSE_TOKEN = nonempty(process.env.PULSE_TOKEN) ?? nonempty(process.env.AGENT_TOKEN);
const SOURCE = nonempty(process.env.PULSE_SOURCE) ?? 'alma';
const APP_TOKEN = nonempty(process.env.LARK_APP_TOKEN);
const TABLE_ID = nonempty(process.env.LARK_TABLE_ID);
// lark-cli identity: 'user' (your OAuth login) or 'bot' (app credentials).
// Default stays 'user' so existing setups keep working; set LARK_AS=bot to switch.
const LARK_AS = nonempty(process.env.LARK_AS) ?? 'user';
const DRY_RUN = process.argv.includes('--dry-run');

if (!APP_TOKEN || !TABLE_ID) {
  console.error('LARK_APP_TOKEN and LARK_TABLE_ID are required.');
  console.error('Both come from your bitable URL:');
  console.error('  https://xxx.feishu.cn/base/<LARK_APP_TOKEN>?table=<LARK_TABLE_ID>&view=...');
  process.exit(1);
}
if (!PULSE_TOKEN && !DRY_RUN) {
  console.error('PULSE_TOKEN required (the AGENT_TOKEN for POST /api/widgets/*)');
  process.exit(1);
}

// ── Fetch records via lark-cli ────────────────────────────────────────────
// lark-cli base +record-list --app-token X --table-id Y --as user --format json
const FIELD_IDS = [
  'Task', 'Due', 'Priority', 'Status', 'Type',
  'Scheduled Start', 'Scheduled End',
];
async function fetchRecords() {
  const { stdout } = await execFileP('lark-cli', [
    'base', '+record-list',
    '--base-token', APP_TOKEN,
    '--table-id', TABLE_ID,
    ...FIELD_IDS.flatMap((f) => ['--field-id', f]),
    '--as', LARK_AS,
    '--format', 'json',
  ], { maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  // lark-cli json format returns matrix rows: {data:{data:[[...],...]}}
  // Field order matches --field-id flags:
  //   [Task, Due, Priority, Status, Type, Scheduled Start, Scheduled End]
  // data.record_id_list aligns with data.data rows by index — zip to get ids.
  const rows = parsed?.data?.data ?? [];
  const ids = parsed?.data?.record_id_list ?? [];
  // lark-cli silently drops --field-id names it doesn't know (no error, just a
  // shorter row) — a swallowed column would shift every positional read after
  // it, so hard-fail here instead of syncing misread data.
  const bad = rows.findIndex((row) => !Array.isArray(row) || row.length !== FIELD_IDS.length);
  if (bad >= 0) {
    const got = Array.isArray(rows[bad]) ? rows[bad].length : 'non-array';
    throw new Error(
      `record-list column count mismatch on row ${bad}: expected ${FIELD_IDS.length} ` +
      `columns (${FIELD_IDS.join(', ')}), got ${got}. An unknown --field-id was ` +
      `probably swallowed silently — check the field names against the bitable.`,
    );
  }
  return rows.map((row, i) => ({ row, record_id: ids[i] }));
}

// ── Drain local todo writes back to Feishu ─────────────────────────────────
// The browser queues {record_id, status} in todo.data.pending_writes; we flush
// them in one batch call so clicks don't wait for a manual Feishu edit.
// Returns Sets of acked / failed record_ids. Never throws — write-back
// failures shouldn't block the main push.
async function drainPendingWrites(writes) {
  const acked = new Set();
  const failed = new Set();
  if (!writes.length) return { acked, failed };
  const update_records = {};
  for (const w of writes) {
    if (w?.record_id && typeof w.status === 'string') {
      update_records[w.record_id] = { Status: [w.status] };
    }
  }
  if (!Object.keys(update_records).length) return { acked, failed };
  if (DRY_RUN) {
    console.log('would batch-update:', JSON.stringify({ update_records }));
    return { acked, failed };
  }
  try {
    // --json takes the {update_records:{rid:{field:value}}} payload per the
    // upstream skills/lark-base docs; `lark-cli base +record-batch-update
    // --help` on the sync host is the final arbiter.
    await execFileP('lark-cli', [
      'base', '+record-batch-update',
      '--base-token', APP_TOKEN,
      '--table-id', TABLE_ID,
      '--as', LARK_AS,
      '--json', JSON.stringify({ update_records }),
      '--format', 'json',
    ], { maxBuffer: 16 * 1024 * 1024 });
    Object.keys(update_records).forEach((rid) => acked.add(rid));
  } catch (err) {
    console.error(`pending_writes batch-update failed (${Object.keys(update_records).length} records):`, err.message ?? err);
    Object.keys(update_records).forEach((rid) => failed.add(rid));
  }
  return { acked, failed };
}

// Read the current todo.data from D1 — carries the browser's pending_writes
// queue plus per-item done/prev_status flags we merge against Feishu truth.
// 404 → the widget row doesn't exist yet (fine, push fresh). Anything else
// (5xx, network, bad JSON) → ok:false so main skips the todo push entirely:
// overwriting the blob blind would flush the pending_writes queue.
async function fetchTodoData() {
  if (!PULSE_TOKEN) return { ok: true, data: null };
  try {
    const res = await fetch(`${PULSE_URL}/api/widgets/todo`, {
      headers: { Authorization: `Bearer ${PULSE_TOKEN}` },
    });
    if (res.status === 404) return { ok: true, data: null };
    if (!res.ok) return { ok: false };
    const w = await res.json();
    return { ok: true, data: w?.data ?? null };
  } catch {
    return { ok: false };
  }
}

// ── Transform bitable rows → widget data shapes ───────────────────────────
// records = [{row: [Task, Due, Priority, Status, Type, SchedStart, SchedEnd],
//             record_id}]
// Type splits rows into two cards: 'Task' → todo, 'Reminder' → reminder.
// Other types (e.g. Reading) aren't shown.
const first = (v) => (Array.isArray(v) ? v[0] : v);

const DONE_LIMIT = 20; // cap the sunken done section — "completed today", not a log

// Does an ISO timestamp fall on today? "Today" = local date on the sync host
// (it runs in the user's timezone). completed_at is always written by us as
// Date#toISOString, so no epoch-ms/localized formats to handle — missing or
// unparseable counts as NOT today so the row drops from done_items.
function isTodayDate(isoString) {
  if (typeof isoString !== 'string' || isoString.trim() === '') return false;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function pending(records, type) {
  return records.filter(({ row }) => first(row[3]) !== 'Done' && first(row[4]) === type);
}

function byPriorityThenDue(a, b) {
  const pa = a.priority?.replace('P', '') ?? '9';
  const pb = b.priority?.replace('P', '') ?? '9';
  if (pa !== pb) return Number(pa) - Number(pb);
  if (!a.due) return 1;
  if (!b.due) return -1;
  return a.due < b.due ? -1 : 1;
}

// todo contract: { pending_count, items: [{id, title, due, priority, status,
//   done?, pending?, prev_status?, sync_failed?, completed_at?}],
//   done_items?: [...], pending_writes? }
// Feishu Status is truth; local flags only bridge the gap until the write lands.
// `now` = this sync run's ISO timestamp — stamped as completed_at when a row
// newly flips to Done (see below).
function toTodo(records, local, acked, failed, now) {
  const localById = new Map();
  for (const list of [local?.items, local?.done_items]) {
    if (Array.isArray(list)) for (const it of list) if (it?.id) localById.set(it.id, it);
  }
  // Rids with a write still in the drained queue (acked or failed this round) —
  // distinct from local flags that may have been superseded by a newer toggle.
  const queuedIds = new Set(
    (Array.isArray(local?.pending_writes) ? local.pending_writes : [])
      .map((w) => w?.record_id)
      .filter(Boolean),
  );

  const items = pending(records, 'Task')
    .map(({ row, record_id: id }) => {
      const prev = localById.get(id);
      const it = {
        id,
        title: row[0] ?? '(untitled)',
        due: row[1] ?? null,
        priority: first(row[2]) ?? 'P2',
        status: first(row[3]), // real Feishu status — undo writes this back
      };
      // Locally-marked done but Feishu still shows it unfinished: only keep the
      // sunken state while its write is actually in flight or just failed —
      // otherwise the queue was superseded (rapid toggles collapse to the
      // latest entry) and Feishu's "not Done" is the truth to render.
      const stillQueued = queuedIds.has(id);
      if (prev?.done && (stillQueued || failed.has(id))) {
        it.done = true;
        if (prev.prev_status) it.prev_status = prev.prev_status;
        it.pending = true;
        if (failed.has(id)) it.sync_failed = true;
      }
      return it;
    })
    .sort(byPriorityThenDue);

  // Feishu-side completions. The bitable has no reliable completion timestamp
  // (last_modified_time isn't a field lark-cli can select here; Created is a
  // bulk-import constant), so we track it ourselves via completed_at:
  //   - prev.completed_at exists          → keep it (already tracked)
  //   - prev existed and wasn't done      → stamp `now` (newly completed —
  //     either drained our own pending write or was checked off in Feishu)
  //   - otherwise (never seen, or legacy Done with no stamp) → leave undefined:
  //     the 60 historical Done rows predate tracking and must NOT all land in
  //     today's section on the first run after this deploys.
  // done_items keeps only stamps that fall on today (isTodayDate). A pending
  // local undo (done:false + queued/failed write) still lifts the row back
  // into items regardless of stamp — an undo never disappears.
  const mergedDone = records
    .filter(({ row }) => first(row[3]) === 'Done' && first(row[4]) === 'Task')
    .map(({ row, record_id: id }) => {
      const prev = localById.get(id);
      const it = {
        id,
        title: row[0] ?? '(untitled)',
        due: row[1] ?? null,
        priority: first(row[2]) ?? 'P2',
        status: 'Done',
        done: true,
      };
      if (prev?.completed_at) {
        it.completed_at = prev.completed_at;
      } else if (prev && prev.done !== true) {
        // prev lived in `items` unfinished (done absent/false — only toggles
        // set done explicitly) and Feishu now says Done: newly completed.
        it.completed_at = now;
      }
      // Keep prev_status so an undo can restore the pre-done Feishu status.
      if (prev?.prev_status) it.prev_status = prev.prev_status;
      if (prev && prev.done === false && (queuedIds.has(id) || failed.has(id))) {
        it.done = false;
        it.pending = true;
        if (failed.has(id)) it.sync_failed = true;
      }
      return it;
    });
  const sunken = mergedDone
    .filter((it) => it.done && isTodayDate(it.completed_at))
    .slice(-DONE_LIMIT);
  items.push(...mergedDone.filter((it) => !it.done));
  items.sort(byPriorityThenDue);

  // Keep only writes this round failed — acked ones are done, and a row that
  // no longer exists in Feishu simply drops out with its queue entry.
  const pending_writes = (Array.isArray(local?.pending_writes) ? local.pending_writes : [])
    .filter((w) => w?.record_id && failed.has(w.record_id));

  return {
    pending_count: items.filter((it) => !it.done).length,
    items,
    ...(sunken.length ? { done_items: sunken } : {}),
    ...(pending_writes.length ? { pending_writes } : {}),
  };
}

// reminder contract: { items: [{title, due}] } — every pending reminder with a
// due date; the card itself narrows to the 3-day window at render time so the
// cutoff stays correct between syncs.
function toReminder(records) {
  const items = pending(records, 'Reminder')
    .filter(({ row }) => row[1])
    .map(({ row }) => ({ title: row[0] ?? '(untitled)', due: row[1] }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  return { items };
}

// schedule contract: { events: [{title, start, end}] } — every record decided
// for today (Status=Doing) AND actually slotted (both Scheduled times present),
// regardless of Type: talks/interviews often aren't Type=Task but still belong
// on today's timeline. Sorting / "now" highlighting happens client-side so the
// card stays correct between 5-min syncs without re-pushing.
function toSchedule(records) {
  const events = records
    .filter(({ row }) => first(row[3]) === 'Doing' && row[5] && row[6])
    .map(({ row }) => ({ title: row[0] ?? '(untitled)', start: row[5], end: row[6] }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  return { events };
}

// ── Push to Pulse ─────────────────────────────────────────────────────────
async function push(id, title, data) {
  const res = await fetch(`${PULSE_URL}/api/widgets/${id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PULSE_TOKEN}`,
    },
    body: JSON.stringify({ title, data, source: SOURCE }), // set PULSE_SOURCE to tag rows with the agent/host running this
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────
try {
  const [records, todoRead] = await Promise.all([fetchRecords(), fetchTodoData()]);
  console.log(`fetched ${records.length} rows from bitable`);
  const localTodo = todoRead.ok ? todoRead.data : null;
  const writes = Array.isArray(localTodo?.pending_writes) ? localTodo.pending_writes : [];
  const { acked, failed } = await drainPendingWrites(writes);
  if (writes.length) console.log(`pending_writes: ${acked.size} acked, ${failed.size} failed`);
  const todo = toTodo(records, localTodo, acked, failed, new Date().toISOString());
  const reminder = toReminder(records);
  const schedule = toSchedule(records);
  console.log(`transformed → ${todo.pending_count} tasks (+${(todo.done_items ?? []).length} done), ${reminder.items.length} reminders, ${schedule.events.length} scheduled`);
  if (DRY_RUN) {
    console.log(JSON.stringify({ todo, reminder, schedule }, null, 2));
  } else {
    // A failed todo read means pending_writes may still hold unsent writes —
    // pushing would overwrite the blob and flush the queue, so skip this card.
    if (todoRead.ok) {
      console.log('pushed todo:', JSON.stringify(await push('todo', '飞书待办', todo)));
    } else {
      console.warn('todo read failed — skipping todo push to preserve pending_writes');
    }
    console.log('pushed reminder:', JSON.stringify(await push('reminder', 'Reminder', reminder)));
    console.log('pushed schedule:', JSON.stringify(await push('schedule', '今日安排', schedule)));
  }
} catch (err) {
  console.error('sync failed:', err.message ?? err);
  process.exit(1);
}
