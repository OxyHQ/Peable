import type {
  Invoice,
  InvoiceStatus,
  Subscription,
  SubscriptionStatus,
} from '@peable.to/shared-types';
import type { StatusTone } from '../payments/status';

/**
 * The billing engine's statuses (ADR 0018), restated from `shared-types`
 * (whose root barrel a browser bundle must not load, see `format/money.ts`);
 * `status.test.ts` pins both lists to `SUBSCRIPTION_STATUSES` and
 * `INVOICE_STATUSES`.
 */
export const ORBIT_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
];

export const ORBIT_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'draft',
  'open',
  'paid',
  'void',
  'uncollectible',
];

const SUBSCRIPTION_TONES: Record<SubscriptionStatus, StatusTone> = {
  incomplete: 'warning',
  incomplete_expired: 'neutral',
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  unpaid: 'danger',
  canceled: 'neutral',
  paused: 'neutral',
};

const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, string> = {
  incomplete: 'Incomplete',
  incomplete_expired: 'Expired unpaid',
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  unpaid: 'Unpaid',
  canceled: 'Canceled',
  paused: 'Paused',
};

export function subscriptionStatusTone(status: SubscriptionStatus): StatusTone {
  return SUBSCRIPTION_TONES[status] ?? 'neutral';
}

export function subscriptionStatusLabel(status: SubscriptionStatus): string {
  return SUBSCRIPTION_LABELS[status] ?? status;
}

const INVOICE_TONES: Record<InvoiceStatus, StatusTone> = {
  draft: 'neutral',
  open: 'info',
  paid: 'success',
  void: 'neutral',
  uncollectible: 'danger',
};

const INVOICE_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  paid: 'Paid',
  void: 'Void',
  uncollectible: 'Uncollectible',
};

export function invoiceStatusTone(status: InvoiceStatus): StatusTone {
  return INVOICE_TONES[status] ?? 'neutral';
}

export function invoiceStatusLabel(status: InvoiceStatus): string {
  return INVOICE_LABELS[status] ?? status;
}

export type InvoiceAction = 'finalize' | 'send' | 'void' | 'mark_uncollectible';

/**
 * What the gateway accepts from where the invoice stands — the buttons a
 * detail offers. A draft is finalized; an open invoice can be voided, marked
 * uncollectible, and (a `send_invoice` one) emailed; an uncollectible one can
 * still be voided. Anything else would only earn a 400.
 */
export function invoiceActions(
  invoice: Pick<Invoice, 'status' | 'collection_method' | 'amount_paid'>,
): InvoiceAction[] {
  switch (invoice.status) {
    case 'draft':
      return ['finalize'];
    case 'open': {
      const actions: InvoiceAction[] = [];
      if (invoice.collection_method === 'send_invoice') actions.push('send');
      if (invoice.amount_paid === '0') actions.push('void');
      actions.push('mark_uncollectible');
      return actions;
    }
    case 'uncollectible':
      return invoice.amount_paid === '0' ? ['void'] : [];
    default:
      return [];
  }
}

/** A subscription that has ended (nothing can change it any more). */
export function subscriptionEnded(status: SubscriptionStatus): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

export type SubscriptionAction =
  | 'cancel_at_period_end'
  | 'keep'
  | 'cancel_now'
  | 'pause_collection'
  | 'resume_collection'
  | 'resume';

/** The actions a subscription detail offers from where it stands. */
export function subscriptionActions(
  subscription: Pick<Subscription, 'status' | 'cancel_at_period_end' | 'pause_collection'>,
): SubscriptionAction[] {
  if (subscriptionEnded(subscription.status)) return [];
  if (subscription.status === 'paused') return ['resume', 'cancel_now'];
  const actions: SubscriptionAction[] = [
    subscription.cancel_at_period_end ? 'keep' : 'cancel_at_period_end',
  ];
  actions.push(subscription.pause_collection ? 'resume_collection' : 'pause_collection');
  actions.push('cancel_now');
  return actions;
}
