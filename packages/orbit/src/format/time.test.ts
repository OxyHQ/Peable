import { describe, expect, it } from 'bun:test';
import { formatInstant, formatRelative, formatShortInstant, fromUnixSeconds, utcDay } from './time';

describe('time helpers', () => {
  it('reads wire instants as Unix seconds', () => {
    expect(fromUnixSeconds(1_700_000_000).toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(utcDay(1_700_000_000)).toBe('2023-11-14');
  });

  it('shows a dash for a missing instant', () => {
    expect(formatInstant(undefined)).toBe('—');
    expect(formatInstant(null)).toBe('—');
    expect(formatInstant(Number.NaN)).toBe('—');
    expect(formatInstant(1_700_000_000, 'en-US')).toContain('2023');
  });

  it('describes a coarse relative time in both directions', () => {
    const now = 1_000_000;
    expect(formatRelative(now, now)).toBe('now');
    expect(formatRelative(now + 30, now)).toBe('in 30 s');
    expect(formatRelative(now + 300, now)).toBe('in 5 min');
    expect(formatRelative(now - 7200, now)).toBe('2 h ago');
    expect(formatRelative(now - 3 * 86_400, now)).toBe('3 d ago');
  });

  it('shortens a table date: the time this year, the year before it', () => {
    const now = Date.UTC(2026, 10, 4, 12) / 1000;
    const thisYear = Date.UTC(2026, 2, 3, 9, 5) / 1000;
    const lastYear = Date.UTC(2024, 2, 3, 9, 5) / 1000;
    expect(formatShortInstant(thisYear, 'en-US', now)).toContain('Mar 3');
    expect(formatShortInstant(thisYear, 'en-US', now)).not.toContain('2026');
    expect(formatShortInstant(lastYear, 'en-US', now)).toContain('2024');
    expect(formatShortInstant(null, 'en-US', now)).toBe('—');
  });
});
