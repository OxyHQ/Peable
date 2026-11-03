import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { sumBaseUnits } from '../format/money';

/** Reached settlement: money arrived, whatever has been refunded since. */
const GROSS: ReadonlySet<PaymentIntentStatus> = new Set([
  'settled',
  'partially_refunded',
  'refunded',
]);
/** The gateway is still waiting on the payer or the network (`canStillBePaid`). */
const OPEN: ReadonlySet<PaymentIntentStatus> = new Set([
  'created',
  'awaiting_approval',
  'approved',
  'broadcast',
  'confirming',
  'requires_action',
  'processing',
]);
const UNSUCCESSFUL: ReadonlySet<PaymentIntentStatus> = new Set(['failed', 'rejected', 'expired']);

export interface CurrencyVolume {
  currency: string;
  /** Base units, exact. */
  amount: string;
  count: number;
}

/**
 * Counts and volume over a SAMPLE of payments — the first pages of the list,
 * newest first. It is a client-side view of what was fetched, not a report:
 * `sampleSize`, `oldest` and `complete` exist so the screen can say exactly
 * what it covers.
 */
export interface PaymentSummary {
  sampleSize: number;
  /** `created` of the oldest payment in the sample, Unix seconds. */
  oldest: number | null;
  newest: number | null;
  /** True when the sample is every payment there is (the last page said `has_more: false`). */
  complete: boolean;
  succeeded: number;
  open: number;
  unsuccessful: number;
  refunded: number;
  /** Gross volume of payments that reached settlement, per currency (refunds not netted). */
  volume: CurrencyVolume[];
}

export function summarizePayments(
  intents: readonly PaymentIntent[],
  complete: boolean,
): PaymentSummary {
  const amounts = new Map<string, string[]>();
  let succeeded = 0;
  let open = 0;
  let unsuccessful = 0;
  let refunded = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const intent of intents) {
    if (oldest === null || intent.created < oldest) oldest = intent.created;
    if (newest === null || intent.created > newest) newest = intent.created;
    if (GROSS.has(intent.status)) {
      succeeded += 1;
      const list = amounts.get(intent.currency) ?? [];
      list.push(intent.amount);
      amounts.set(intent.currency, list);
    }
    if (intent.status === 'refunded' || intent.status === 'partially_refunded') refunded += 1;
    if (OPEN.has(intent.status)) open += 1;
    if (UNSUCCESSFUL.has(intent.status)) unsuccessful += 1;
  }

  const volume = [...amounts.entries()]
    .map(([currency, list]) => ({ currency, amount: sumBaseUnits(list), count: list.length }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    sampleSize: intents.length,
    oldest,
    newest,
    complete,
    succeeded,
    open,
    unsuccessful,
    refunded,
    volume,
  };
}
