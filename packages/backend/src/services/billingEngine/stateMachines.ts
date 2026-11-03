/**
 * The billing engine's two state machines (ADR 0018 §4) — which status may
 * follow which. Pure tables; the writes that enforce them are
 * `transitionSubscription` and `transitionInvoice`, each a compare-and-swap on
 * the source status, so a table entry is a permission and the CAS is what
 * makes two racing writers agree on who won.
 */
import type { InvoiceStatus, SubscriptionStatus } from '@peable.to/shared-types';

const SUBSCRIPTION_ALLOWED: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  incomplete: ['active', 'incomplete_expired', 'canceled'],
  incomplete_expired: [],
  trialing: ['active', 'past_due', 'paused', 'canceled'],
  active: ['past_due', 'unpaid', 'canceled'],
  past_due: ['active', 'unpaid', 'canceled'],
  unpaid: ['active', 'canceled'],
  paused: ['active', 'canceled'],
  canceled: [],
};

export function subscriptionMayMove(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return from === to || SUBSCRIPTION_ALLOWED[from].includes(to);
}

export const TERMINAL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'canceled',
  'incomplete_expired',
];

export function subscriptionIsTerminal(status: SubscriptionStatus): boolean {
  return TERMINAL_SUBSCRIPTION_STATUSES.includes(status);
}

const INVOICE_ALLOWED: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['open'],
  open: ['paid', 'void', 'uncollectible'],
  uncollectible: ['paid', 'void'],
  paid: [],
  void: [],
};

export function invoiceMayMove(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return from === to || INVOICE_ALLOWED[from].includes(to);
}

/** Statuses an invoice can still be paid from. */
export const PAYABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = ['open', 'uncollectible'];
