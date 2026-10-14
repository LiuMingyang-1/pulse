// End-to-end check of the fallback scripts/sync-feishu.mjs path: run it with
// --dry-run against a fake lark-cli on PATH and assert the sort order it emits.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const at = (hm: string) => `${today}T${hm}:00.000+08:00`;

// [Task, Due, Priority, Status, Type, Scheduled Start, Scheduled End]
const rows: Array<[string, unknown[]]> = [
  ['p2', ['p2', '2026-10-20T10:00:00.000+08:00', ['P2'], ['Inbox'], ['Task'], null, null]],
  ['p0', ['p0', '2026-10-20T02:00:00.000Z', ['P0'], ['Inbox'], ['Task'], null, null]], // same instant as p2
  ['early', ['early', '2026-10-19T09:00:00.000+08:00', ['P3'], ['Inbox'], ['Task'], null, null]],
  ['nd3', ['nd3', null, ['P3'], ['Inbox'], ['Task'], null, null]],
  ['nd0', ['nd0', null, ['P0'], ['Inbox'], ['Task'], null, null]],
  ['s2', ['s2', null, ['P2'], ['Doing'], ['Reminder'], at('15:00'), at('16:00')]],
  ['s0', ['s0', null, ['P0'], ['Doing'], ['Reminder'], at('15:00'), at('17:00')]],
  ['s9', ['s9', null, ['P1'], ['Doing'], ['Reminder'], at('09:00'), at('10:00')]],
];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pulse-sync-'));
  const payload = JSON.stringify({
    data: { data: rows.map(([, r]) => r), record_id_list: rows.map(([id]) => id) },
  });
  writeFileSync(join(dir, 'payload.json'), payload);
  const bin = join(dir, 'lark-cli');
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(join(dir, 'payload.json'))}, 'utf8'));\n`,
  );
  chmodSync(bin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runDry() {
  const out = execFileSync('node', ['scripts/sync-feishu.mjs', '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      LARK_APP_TOKEN: 'app', LARK_TABLE_ID: 'tbl',
      PULSE_TOKEN: '', AGENT_TOKEN: '', // no D1 read in the test
    },
  });
  return JSON.parse(out.slice(out.indexOf('{\n')));
}

describe('scripts/sync-feishu.mjs (dry-run)', () => {
  it('todo: due ascending by timestamp, same due → P0 first, undated last by priority', () => {
    const { todo } = runDry();
    expect(todo.items.map((i: any) => i.id)).toEqual(['early', 'p0', 'p2', 'nd0', 'nd3']);
  });

  it('schedule: start ascending, same start → priority', () => {
    const { schedule } = runDry();
    expect(schedule.events.map((e: any) => e.title)).toEqual(['s9', 's0', 's2']);
  });
});
