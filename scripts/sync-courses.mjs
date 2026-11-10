#!/usr/bin/env node
// sync-courses.mjs — XJTU eHall timetable → Pulse `courses` widget row, which
// /api/calendar.ics merges into the same iPhone subscription as the task
// events computed from the tasks table. Run on a host with a logged-in
// xjtu-timetable-calendar
// session (your Mac), not in the Worker — eHall SSO needs a one-time manual
// browser login and the session file lives under XJTU_CALENDAR_HOME.
//
// Pipeline: `xjtu-calendar fetch` (best effort — falls back to the cached raw
// snapshot when the eHall session has expired) → `export` to a temp .ics →
// parse VEVENTs → POST /api/widgets/courses (wholesale replace, so dropped
// courses/exams disappear by UID on the next refresh).
//
// Usage:
//   node scripts/sync-courses.mjs                  # fetch + export + push
//   node scripts/sync-courses.mjs --no-fetch       # export cached snapshot + push
//   node scripts/sync-courses.mjs --dry-run        # print events, don't POST
//
// Env (process.env → .dev.vars → defaults):
//   PULSE_URL          (default http://localhost:8787)
//   PULSE_TOKEN        (required unless --dry-run — same as AGENT_TOKEN)
//   PULSE_SOURCE       (optional — `source` tag on the row; default 'xjtu-cron')
//   XJTU_SEMESTER      (optional — default derived from today: Aug–Jan →
//                       <year>-fall, Feb–Jul → <year>-spring; must match the
//                       filename under ~/.xjtu-timetable-calendar/semesters/)
//   XJTU_CMD           (optional — how to invoke the tool, split on spaces.
//                       Default: `uvx --from xjtu-timetable-calendar[http,browser]
//                       xjtu-calendar` when uvx is on PATH (zero-install — uv
//                       runs it in a cached ephemeral env), else
//                       `python3 -m xjtu_calendar` for a real pip install)
//   XJTU_CALENDAR_HOME (optional — passed through to the tool; default
//                       ~/.xjtu-timetable-calendar)
//   XJTU_MODE          (optional — 'ehall' | 'gmis' | 'auto'. Grad students:
//                       the ehall 课表 app is undergrad-only (CAS denies the
//                       ticket), use 'gmis' — scripts/xjtu-gmis.py drives
//                       研究生管理信息系统 with its own saved session.
//                       'auto' (default) picks gmis when a GMIS session
//                       exists at ~/.xjtu-gmis/session/, else ehall)
//   XJTU_GMIS_PYTHON   (optional — python for the gmis script, default
//                       'python3'; its pull path is stdlib-only)
//
// Limitations: STATUS:CANCELLED tombstones and all-day (VALUE=DATE) events are
// skipped — the widget contract is timed events only, so --include-calendar-events
// output (校历全天事件) won't reach the feed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
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
const SOURCE = nonempty(process.env.PULSE_SOURCE) ?? 'xjtu-cron';

const onPath = (bin) =>
  (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, bin)));

// Tool invocation prefix. `uvx --from <pkg> xjtu-calendar` needs no install —
// uv builds the env once in its cache and reuses it. The extras pull in httpx
// (HTTP fetch path) and playwright (login only). pip users get the same CLI
// via `python3 -m xjtu_calendar`.
const XJTU_PKG = 'xjtu-timetable-calendar[http,browser]';
const XJTU_CMD = (
  nonempty(process.env.XJTU_CMD)
  ?? (onPath('uvx')
    ? `uvx --from ${XJTU_PKG} xjtu-calendar`
    : 'python3 -m xjtu_calendar')
).split(/\s+/);

