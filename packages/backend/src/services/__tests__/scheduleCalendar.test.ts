import { describe, expect, test } from 'bun:test';
import { must } from '../../__tests__/helpers/must';
import {
  dueOccurrence,
  intervalOf,
  isKnownTimeZone,
  occurrenceAfter,
  occurrenceAtOrBefore,
  type ScheduleCadence,
} from '../reporting/scheduleCalendar';

const DAILY: ScheduleCadence = { interval: 'daily', weeklyAnchor: null, monthlyAnchor: null };
const MONDAYS: ScheduleCadence = {
  interval: 'weekly',
  weeklyAnchor: 'monday',
  monthlyAnchor: null,
};
const monthly = (day: number): ScheduleCadence => ({
  interval: 'monthly',
  weeklyAnchor: null,
  monthlyAnchor: day,
});

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

/** `count` consecutive occurrences after `from`. */
function walk(cadence: ScheduleCadence, zone: string, from: string, count: number): string[] {
  const out: string[] = [];
  let t = at(from);
  for (let i = 0; i < count; i += 1) {
    t = occurrenceAfter(cadence, zone, t);
    out.push(iso(t));
  }
  return out;
}

describe('report schedule calendar', () => {
  test('daily is local midnight, across a spring-forward and a fall-back', () => {
    // Madrid: 2027-03-28 02:00 → 03:00 (UTC+1 → +2); 2027-10-31 03:00 → 02:00.
    expect(walk(DAILY, 'Europe/Madrid', '2027-03-27T12:00:00Z', 3)).toEqual([
      '2027-03-27T23:00:00.000Z',
      '2027-03-28T22:00:00.000Z',
      '2027-03-29T22:00:00.000Z',
    ]);
    expect(walk(DAILY, 'Europe/Madrid', '2027-10-30T12:00:00Z', 2)).toEqual([
      '2027-10-30T22:00:00.000Z',
      '2027-10-31T23:00:00.000Z',
    ]);
    // The day the clocks change is 23 or 25 hours long, and the run covers exactly it.
    const short = intervalOf(DAILY, 'Europe/Madrid', at('2027-03-28T22:00:00Z'));
    expect((short.end - short.start) / 3_600_000).toBe(23);
    const long = intervalOf(DAILY, 'Europe/Madrid', at('2027-10-31T23:00:00Z'));
    expect((long.end - long.start) / 3_600_000).toBe(25);
  });

  test('a zone that skips midnight starts the day when the gap ends; a doubled midnight is the first', () => {
    // Santiago springs forward AT 00:00 (2026-09-06: 00:00 -04 → 01:00 -03).
    expect(walk(DAILY, 'America/Santiago', '2026-09-04T12:00:00Z', 3)).toEqual([
      '2026-09-05T04:00:00.000Z',
      '2026-09-06T04:00:00.000Z', // 01:00 local: midnight never happened
      '2026-09-07T03:00:00.000Z',
    ]);
    // …and falls back at 00:00 (2027-04-04: 00:00 -03 → 23:00 -04 of the 3rd).
    expect(walk(DAILY, 'America/Santiago', '2027-04-02T12:00:00Z', 3)).toEqual([
      '2027-04-03T03:00:00.000Z',
      '2027-04-04T04:00:00.000Z',
      '2027-04-05T04:00:00.000Z',
    ]);
  });

  test('weekly fires on its weekday, at the local midnight of each side of a DST change', () => {
    // New York falls back on Sunday 2026-11-01.
    expect(walk(MONDAYS, 'America/New_York', '2026-10-21T00:00:00Z', 3)).toEqual([
      '2026-10-26T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
      '2026-11-09T05:00:00.000Z',
    ]);
    const week = intervalOf(MONDAYS, 'America/New_York', at('2026-11-02T05:00:00Z'));
    expect(iso(week.start)).toBe('2026-10-26T04:00:00.000Z');
    expect((week.end - week.start) / 3_600_000).toBe(7 * 24 + 1);
  });

  test('monthly clamps to a short month and the runs tile the year', () => {
    expect(walk(monthly(31), 'UTC', '2027-01-15T00:00:00Z', 4)).toEqual([
      '2027-01-31T00:00:00.000Z',
      '2027-02-28T00:00:00.000Z',
      '2027-03-31T00:00:00.000Z',
      '2027-04-30T00:00:00.000Z',
    ]);
    // A leap year's February.
    expect(walk(monthly(30), 'UTC', '2028-02-01T00:00:00Z', 1)).toEqual([
      '2028-02-29T00:00:00.000Z',
    ]);
    // The 1st, in Madrid: each run is exactly the previous calendar month.
    const months = walk(monthly(1), 'Europe/Madrid', '2026-12-15T00:00:00Z', 13);
    for (const [index, end] of months.entries()) {
      const interval = intervalOf(monthly(1), 'Europe/Madrid', at(end));
      expect(iso(interval.end)).toBe(end);
      if (index > 0) expect(iso(interval.start)).toBe(must(months[index - 1]));
    }
    expect(months[0]).toBe('2026-12-31T23:00:00.000Z');
    expect(months[3]).toBe('2027-03-31T22:00:00.000Z');
  });

  test('a scheduler that slept fires once, for the latest occurrence, never a backlog', () => {
    // Asleep from mid-August to 7 November: the due occurrence is 1 November.
    const due = dueOccurrence(monthly(1), 'UTC', at('2026-11-07T12:00:00Z'));
    expect(iso(due.occurrence)).toBe('2026-11-01T00:00:00.000Z');
    expect(iso(due.next)).toBe('2026-12-01T00:00:00.000Z');
    // At an occurrence exactly, that occurrence is due.
    expect(iso(occurrenceAtOrBefore(DAILY, 'Asia/Tokyo', at('2026-11-07T15:00:00Z')))).toBe(
      '2026-11-07T15:00:00.000Z',
    );
    expect(iso(occurrenceAtOrBefore(DAILY, 'Asia/Tokyo', at('2026-11-07T14:59:59Z')))).toBe(
      '2026-11-06T15:00:00.000Z',
    );
  });

  test('only IANA zones this runtime knows', () => {
    expect(isKnownTimeZone('Europe/Madrid')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
  });
});
