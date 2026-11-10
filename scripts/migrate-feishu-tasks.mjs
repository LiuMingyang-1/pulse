#!/usr/bin/env node
// One-off export: Feishu bitable tasks → SQL INSERTs for the D1 `tasks` table.
// Usage:
//   node scripts/migrate-feishu-tasks.mjs > tasks-import.sql
//   npx wrangler d1 execute pulse-db --remote --file=tasks-import.sql
//
// Feishu record_ids are kept as primary keys so /api/calendar.ics UIDs
// (`<record_id>@pulse`) don't change for existing subscribers. completed_at
// is left NULL — bitable has no completion timestamp, and flooding today's
// done section with 60 historical rows is the old bug we already fixed once.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN ?? 'KkKJbeFuaayQHysyH1Wc9frRnPe';
const TABLE_ID = process.env.FEISHU_TABLE_ID ?? 'tbl9BFvxgcbQgJ5D';
const LARK_AS = process.env.LARK_AS ?? 'bot';

function lark(args) {
  return execFileP('lark-cli', args, { maxBuffer: 64 * 1024 * 1024 });
}

async function fetchAllRecords() {
  const items = [];
  let pageToken = null;
  for (let page = 0; page < 50; page++) {
    const params = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;
    const { stdout } = await lark([
      'api', 'GET',
      `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`,
      '--params', JSON.stringify(params),
    ]);
    const body = JSON.parse(stdout);
    if (!body.ok) throw new Error(`records list failed: ${JSON.stringify(body.error ?? body)}`);
    items.push(...(body.data?.items ?? []));
    if (!body.data?.has_more || !body.data?.page_token) return items;
    pageToken = body.data.page_token;
  }
  throw new Error('too many pages');
}

// ── Cell coercion (mirrors src/feishu-transform.ts adaptValue semantics) ──
const textOf = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const s = v.map((seg) => (typeof seg === 'string' ? seg : seg?.text ?? '')).join('');
    return s === '' ? null : s;
  }
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return null;
};

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

// ms epoch → '2026-10-14T15:00:00.000+08:00' (Shanghai, no DST).
const msToIso = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');

const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });

function dateCell(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (Number.isFinite(ms)) return msToIso(ms);
  return typeof v === 'string' ? v : null;
}

function dayCell(v) {
  const iso = dateCell(v);
  if (!iso) return null;
  const dateOnly = iso.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : SHANGHAI_DAY.format(d);
}

const checkbox = (v) => (v === true || v === 1 || v === 'true' ? 1 : 0);

// SQL literal — everything as quoted strings / numbers / NULL.
const lit = (v) => (v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const num = (v) => (v == null ? 'NULL' : String(v));

const items = await fetchAllRecords();
const now = new Date().toISOString();

console.log('-- Feishu tasks export → D1 tasks. %d rows, exported %s', items.length, now);
// No BEGIN/COMMIT — remote `d1 execute` rejects explicit transactions and
// applies the file's statements itself.
for (const rec of items) {
  const f = rec.fields ?? {};
  const cols = {
    id: rec.record_id,
    title: textOf(f.Task) ?? '(untitled)',
    type: textOf(first(f.Type)) ?? 'Task',
    status: textOf(first(f.Status)) ?? 'Inbox',
    done: checkbox(f['已完成']),
    due: dateCell(f.Due),
    priority: textOf(first(f.Priority)) ?? 'P2',
    plan_date: dayCell(f['计划日期']),
    scheduled_start: dateCell(f['Scheduled Start']),
    scheduled_end: dateCell(f['Scheduled End']),
    notes: textOf(f.Notes) ?? '',
    project: textOf(first(f.Project)),
    tags: Array.isArray(f.Tags) && f.Tags.length ? JSON.stringify(f.Tags.map(textOf).filter(Boolean)) : null,
    calendar_event_id: textOf(f['Calendar Event ID']),
    completed_at: null, // no Feishu source — fresh completions stamp it from now on
    created_at: dateCell(f.Created) ?? now,
    updated_at: now,
  };
  console.log(
    `INSERT INTO tasks (id, title, type, status, done, due, priority, plan_date,` +
    ` scheduled_start, scheduled_end, notes, project, tags, calendar_event_id,` +
    ` completed_at, created_at, updated_at) VALUES (` +
    `${lit(cols.id)}, ${lit(cols.title)}, ${lit(cols.type)}, ${lit(cols.status)}, ` +
    `${num(cols.done)}, ${lit(cols.due)}, ${lit(cols.priority)}, ${lit(cols.plan_date)}, ` +
    `${lit(cols.scheduled_start)}, ${lit(cols.scheduled_end)}, ${lit(cols.notes)}, ` +
    `${lit(cols.project)}, ${lit(cols.tags)}, ${lit(cols.calendar_event_id)}, ` +
    `NULL, ${lit(cols.created_at)}, ${lit(cols.updated_at)});`,
  );
}
console.error(`exported ${items.length} records`);