const GMIS_SCRIPT = join(repoRoot, 'scripts', 'xjtu-gmis.py');
const GMIS_SESSION = join(process.env.XJTU_GMIS_HOME ?? join(process.env.HOME ?? '', '.xjtu-gmis'), 'session', 'storage_state.json');
const GMIS_PYTHON = nonempty(process.env.XJTU_GMIS_PYTHON) ?? 'python3';
// 'ehall' = undergrad 教务 app (xjtu-timetable-calendar), 'gmis' = 研究生系统.
// auto: grad pipeline once its session exists, ehall otherwise.
const XJTU_MODE = nonempty(process.env.XJTU_MODE) ?? 'auto';
const MODE = XJTU_MODE === 'auto' ? (existsSync(GMIS_SESSION) ? 'gmis' : 'ehall') : XJTU_MODE;
const DRY_RUN = process.argv.includes('--dry-run');
const NO_FETCH = process.argv.includes('--no-fetch');

// Aug–Jan belongs to the fall semester, Feb–Jul to spring. Override with
// XJTU_SEMESTER when the key on disk doesn't follow this convention.
function defaultSemester(now = new Date()) {
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  if (m >= 8) return `${y}-fall`;
  if (m === 1) return `${y - 1}-fall`;
  return `${y}-spring`;
}
const SEMESTER = nonempty(process.env.XJTU_SEMESTER) ?? defaultSemester();

if (!PULSE_TOKEN && !DRY_RUN) {
  console.error('PULSE_TOKEN required (the AGENT_TOKEN for POST /api/widgets/*)');
  process.exit(1);
}

// ── xjtu-timetable-calendar subprocesses ───────────────────────────────────
// Exit code 3 means the saved eHall session is dead — only `login --force`
// (manual SSO in the popped-up browser) fixes it. Fetch failure is not fatal:
// the tool keeps the last raw snapshot under raw/ and export can still run.
const xjtu = (args) =>
  execFileP(XJTU_CMD[0], [...XJTU_CMD.slice(1), ...args], { maxBuffer: 8 * 1024 * 1024 });
const xjtuCmdStr = () => XJTU_CMD.join(' ');

async function fetchTimetable() {
  try {
    const { stdout, stderr } = await xjtu(['fetch', '--semester', SEMESTER]);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    return true;
  } catch (err) {
    console.warn(`fetch failed (exit ${err.code ?? '?'})`);
    // The tool explains itself on stderr (missing config, dead session…) —
    // err.message only carries the command line, not the reason.
    if (typeof err.stderr === 'string' && err.stderr.trim()) {
      console.warn(err.stderr.trim());
    }
    if (err.code === 3) {
      console.warn(`eHall session expired — run \`${xjtuCmdStr()} login --force\` and complete SSO in the popped-up browser.`);
    }
    console.warn('continuing with the last cached snapshot (stale schedule is better than none).');
    return false;
  }
}

async function exportIcs(outPath) {
  const { stdout, stderr } = await xjtu(['export', '--semester', SEMESTER, '--output', outPath]);
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}

