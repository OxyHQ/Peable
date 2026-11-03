import type { PaymentIntent } from '@peable.to/shared-types';
import { sumBaseUnits } from '../format/money';
import type { CurrencyVolume } from './summary';

/** Midnight (local) of the day `now` falls in, Unix seconds. */
export function startOfDay(now: number): number {
  const date = new Date(now * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export interface WindowVolume {
  /** Gross volume RECEIVED by succeeded payments in the window, per currency, largest count first. */
  volume: CurrencyVolume[];
  /** Succeeded payments in the window. */
  succeeded: number;
  /**
   * Whether the sample reaches back to the window's start. When it does not
   * (the first page is all newer), the figure is a floor, and Home says so.
   */
  covered: boolean;
}

/**
 * Home's tiles: what succeeded payments received since `since`, from the
 * newest-first sample Home already fetched. `complete` is the list's own
 * `has_more: false` — the sample is everything there is.
 */
export function volumeSince(
  intents: readonly PaymentIntent[],
  since: number,
  complete: boolean,
): WindowVolume {
  const amounts = new Map<string, string[]>();
  let succeeded = 0;
  let oldest: number | null = null;
  for (const intent of intents) {
    if (oldest === null || intent.created < oldest) oldest = intent.created;
    if (intent.created < since || intent.status !== 'succeeded') continue;
    succeeded += 1;
    const list = amounts.get(intent.currency) ?? [];
    list.push(intent.amount_received);
    amounts.set(intent.currency, list);
  }
  const volume = [...amounts.entries()]
    .map(([currency, list]) => ({ currency, amount: sumBaseUnits(list), count: list.length }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
  return { volume, succeeded, covered: complete || (oldest !== null && oldest < since) };
}
