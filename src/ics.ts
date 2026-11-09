// iCalendar (RFC 5545) feed generation for /api/calendar.ics. Pure string
// building — unit-tested in test/ics.test.ts. iOS Calendar re-fetches the
// URL on its own subscription schedule; REFRESH-INTERVAL is only a hint.

export interface IcsEvent {
  id?: string;
  title: string;
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

const PRODID = '-//pulse//calendar feed//EN';

// "2026-10-13T09:00:00.000+08:00" → "20261013T010000Z". null when unparseable.
export function icsDateUtc(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// RFC 5545 TEXT escaping.
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const utf8Len = (ch: string): number => {
  const cp = ch.codePointAt(0)!;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
};

// Content lines are ≤75 octets; longer ones fold onto continuation lines that
// open with a space (leaving 74 usable). Never splits a multi-byte UTF-8 char.
export function foldLine(line: string): string[] {
  const lines: string[] = [];
  let cur = '';
  let room = 75;
  for (const ch of line) {
    const n = utf8Len(ch);
    if (n > room) {
      lines.push(cur);
      cur = ` ${ch}`;
      room = 74 - n;
    } else {
      cur += ch;
      room -= n;
    }
  }
  lines.push(cur);
  return lines;
}

// djb2 hex — stable across syncs. Events carrying a record_id use it; idless
// ones (e.g. the schedule-widget fallback shape) key on title+start+end.
export function icsUid(e: IcsEvent): string {
  if (e.id) return `${e.id}@pulse`;
  let h = 5381;
  const s = `${e.title}\n${e.start}\n${e.end}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `e${(h >>> 0).toString(16)}@pulse`;
}

export function toIcs(events: IcsEvent[], calName = 'Pulse 日程', now = new Date()): string {
  const stamp = icsDateUtc(now.toISOString())!;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    const startMs = Date.parse(e.start);
    const endMs = Date.parse(e.end);
    // RFC 5545 §3.8.2.2: DTEND must be strictly later than DTSTART.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const start = icsDateUtc(e.start)!;
    const end = icsDateUtc(e.end)!;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsUid(e)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${icsEscape(String(e.title ?? ''))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
}
