/**
 * Billing periods and proration — pure, no clock, no database (ADR 0018).
 *
 * ## Periods are counted from the anchor, never from the previous period
 *
 * A monthly subscription anchored on 31 January renews on 28/29 February,
 * 31 March, 30 April, 31 May: each boundary is `anchor + k intervals`, with the
 * day clamped to the length of the month it lands in. Computing each end from
 * the PREVIOUS end instead would drift to the 28th forever after February —
 * Stripe's behaviour is the anchored one, and so is this.
 *
 * Time of day is the anchor's, in UTC.
 *
 * ## Proration is by the second, rounded half up once per line
 *
 * `amount × remaining / period`, in exact integer arithmetic: the credit for
 * the unused part of a period and the charge for the remaining part of the new
 * one are each rounded once, so a change and its reversal cancel exactly when
 * the amounts are equal.
 */
import type { RecurringInterval } from '@peable.to/shared-types';

export interface Recurrence {
  readonly interval: RecurringInterval;
  readonly intervalCount: number;
}

const DAY_MS = 86_400_000;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** `anchor` moved by `n` units of `interval` (n may be negative), day clamped. */
export function addIntervals(anchor: Date, interval: RecurringInterval, n: number): Date {
  if (!Number.isInteger(n)) throw new RangeError('n must be an integer');
  if (interval === 'day') return new Date(anchor.getTime() + n * DAY_MS);
  if (interval === 'week') return new Date(anchor.getTime() + n * 7 * DAY_MS);
  const months = interval === 'month' ? n : n * 12;
  const totalMonth = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(totalMonth / 12);
  const month = ((totalMonth % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** The `k`-th period boundary of a recurrence anchored at `anchor`. */
export function boundary(anchor: Date, recurrence: Recurrence, k: number): Date {
  return addIntervals(anchor, recurrence.interval, k * recurrence.intervalCount);
}

/**
 * The first boundary strictly after `after`. With `anchor > after` that is the
 * anchor itself (a future `billing_cycle_anchor`); otherwise the smallest
 * `anchor + k·interval` past `after`.
 */
export function nextBoundaryAfter(anchor: Date, recurrence: Recurrence, after: Date): Date {
  if (anchor.getTime() > after.getTime()) {
    // The anchor may be several periods ahead; the period containing `after`
    // ends at the first boundary counting BACK from the anchor that is past it.
    let k = 0;
    while (boundary(anchor, recurrence, k - 1).getTime() > after.getTime()) k -= 1;
    return boundary(anchor, recurrence, k);
  }
  // Estimate k from the average unit length, then correct: month lengths vary.
  const unitMs =
    recurrence.interval === 'day'
      ? DAY_MS
      : recurrence.interval === 'week'
        ? 7 * DAY_MS
        : recurrence.interval === 'month'
          ? 30.436875 * DAY_MS
          : 365.2425 * DAY_MS;
  let k = Math.max(
    0,
    Math.floor((after.getTime() - anchor.getTime()) / (unitMs * recurrence.intervalCount)) - 1,
  );
  while (boundary(anchor, recurrence, k).getTime() <= after.getTime()) k += 1;
  while (k > 0 && boundary(anchor, recurrence, k - 1).getTime() > after.getTime()) k -= 1;
  return boundary(anchor, recurrence, k);
}

/**
 * `amount × part / whole`, rounded half away from zero, for a SIGNED amount.
 * `part` is clamped to `[0, whole]`: a proration never exceeds the period.
 */
export function prorate(amount: bigint, partMs: number, wholeMs: number): bigint {
  if (wholeMs <= 0) throw new RangeError('a period has positive length');
  const part = BigInt(Math.max(0, Math.min(partMs, wholeMs)));
  const whole = BigInt(wholeMs);
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const rounded = (2n * magnitude * part + whole) / (2n * whole);
  return negative ? -rounded : rounded;
}

/** `at` plus `days` whole days. */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}
