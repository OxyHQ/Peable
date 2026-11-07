/**
 * One transition function per object (ADR 0018 §4): every status change of a
 * subscription or an invoice goes through {@link transitionSubscription} or
 * {@link transitionInvoice}, which
 *
 *  1. refuse a move the state machine does not allow,
 *  2. write the row with a compare-and-swap on the status the caller READ —
 *     a writer that lost a race gets {@link StaleTransitionError}, never a
 *     silent overwrite — and
 *  3. record the event (ADR 0014 D4), which enqueues its webhooks, on the SAME
 *     transaction.
 *
 * The caller kicks the outbox after the commit.
 */
import type {
  InvoiceStatus,
  QuoteStatus,
  SubscriptionStatus,
  WebhookEventPayload,
  WebhookEventType,
} from '@peable.to/shared-types';
import {
  setInvoiceStatus,
  updateInvoice,
  type InvoicePatch,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import {
  setSubscriptionStatus,
  updateSubscription,
  type SubscriptionPatch,
  type SubscriptionRow,
} from '../../db/billingEngine/subscriptionRepository';
import {
  setQuoteStatus,
  updateQuote,
  type QuotePatch,
  type QuoteRow,
} from '../../db/billingEngine/quoteRepository';
import type { DatabaseOrTransaction, Transaction } from '../../db/postgres';
import { renderInvoice, renderSubscription, toQuoteDTO } from '../../lib/serializeBilling';
import { previousAttributes } from '../catalog/catalogService';
import { recordEvent } from '../events';
import { refreshEntitlementSummary } from './entitlements';
import { invoiceMayMove, quoteMayMove, subscriptionMayMove } from './stateMachines';

/** Another writer moved the row between the caller's read and its write. */
export class StaleTransitionError extends Error {
  constructor(what: string) {
    super(`${what} moved while it was being changed; read it again`);
    this.name = 'StaleTransitionError';
  }
}

export type BillingEventType = Extract<
  WebhookEventType,
  | `customer.subscription.${string}`
  | `invoice.${string}`
  | `invoiceitem.${string}`
  | `credit_note.${string}`
  | `quote.${string}`
  | `test_helpers.${string}`
  | `billing.meter.${string}`
  | `billing_portal.${string}`
  | 'entitlements.active_entitlement_summary.updated'
>;

export async function recordBillingEvent<K extends BillingEventType>(
  tx: DatabaseOrTransaction,
  merchantId: string,
  type: K,
  object: WebhookEventPayload[K],
  previous?: Record<string, unknown> | null,
): Promise<void> {
  await recordEvent(tx, {
    merchantId,
    type,
    object,
    ...(previous ? { previousAttributes: previous } : {}),
  });
}

// ---- Subscriptions -------------------------------------------------------------

/**
 * Move a subscription to `to` (or stay, with only `patch`), recording what the
 * move means: `customer.subscription.deleted` when it ends,
 * `…paused`/`…resumed` around the `paused` status, `…updated` otherwise —
 * nothing when neither the status nor any rendered field moved.
 */
export async function transitionSubscription(
  tx: Transaction,
  row: SubscriptionRow,
  to: SubscriptionStatus,
  patch: SubscriptionPatch = {},
): Promise<SubscriptionRow> {
  if (!subscriptionMayMove(row.status, to)) {
    throw new Error(`a subscription cannot move from ${row.status} to ${to}`);
  }
  const before = await renderSubscription(tx, row);
  const written = await setSubscriptionStatus(tx, row.id, row.status, to, patch);
  if (written === 'stale') throw new StaleTransitionError('the subscription');
  const after = await renderSubscription(tx, written);
  const previous = previousAttributes(before, after);
  if (to !== row.status && (to === 'canceled' || to === 'incomplete_expired')) {
    await recordBillingEvent(tx, row.merchantId, 'customer.subscription.deleted', after, previous);
  } else if (previous !== null) {
    await recordBillingEvent(tx, row.merchantId, 'customer.subscription.updated', after, previous);
    if (to === 'paused' && row.status !== 'paused') {
      await recordBillingEvent(tx, row.merchantId, 'customer.subscription.paused', after);
    }
    if (row.status === 'paused' && to !== 'paused' && to !== 'canceled') {
      await recordBillingEvent(tx, row.merchantId, 'customer.subscription.resumed', after);
    }
  }
  if (to !== row.status)
    await refreshEntitlementSummary(tx, written.merchantId, written.customerId);
  return written;
}

/** A non-status change, recorded as `customer.subscription.updated` when it moved anything. */
export async function patchSubscription(
  tx: Transaction,
  row: SubscriptionRow,
  patch: SubscriptionPatch,
  options: { readonly itemsChanged?: boolean } = {},
): Promise<SubscriptionRow> {
  const before = await renderSubscription(tx, row);
  const written = await updateSubscription(tx, row.id, patch);
  if (written === 'limit_exceeded') throw new MetadataLimitError();
  const after = await renderSubscription(tx, written);
  const previous = previousAttributes(before, after);
  if (previous !== null) {
    await recordBillingEvent(tx, row.merchantId, 'customer.subscription.updated', after, previous);
  }
  if (options.itemsChanged)
    await refreshEntitlementSummary(tx, written.merchantId, written.customerId);
  return written;
}

/** A metadata patch would leave more keys than the limit. */
export class MetadataLimitError extends Error {
  constructor() {
    super('metadata limit exceeded');
    this.name = 'MetadataLimitError';
  }
}

// ---- Invoices ------------------------------------------------------------------

const INVOICE_EVENT: Partial<Record<InvoiceStatus, BillingEventType>> = {
  open: 'invoice.finalized',
  paid: 'invoice.paid',
  void: 'invoice.voided',
  uncollectible: 'invoice.marked_uncollectible',
};

/**
 * Move an invoice to `to`, recording `invoice.finalized` / `.paid` / `.voided`
 * / `.marked_uncollectible` for the status it reached.
 */
export async function transitionInvoice(
  tx: Transaction,
  row: InvoiceRow,
  to: InvoiceStatus,
  patch: InvoicePatch = {},
): Promise<InvoiceRow> {
  if (!invoiceMayMove(row.status, to)) {
    throw new Error(`an invoice cannot move from ${row.status} to ${to}`);
  }
  const before = await renderInvoice(tx, row);
  const written = await setInvoiceStatus(tx, row.id, row.status, to, patch);
  if (written === 'stale') throw new StaleTransitionError('the invoice');
  const after = await renderInvoice(tx, written);
  const type = to !== row.status ? INVOICE_EVENT[to] : undefined;
  const previous = previousAttributes(before, after);
  if (type) await recordBillingEvent(tx, row.merchantId, type, after, previous);
  else if (previous !== null) {
    await recordBillingEvent(tx, row.merchantId, 'invoice.updated', after, previous);
  }
  return written;
}

/** A non-status change of an invoice, recorded as `invoice.updated` when it moved anything. */
export async function patchInvoice(
  tx: Transaction,
  row: InvoiceRow,
  patch: InvoicePatch,
  options: { readonly record?: boolean } = {},
): Promise<InvoiceRow> {
  const before = options.record === false ? null : await renderInvoice(tx, row);
  const written = await updateInvoice(tx, row.id, patch);
  if (written === 'limit_exceeded') throw new MetadataLimitError();
  if (before) {
    const after = await renderInvoice(tx, written);
    const previous = previousAttributes(before, after);
    if (previous !== null) {
      await recordBillingEvent(tx, row.merchantId, 'invoice.updated', after, previous);
    }
  }
  return written;
}

// ---- Quotes --------------------------------------------------------------------

const QUOTE_EVENT: Partial<Record<QuoteStatus, BillingEventType>> = {
  open: 'quote.finalized',
  accepted: 'quote.accepted',
  canceled: 'quote.canceled',
};

/**
 * Move a quote to `to`, recording `quote.finalized` / `.accepted` /
 * `.canceled` for the status it reached. The CAS is on the status the caller
 * READ: a second accept racing the first gets {@link StaleTransitionError}.
 */
export async function transitionQuote(
  tx: Transaction,
  row: QuoteRow,
  to: QuoteStatus,
  patch: QuotePatch = {},
): Promise<QuoteRow> {
  if (!quoteMayMove(row.status, to)) {
    throw new Error(`a quote cannot move from ${row.status} to ${to}`);
  }
  const written = await setQuoteStatus(tx, row.id, row.status, to, patch);
  if (written === 'stale') throw new StaleTransitionError('the quote');
  const type = to !== row.status ? QUOTE_EVENT[to] : undefined;
  if (type) {
    const before = toQuoteDTO(row);
    const after = toQuoteDTO(written);
    await recordBillingEvent(tx, row.merchantId, type, after, previousAttributes(before, after));
  }
  return written;
}

/** A non-status change of a quote (Stripe records no `quote.updated`). */
export async function patchQuote(
  tx: Transaction,
  row: QuoteRow,
  patch: QuotePatch,
): Promise<QuoteRow> {
  const written = await updateQuote(tx, row.id, patch);
  if (written === 'limit_exceeded') throw new MetadataLimitError();
  return written;
}
