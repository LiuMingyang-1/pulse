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
async function fetchRecords() {
  const { stdout } = await execFileP('lark-cli', [
    'base', '+record-list',
    '--base-token', APP_TOKEN,
    '--table-id', TABLE_ID,
    '--field-id', 'Task', '--field-id', 'Due', '--field-id', 'Priority', '--field-id', 'Status', '--field-id', 'Type',
    '--field-id', 'Scheduled Start', '--field-id', 'Scheduled End',
    '--as', 'user',
    '--format', 'json',
  ], { maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  // lark-cli json format returns matrix rows: {data:{data:[[...],...]}}
  // Field order matches --field-id flags:
  //   [Task, Due, Priority, Status, Type, Scheduled Start, Scheduled End]
  const rows = parsed?.data?.data ?? [];
  return rows;
}

// ── Transform bitable rows → widget data shapes ───────────────────────────
// Row shape from lark-cli: [Task, Due|null, Priority:[P], Status:[S], Type:[T]]
// Type splits rows into two cards: 'Task' → todo, 'Reminder' → reminder.
// Other types (e.g. Reading) aren't shown.
const first = (v) => (Array.isArray(v) ? v[0] : v);

function pending(rows, type) {
  return rows.filter((row) => first(row[3]) !== 'Done' && first(row[4]) === type);
}

// todo contract: { pending_count, items: [{title, due, priority}] }
function toTodo(rows) {
  const items = pending(rows, 'Task')
    .map((row) => ({
      title: row[0] ?? '(untitled)',
      due: row[1] ?? null,
      priority: first(row[2]) ?? 'P2',
    }))
    .sort((a, b) => {
      // Priority first (P0 < P1 < P2 < P3), then due date (nulls last)
      const pa = a.priority?.replace('P', '') ?? '9';
      const pb = b.priority?.replace('P', '') ?? '9';
      if (pa !== pb) return Number(pa) - Number(pb);
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    });
  return { pending_count: items.length, items };
}

// reminder contract: { items: [{title, due}] } — every pending reminder with a
// due date; the card itself narrows to the 3-day window at render time so the
// cutoff stays correct between syncs.
function toReminder(rows) {
  const items = pending(rows, 'Reminder')
    .filter((row) => row[1])
    .map((row) => ({ title: row[0] ?? '(untitled)', due: row[1] }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  return { items };
}

// schedule contract: { events: [{title, start, end}] } — every record decided
// for today (Status=Doing) AND actually slotted (both Scheduled times present),
// regardless of Type: talks/interviews often aren't Type=Task but still belong
// on today's timeline. Sorting / "now" highlighting happens client-side so the
// card stays correct between 5-min syncs without re-pushing.
function toSchedule(rows) {
  const events = rows
    .filter((row) => first(row[3]) === 'Doing' && row[5] && row[6])
    .map((row) => ({ title: row[0] ?? '(untitled)', start: row[5], end: row[6] }))
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
  const rows = await fetchRecords();
  console.log(`fetched ${rows.length} rows from bitable`);
  const todo = toTodo(rows);
  const reminder = toReminder(rows);
  const schedule = toSchedule(rows);
  console.log(`transformed → ${todo.pending_count} tasks, ${reminder.items.length} reminders, ${schedule.events.length} scheduled`);
  if (DRY_RUN) {
    console.log(JSON.stringify({ todo, reminder, schedule }, null, 2));
  } else {
    console.log('pushed todo:', JSON.stringify(await push('todo', '飞书待办', todo)));
    console.log('pushed reminder:', JSON.stringify(await push('reminder', 'Reminder', reminder)));
    console.log('pushed schedule:', JSON.stringify(await push('schedule', '今日安排', schedule)));
  }
} catch (err) {
  console.error('sync failed:', err.message ?? err);
  process.exit(1);
}