// ── Minimal ICS reader (input is machine-generated by the tool) ────────────
// Unfold continuation lines, then read bare properties inside VEVENT blocks.
function unfoldIcs(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

// "DTSTART;TZID=Asia/Shanghai:20261110T140000" → { name: 'DTSTART', params, value }
function parseProp(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

// One pass — sequential replaces would mis-decode "\\n" (literal backslash+n)
// into a newline.
const icsUnescape = (s) =>
  s.replace(/\\(.)/gs, (m, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));

// "20261110T140000" + TZID → ISO. Everything XJTU is Asia/Shanghai (+08:00,
// no DST); a trailing Z stays UTC. Returns null on anything unparseable —
// the caller drops the event rather than corrupting the feed.
function icsDateToIso(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const offset = z === 'Z' ? 'Z' : '+08:00';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
}

// → [{id?, title, start, end, location?, description?}] — the widget contract.
// CANCELLED tombstones and all-day events never enter the list.
function parseCourseIcs(text) {
  const events = [];
  const seen = new Set();
  let cur = null;
  for (const line of unfoldIcs(text)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.title && cur.start && cur.end && cur.status !== 'CANCELLED' && !seen.has(cur.id ?? cur.title + cur.start)) {
        seen.add(cur.id ?? cur.title + cur.start);
        events.push(cur);
        delete cur.status;
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseProp(line);
    if (!p) continue;
    if (p.name === 'UID') cur.id = p.value;
    else if (p.name === 'SUMMARY') cur.title = icsUnescape(p.value);
    else if (p.name === 'LOCATION') cur.location = icsUnescape(p.value);
    else if (p.name === 'DESCRIPTION') cur.description = icsUnescape(p.value);
    else if (p.name === 'STATUS') cur.status = p.value.toUpperCase();
    else if (p.name === 'DTSTART' || p.name === 'DTEND') {
      // VALUE=DATE (all-day) events never match the time pattern → both stay
      // undefined and the event is skipped at END:VEVENT.
      const iso = icsDateToIso(p.value, p.params);
      if (p.name === 'DTSTART') cur.start = iso ?? undefined;
      else cur.end = iso ?? undefined;
    }
  }
  return events;
}

// ── Push to Pulse ─────────────────────────────────────────────────────────
async function push(id, title, data) {
  const res = await fetch(`${PULSE_URL}/api/widgets/${id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PULSE_TOKEN}`,
    },
    body: JSON.stringify({ title, data, source: SOURCE }),
  });
  if (!res.ok) throw new Error(`POST ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Events from either pipeline ───────────────────────────────────────────
// gmis: the python script emits {events:[...]} on stdout, warnings on stderr.
async function pullGmisEvents() {
  const sub = NO_FETCH ? 'events' : 'pull';
  try {
    const { stdout, stderr } = await execFileP(
      GMIS_PYTHON, [GMIS_SCRIPT, sub, '--semester', SEMESTER],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    if (stderr.trim()) process.stderr.write(stderr);
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch (err) {
    if (typeof err.stderr === 'string' && err.stderr.trim()) process.stderr.write(err.stderr);
    throw new Error(`xjtu-gmis ${sub} failed (exit ${err.code ?? '?'})`);
  }
}

async function pullEhallEvents() {
  if (NO_FETCH) console.log('skipping fetch (--no-fetch)');
  else await fetchTimetable();
  const tmp = mkdtempSync(join(tmpdir(), 'pulse-courses-'));
  try {
    const icsPath = join(tmp, `${SEMESTER}.ics`);
    await exportIcs(icsPath);
    return parseCourseIcs(readFileSync(icsPath, 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const doctorHint = () => MODE === 'gmis'
  ? `${GMIS_PYTHON} ${GMIS_SCRIPT} doctor --semester ${SEMESTER}`
  : `${xjtuCmdStr()} doctor --semester ${SEMESTER}`;

// ── Main ──────────────────────────────────────────────────────────────────
try {
  console.log(`mode: ${MODE}${XJTU_MODE === 'auto' ? ' (auto)' : ''}`);
  const events = (MODE === 'gmis' ? await pullGmisEvents() : await pullEhallEvents())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  console.log(`parsed ${events.length} events for ${SEMESTER}` +
    (events.length ? ` (${events[0].start.slice(0, 10)} → ${events[events.length - 1].end.slice(0, 10)})` : ''));
  if (!events.length) {
    console.error(`no events parsed — refusing to wipe the courses row. Check \`${doctorHint()}\`.`);
    process.exit(1);
  }
  const data = { events };
  if (DRY_RUN) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log('pushed courses:', JSON.stringify(await push('courses', '课程订阅', data)));
  }
} catch (err) {
  console.error('sync failed:', err.message ?? err);
  console.error(`setup check: \`${doctorHint()}\` (needs semesters/${SEMESTER}.json + schedules/schedule.json under XJTU_CALENDAR_HOME).`);
  process.exit(1);
}
