import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { sumBaseUnits } from '../format/money';

/** The gateway is still waiting on the payer, the network or the merchant (`canStillBePaid`). */
const OPEN: ReadonlySet<PaymentIntentStatus> = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
]);

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
  /** Canceled: expired unpaid, underpaid, or canceled by the merchant or the provider. */
  unsuccessful: number;
  /** Payments with any money refunded (`amount_refunded` above zero). */
  refunded: number;
  /** Gross volume RECEIVED by succeeded payments, per currency (refunds not netted). */
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
    if (intent.status === 'succeeded') {
      succeeded += 1;
      // What was received — a partial capture takes less than the amount.
      const list = amounts.get(intent.currency) ?? [];
      list.push(intent.amount_received);
      amounts.set(intent.currency, list);
    }
    // A refund is an amount, not a status (ADR 0019): any money back counts.
    if (intent.amount_refunded !== '0') refunded += 1;
    if (OPEN.has(intent.status)) open += 1;
    if (intent.status === 'canceled') unsuccessful += 1;
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
