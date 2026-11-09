import { describe, it, expect } from 'vitest';
import { icsDateUtc, icsEscape, foldLine, icsUid, toIcs } from '../src/ics';

describe('icsDateUtc', () => {
  it('converts offsets to UTC compact form', () => {
    expect(icsDateUtc('2026-10-13T09:00:00.000+08:00')).toBe('20261013T010000Z');
    expect(icsDateUtc('2026-10-13T01:00:00.000Z')).toBe('20261013T010000Z');
  });
  it('rejects garbage', () => {
    expect(icsDateUtc('nope')).toBeNull();
    expect(icsDateUtc('')).toBeNull();
  });
});

describe('icsEscape', () => {
  it('escapes comma, semicolon, backslash, newline', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });
});

describe('foldLine', () => {
  const byteLen = (s: string) => new TextEncoder().encode(s).length;
  it('keeps short lines whole', () => {
    expect(foldLine('SUMMARY:hi')).toEqual(['SUMMARY:hi']);
  });
  it('folds to ≤75 octets, continuations open with a space, never splits a char', () => {
    const line = `SUMMARY:${'排'.repeat(40)}`; // 3-byte chars force folds
    const out = foldLine(line);
    expect(out.length).toBeGreaterThan(1);
    for (const [i, l] of out.entries()) {
      expect(byteLen(l)).toBeLessThanOrEqual(75);
      if (i > 0) expect(l.startsWith(' ')).toBe(true);
    }
    expect(out.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(line);
  });
});

describe('icsUid', () => {
  it('uses the record id when present, a stable hash otherwise', () => {
    expect(icsUid({ title: 'x', start: 'a', end: 'b', id: 'rec1' })).toBe('rec1@pulse');
    const e = { title: 'x', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' };
    expect(icsUid(e)).toBe(icsUid({ ...e }));
    expect(icsUid(e)).toMatch(/^e[0-9a-f]+@pulse$/);
    expect(icsUid(e)).not.toBe(icsUid({ ...e, title: 'y' }));
  });
});

describe('toIcs', () => {
  it('emits a VCALENDAR with CRLF, UTC times, escaping; skips bad dates', () => {
    const out = toIcs(
      [
        {
          id: 'r1',
          title: '晨会, 对齐',
          start: '2026-10-13T09:30:00.000+08:00',
          end: '2026-10-13T09:45:00.000+08:00',
        },
        { title: 'bad', start: 'nope', end: '2026-10-13T00:00:00Z' },
      ],
      'Pulse 日程',
      new Date('2026-10-13T00:00:00Z'),
    );
    expect(out.endsWith('\r\n')).toBe(true);
    expect(out).toContain('BEGIN:VCALENDAR');
    expect(out).toContain('END:VCALENDAR');
    expect(out).toContain('VERSION:2.0');
    expect(out).toContain('X-WR-CALNAME:Pulse 日程');
    expect(out).toContain('UID:r1@pulse');
    expect(out).toContain('DTSTAMP:20261013T000000Z');
    expect(out).toContain('DTSTART:20261013T013000Z');
    expect(out).toContain('DTEND:20261013T014500Z');
    expect(out).toContain('SUMMARY:晨会\\, 对齐');
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
  it('empty events still produce a subscribable calendar', () => {
    const out = toIcs([]);
    expect(out).toContain('BEGIN:VCALENDAR');
    expect(out).not.toContain('BEGIN:VEVENT');
  });
  it('skips events whose end is not strictly after start', () => {
    const out = toIcs([
      { title: 'reversed', start: '2026-10-13T10:00:00Z', end: '2026-10-13T09:00:00Z' },
      { title: 'zero-len', start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:00:00Z' },
      { title: 'ok', start: '2026-10-13T10:00:00Z', end: '2026-10-13T11:00:00Z' },
    ]);
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(out).toContain('SUMMARY:ok');
  });
});
