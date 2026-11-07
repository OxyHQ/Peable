/**
 * A report schedule's calendar: when each occurrence is, and what its run
 * covers. Pure — every instant is an argument, never the clock.
 *
 * An occurrence is LOCAL MIDNIGHT in the schedule's IANA time zone on a day
 * the cadence names: every day (`daily`), the anchor weekday (`weekly`), or
 * the anchor day of the month (`monthly`, clamped to a shorter month's last
 * day — the 31st fires on 30 April and 28/29 February). A run covers
 * `[previous occurrence, occurrence)`, so consecutive runs tile time with no
 * gap and no overlap, whatever the month length or the daylight-saving shift
 * between them.
 *
 * Where a zone skips midnight (a spring-forward AT 00:00, as some zones do),
 * the day starts at the first instant that exists — the end of the gap; where
 * midnight happens twice (a fall-back at 00:00), the first one.
 */
import type { ReportScheduleInterval, ReportScheduleWeekday } from '@peable.to/shared-types';
import { REPORT_SCHEDULE_WEEKDAYS } from '@peable.to/shared-types';

export interface ScheduleCadence {
  readonly interval: ReportScheduleInterval;
  readonly weeklyAnchor: ReportScheduleWeekday | null;
  readonly monthlyAnchor: number | null;
}

const DAY_MS = 86_400_000;
/** More than any gap between two occurrences (a month, clamped), with room. */
const SEARCH_DAYS = 70;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is an IANA zone this runtime knows (`Europe/Madrid`, `UTC`). */
export function isKnownTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at `at`, as if it were UTC (ms). */
function wallClock(timeZone: string, at: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** The local calendar day of `at`, as the UTC midnight of that date (ms). */
function localDay(timeZone: string, at: number): number {
  const wall = wallClock(timeZone, at);
  return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
}

/**
 * The first instant of the local day `day` (a UTC-midnight date, ms): the
 * candidates are midnight under the offset a day before and a day after (a
 * zone changes offset at most once in between); the earliest whose local day
 * is `day` wins. In a gap at midnight the earlier offset lands exactly at the
 * gap's end, which is the day's first instant.
 */
function startOfLocalDay(timeZone: string, day: number): number | null {
  const offsetAt = (at: number) => wallClock(timeZone, at) - Math.floor(at / 1000) * 1000;
  const candidates = [day - offsetAt(day - DAY_MS), day - offsetAt(day + DAY_MS)]
    .filter((at) => localDay(timeZone, at) === day)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

function daysInMonth(day: number): number {
  const date = new Date(day);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Whether the local date `day` is one the cadence fires on. */
function firesOn(cadence: ScheduleCadence, day: number): boolean {
  const date = new Date(day);
  switch (cadence.interval) {
    case 'daily':
      return true;
    case 'weekly':
      // getUTCDay: Sunday = 0; the vocabulary is Monday first.
      return REPORT_SCHEDULE_WEEKDAYS[(date.getUTCDay() + 6) % 7] === cadence.weeklyAnchor;
    case 'monthly':
      return date.getUTCDate() === Math.min(cadence.monthlyAnchor ?? 1, daysInMonth(day));
  }
}

/** The latest occurrence at or before `at` (ms). */
export function occurrenceAtOrBefore(
  cadence: ScheduleCadence,
  timeZone: string,
  at: number,
): number {
  let day = localDay(timeZone, at);
  for (let i = 0; i < SEARCH_DAYS; i += 1, day -= DAY_MS) {
    if (!firesOn(cadence, day)) continue;
    const start = startOfLocalDay(timeZone, day);
    if (start !== null && start <= at) return start;
  }
  throw new Error(`no ${cadence.interval} occurrence in ${timeZone} before ${String(at)}`);
}

/** The earliest occurrence strictly after `at` (ms). */
export function occurrenceAfter(cadence: ScheduleCadence, timeZone: string, at: number): number {
  let day = localDay(timeZone, at);
  for (let i = 0; i < SEARCH_DAYS; i += 1, day += DAY_MS) {
    if (!firesOn(cadence, day)) continue;
    const start = startOfLocalDay(timeZone, day);
    if (start !== null && start > at) return start;
  }
  throw new Error(`no ${cadence.interval} occurrence in ${timeZone} after ${String(at)}`);
}

/** What the run of `occurrence` covers: since the occurrence before it, up to it. */
export function intervalOf(
  cadence: ScheduleCadence,
  timeZone: string,
  occurrence: number,
): { readonly start: number; readonly end: number } {
  return { start: occurrenceAtOrBefore(cadence, timeZone, occurrence - 1), end: occurrence };
}

/**
 * What a scheduler finds due at `now` (ms): the LATEST occurrence that has
 * passed — never a backlog of the ones it slept through — and the one after
 * it, which is `next_run_at`.
 */
export function dueOccurrence(
  cadence: ScheduleCadence,
  timeZone: string,
  now: number,
): { readonly occurrence: number; readonly next: number } {
  const occurrence = occurrenceAtOrBefore(cadence, timeZone, now);
  return { occurrence, next: occurrenceAfter(cadence, timeZone, occurrence) };
}
