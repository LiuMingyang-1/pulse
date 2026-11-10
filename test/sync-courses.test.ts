// End-to-end check of scripts/sync-courses.mjs: run it against a fake
// `xjtu_calendar` python executable and a local HTTP server, then assert the
// exact events blob it POSTs to /api/widgets/courses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const execFileP = promisify(execFile);

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:courseuid1@xjtu-cal',
  'DTSTAMP:20261110T000000Z',
  'DTSTART;TZID=Asia/Shanghai:20261110T140000',
  'DTEND;TZID=Asia/Shanghai:20261110T155000',
  'SUMMARY:信号与系统',
  'LOCATION:创新港校区 A-1001',
  'DESCRIPTION:教师: 张三\\; 周次: 1-16 周\\n单双周: 全周',
  'SEQUENCE:1',
  'END:VEVENT',
  // folded SUMMARY continuation must be joined back
  'BEGIN:VEVENT',
  'UID:courseuid2@xjtu-cal',
  'DTSTART;TZID=Asia/Shanghai:20261111T080000',
  'DTEND;TZID=Asia/Shanghai:20261111T095000',
  'SUMMARY:这是一门名字特别特别特别特别特别特别特别特别特别长的课程名',
  ' 称需要折行',
  'END:VEVENT',
  // tombstone: must be dropped
  'BEGIN:VEVENT',
  'UID:cancelled1@xjtu-cal',
  'DTSTART;TZID=Asia/Shanghai:20261112T100000',
  'DTEND;TZID=Asia/Shanghai:20261112T120000',
  'SUMMARY:已取消的考试',
  'STATUS:CANCELLED',
  'END:VEVENT',
  // all-day event: out of the timed-event contract, must be dropped
  'BEGIN:VEVENT',
  'UID:allday1@xjtu-cal',
  'DTSTART;VALUE=DATE:20270118',
  'DTEND;VALUE=DATE:20270301',
  'SUMMARY:寒假',
  'END:VEVENT',
  // UTC form must also parse
  'BEGIN:VEVENT',
  'UID:utc1@xjtu-cal',
  'DTSTART:20261120T020000Z',
  'DTEND:20261120T040000Z',
  'SUMMARY:Exam: 期末',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

let dir: string;
let server: Server;
let pulseUrl: string;
let posted: { id: string; body: string } | null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pulse-courses-test-'));
  const fake = join(dir, 'python3');
  writeFileSync(
    fake,
    `#!/bin/sh
# fake xjtu_calendar: fetch → exit 0; export → write canned ICS to --output
if [ "$1" = "fetch" ]; then echo "fetched"; exit 0; fi
if [ "$1" = "export" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--output" ]; then cat ${JSON.stringify(join(dir, 'canned.ics'))} > "$a"; fi
    prev="$a"
  done
  echo "exported"
  exit 0
fi
exit 2
`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'canned.ics'), ICS);

  posted = null;
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/widgets/courses') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posted = { id: 'courses', body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  pulseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  PULSE_URL: pulseUrl,
  PULSE_TOKEN: 'test-token',
  XJTU_CMD: join(dir, 'python3'),
  XJTU_SEMESTER: '2026-fall',
  // auto mode must not sniff the developer's real GMIS session
  XJTU_GMIS_HOME: join(dir, 'no-such-gmis-home'),
});

describe('scripts/sync-courses.mjs', () => {
  it('fetches, exports, parses and POSTs the courses row', async () => {
    await execFileP('node', [join(__dirname, '../scripts/sync-courses.mjs')], { env: env() });
    expect(posted).not.toBeNull();
    const payload = JSON.parse(posted!.body);
    expect(payload.source).toBe('xjtu-cron');
    expect(payload.title).toBe('课程订阅');
    const events = payload.data.events;
    expect(events).toHaveLength(3);
    expect(events.map((e: { id?: string }) => e.id)).toEqual([
      'courseuid1@xjtu-cal',
      'courseuid2@xjtu-cal',
      'utc1@xjtu-cal',
    ]);
    const course = events[0];
    expect(course.title).toBe('信号与系统');
    expect(course.start).toBe('2026-11-10T14:00:00+08:00');
    expect(course.end).toBe('2026-11-10T15:50:00+08:00');
    expect(course.location).toBe('创新港校区 A-1001');
    expect(course.description).toBe('教师: 张三; 周次: 1-16 周\n单双周: 全周');
    const folded = events[1];
    expect(folded.title).toBe('这是一门名字特别特别特别特别特别特别特别特别特别长的课程名称需要折行');
    expect(events[2].start).toBe('2026-11-20T02:00:00Z');
  });

  it('--no-fetch still exports and pushes', async () => {
    posted = null;
    await execFileP('node', [join(__dirname, '../scripts/sync-courses.mjs'), '--no-fetch'], {
      env: env(),
    });
    expect(posted).not.toBeNull();
  });
});

// ── gmis mode (grad students) ─────────────────────────────────────────────
const GMIS_EVENTS_JSON = JSON.stringify({
  events: [
    {
      id: 'gmisuid1@xjtu-gmis',
      title: '矩阵论',
      start: '2026-11-10T14:00:00+08:00',
      end: '2026-11-10T15:50:00+08:00',
      location: '创新港 4-5001',
      description: '教师: 李四\n3-4节 1-16周',
    },
  ],
});

describe('scripts/sync-courses.mjs (gmis mode)', () => {
  let gmisDir: string;

  beforeAll(() => {
    gmisDir = mkdtempSync(join(tmpdir(), 'pulse-gmis-test-'));
    writeFileSync(join(gmisDir, 'canned.json'), GMIS_EVENTS_JSON);
    const fake = join(gmisDir, 'gmis-python');
    writeFileSync(
      fake,
      `#!/bin/sh
# fake xjtu-gmis.py: pull/events → canned events JSON on stdout
if [ "$2" = "pull" ] || [ "$2" = "events" ]; then cat ${JSON.stringify(join(gmisDir, 'canned.json'))}; exit 0; fi
exit 2
`,
    );
    chmodSync(fake, 0o755);
  });
  afterAll(() => rmSync(gmisDir, { recursive: true, force: true }));

  const gmisEnv = () => ({
    ...env(),
    XJTU_MODE: 'gmis',
    XJTU_GMIS_PYTHON: join(gmisDir, 'gmis-python'),
  });

  it('pushes the events JSON emitted by xjtu-gmis.py pull', async () => {
    posted = null;
    await execFileP('node', [join(__dirname, '../scripts/sync-courses.mjs')], { env: gmisEnv() });
    const payload = JSON.parse(posted!.body);
    expect(payload.source).toBe('xjtu-cron');
    expect(payload.data.events).toHaveLength(1);
    expect(payload.data.events[0].id).toBe('gmisuid1@xjtu-gmis');
    expect(payload.data.events[0].location).toBe('创新港 4-5001');
  });

  it('real python3 expands a GMIS page fixture into dated events', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'pulse-gmis-fixture-'));
    try {
      writeFileSync(
        join(fixtureDir, 'page.html'),
        `<select id="drpxq"><option value="95" selected="selected">2026秋</option></select>
<td=x></td>
<script>
td=document.getElementById("td_2_3");if (td.innerHTML!="") td.innerHTML+="<br><br>";td.innerHTML+="课程：信号与系统<br>班级：硕01<br>教师：张三<br>教室：A-1001<br>节次：3-4<br>周次：1-16周";
td=document.getElementById("td_4_9");if (td.innerHTML!="") td.innerHTML+="<br><br>";td.innerHTML+="课程：最优化<br>班级：硕02<br>教师：李四<br>教室：B-210<br>节次：9-10<br>周次：1-8周";
</script>`,
      );
      writeFileSync(
        join(fixtureDir, 'sem.json'),
        JSON.stringify({
          semester: { key: '2026-fall', first_week_monday: '2026-09-07' },
          excluded_dates: ['2026-10-01'],
        }),
      );
      writeFileSync(
        join(fixtureDir, 'sched.json'),
        JSON.stringify({
          profiles: {
            w: { name: 'w', periods: { '3': ['10:10', '11:00'], '4': ['11:10', '12:00'], '9': ['19:10', '20:00'], '10': ['20:10', '21:00'] } },
          },
          periods: [{ start: '2026-10-01', end: '2027-04-30', profile: 'w' }],
        }),
      );
      const { stdout } = await execFileP('python3', [
        join(__dirname, '../scripts/xjtu-gmis.py'), 'events',
        '--input', join(fixtureDir, 'page.html'),
        '--semester', '2026-fall',
        '--calendar-config', join(fixtureDir, 'sem.json'),
        '--schedule-config', join(fixtureDir, 'sched.json'),
      ]);
      const { events } = JSON.parse(stdout);
      // 信号与系统: week 5+ only (winter profile starts 10-01) → Tue weeks 5-16
      //   minus none; 最优化: Thu weeks 5-8. First event = 2026-10-06.
      expect(events.length).toBe(12 + 4);
      expect(events[0].start).toBe('2026-10-06T10:10:00+08:00');
      expect(events[0].end).toBe('2026-10-06T12:00:00+08:00');
      expect(events[0].title).toBe('信号与系统');
      expect(events[0].location).toBe('A-1001');
      expect(events[0].id).toMatch(/@xjtu-gmis$/);
      const opt = events.find((e: { title: string }) => e.title === '最优化');
      expect(opt.start).toBe('2026-10-08T19:10:00+08:00');
      // no event on the excluded holiday 2026-10-01 (Thu)
      expect(events.some((e: { start: string }) => e.start.startsWith('2026-10-01'))).toBe(false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
