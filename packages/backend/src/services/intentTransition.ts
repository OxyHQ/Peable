import { and, eq, isNull } from 'drizzle-orm';
import { faircoinBillingInvoices } from '../db/schema/faircoinBilling';
import { commitTaxTransaction } from './tax/taxService';
/**
 * Advancing an intent, and telling the merchant about it, as ONE commit.
 *
 * This module exists because of the ordering, not because of the convenience.
 * Every path that moves an intent used to update the row and then, separately,
 * try to POST a webhook — so a crash, a deploy or a lost connection between
 * those two steps left the intent settled and the merchant never told, with
 * nothing anywhere recording that an event had been owed. ADR 0001 D7: the
 * state change and its event (`services/events.ts`, ADR 0014 D4) commit
 * together or neither happens.
 *
 * The realtime emit deliberately stays OUTSIDE the transaction and after it. A
 * socket frame is not durable, cannot be rolled back, and must never be sent
 * for a transition that then failed to commit.
 */
import type {
  Charge,
  ConnectedAccount,
  Dispute,
  PaymentIntentStatus,
  Refund,
  WebhookEventPayload,
  WebhookEventType,
} from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import type { DatabaseOrTransaction } from '../db/postgres';
import {
  updateIntentState,
  type IntentStateChange,
  type IntentStateResult,
  type PaymentIntentRow,
} from '../db/payments/paymentIntentRepository';
import { ensureChargeForIntent } from '../db/payments/chargeRepository';
import { emitIntentUpdateToActive } from '../realtime/socket';
import { toPaymentIntentDTO } from '../lib/serialize';
import { recordEvent } from './events';
import { kickWebhookOutbox } from './webhookOutbox';

type IntentEventType = Extract<WebhookEventType, `payment_intent.${string}`>;

/**
 * Which events a row that has just MOVED records (ADR 0019) — Stripe's names,
 * derived from where the intent now stands.
 *
 *  - `requires_payment_method` WITH a `last_payment_error` is a failed attempt
 *    (`payment_failed`); without one it is a fresh start and says nothing.
 *  - `requires_confirmation` says nothing: the merchant is the one to act.
 *  - `requires_capture` is `amount_capturable_updated` — Stripe's name for
 *    "authorized, capture it".
 *  - A FairCoin underpayment is a failed payment AND a cancellation, so it is
 *    both events, in that order.
 *
 * `payment_intent.created` is not here: the create records it
 * (`recordIntentCreated`), whatever status the intent starts in.
 */
export function intentEventsFor(row: PaymentIntentRow): readonly IntentEventType[] {
  switch (row.status) {
    case 'requires_payment_method':
      return row.lastPaymentError !== null ? ['payment_intent.payment_failed'] : [];
    case 'requires_confirmation':
      return [];
    case 'requires_action':
      return ['payment_intent.requires_action'];
    case 'processing':
      return ['payment_intent.processing'];
    case 'requires_capture':
      return ['payment_intent.amount_capturable_updated'];
    case 'succeeded':
      return ['payment_intent.succeeded'];
    case 'canceled':
      return row.cancellationReason === 'underpaid'
        ? ['payment_intent.payment_failed', 'payment_intent.canceled']
        : ['payment_intent.canceled'];
  }
}

/**
 * A FairCoin payment the WATCHER has proven — the full output at the fixed
 * address — locks its FX quote, and its Peable Tax calculation becomes a
 * committed tax transaction, in the caller's transaction. A caller-reported
 * hash (`submit_tx`) is not acceptance; only the watcher's proof is.
 *
 * Idempotent: the update matches only an invoice not yet accepted.
 */
async function acceptVerifiedChainPayment(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
): Promise<void> {
  const accepted = await tx
    .update(faircoinBillingInvoices)
    .set({ acceptedAt: row.updatedAt })
    .where(
      and(
        eq(faircoinBillingInvoices.paymentIntentId, row.id),
        isNull(faircoinBillingInvoices.acceptedAt),
      ),
    )
    .returning({
      id: faircoinBillingInvoices.id,
      taxSnapshot: faircoinBillingInvoices.taxSnapshot,
    });
  for (const invoice of accepted)
    await commitTaxTransaction(tx, {
      calculationPublicId: invoice.taxSnapshot.taxQuote.quote.tax_rate_evidence_id,
      reference: invoice.id,
      rail: 'faircoin',
      committedAt: row.updatedAt,
    });
}

/**
 * The watcher saw a transaction that pays in full and is still confirming — no
 * status change, but the payment is proven. Accepts it in its own transaction.
 */
export async function recordVerifiedChainPayment(row: PaymentIntentRow): Promise<void> {
  if (row.rail !== 'faircoin') return;
  await getDb().transaction((tx) => acceptVerifiedChainPayment(tx, row));
}

/**
 * Apply a state change and record the merchant's events in the same
 * transaction.
 *
 * What commits with the status, beside the events:
 *  - a card intent reaching `requires_capture` or `succeeded` gets its `ch_…`
 *    (`ensureChargeForIntent`), so an intent that reports a charge has one;
 *  - a FairCoin change the watcher proved (`chainVerified`) accepts the
 *    payment's billing invoice.
 *
 * A same-status write (the watcher's confirmation count) records nothing,
 * except a failed card attempt on an intent already in
 * `requires_payment_method` — that is an attempt the merchant is told about.
 *
 * @returns `updated` with the row; `stale` when the intent moved between the
 *   caller's read and this write, carrying the status it moved to; `missing`
 *   when there is no such row. Nothing is recorded unless the row moved.
 */
export async function transitionIntent(
  intentId: string,
  change: IntentStateChange & { readonly chainVerified?: boolean },
): Promise<IntentStateResult> {
  return getDb().transaction(async (tx) => {
    const result = await updateIntentState(tx, intentId, change);
    if (result.kind !== 'updated') return result;
    const row = result.row;
    if (row.rail === 'card' && (row.status === 'requires_capture' || row.status === 'succeeded')) {
      await ensureChargeForIntent(tx, row);
    }
    if (row.rail === 'faircoin' && change.chainVerified === true) {
      await acceptVerifiedChainPayment(tx, row);
    }
    const moved = change.from !== change.status;
    const failedAttempt = change.lastPaymentError !== undefined;
    if (moved || failedAttempt) await recordIntentEvent(tx, row, change.from);
    return result;
  });
}

/**
 * Record the merchant's events for a row that has ALREADY been advanced, on the
 * caller's transaction.
 *
 * Exported because `transitionIntent` is not the only path that moves an
 * intent: the expiry sweeper advances a whole batch in one claiming statement
 * (`expireDueIntents`). What it must not lose is ADR 0001 D7 — the state change
 * and its events commit together — so it takes this and its own `tx`.
 *
 * MUST be called inside the same transaction as the state change.
 */
export async function recordIntentEvent(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  previousStatus?: PaymentIntentStatus,
): Promise<void> {
  const object = toPaymentIntentDTO(row);
  for (const type of intentEventsFor(row)) {
    await recordEvent(tx, {
      merchantId: row.merchantId,
      type,
      object,
      previousAttributes:
        previousStatus !== undefined && previousStatus !== row.status
          ? { status: previousStatus }
          : undefined,
      account: row.connectedAccountPublicId,
      paymentIntentId: row.id,
    });
  }
}

/** `payment_intent.created`, in the transaction that inserted the row. */
export async function recordIntentCreated(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type: 'payment_intent.created',
    object: toPaymentIntentDTO(row),
    account: row.connectedAccountPublicId,
    paymentIntentId: row.id,
  });
}

/**
 * A REFUND event, on the intent it is about, in the caller's transaction — the
 * one that moved the refund row (ADR 0001 D7). Refunds are not PaymentIntent
 * statuses (ADR 0019): the refund carries its own lifecycle.
 */
export async function recordRefundEvent(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  refund: Refund,
  type: 'refund.created' | 'refund.updated' | 'refund.failed',
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type,
    object: refund,
    account: row.connectedAccountPublicId,
    paymentIntentId: row.id,
  });
}

/** `charge.refunded`: the charge whose `amount_refunded` just moved. */
export async function recordChargeEvent(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  charge: Charge,
  type: 'charge.refunded',
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type,
    object: charge,
    account: row.connectedAccountPublicId,
    paymentIntentId: row.id,
  });
}

/**
 * Record a DISPUTE event for the merchant, on the intent it contests.
 *
 * Its own function because a dispute event carries a `Dispute`
 * (`WebhookEventPayload`), and "which resource goes with which event" belongs
 * to the contract rather than to every call site. In the CALLER's transaction
 * (ADR 0001 D7).
 *
 * The intent's own status is deliberately untouched. It stays `succeeded`
 * throughout — a dispute is the network's process, not a stage of the payment's
 * lifecycle — and the status-derived event here would have told the merchant
 * their payment had just succeeded, again, at the exact moment it was being
 * contested.
 */
export async function recordDisputeEvent(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  dispute: Dispute,
  type: 'charge.dispute.created' | 'charge.dispute.updated' | 'charge.dispute.closed',
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type,
    object: dispute,
    account: row.connectedAccountPublicId,
    paymentIntentId: row.id,
  });
}

/**
 * Record a SELLER's readiness change for the merchant who onboarded them, in
 * the CALLER's transaction (ADR 0001 D7). It names no payment intent.
 */
export async function recordConnectedAccountEvent(
  tx: DatabaseOrTransaction,
  merchantId: string,
  account: ConnectedAccount,
  previousAttributes?: Record<string, unknown>,
): Promise<void> {
  await recordEvent(tx, {
    merchantId,
    type: 'connected_account.updated',
    object: account,
    previousAttributes,
    account: account.id,
  });
}

/** The merchant-scoped events about a customer, a saved card or a SetupIntent (ADR 0016). */
export type CustomerObjectEventType = Extract<
  WebhookEventType,
  `customer.${string}` | `payment_method.${string}` | `setup_intent.${string}`
>;

/**
 * Record a customer, payment-method or SetupIntent event, in the CALLER's
 * transaction — the one that wrote the row (ADR 0001 D7). Like
 * `connected_account.updated` it names no payment intent.
 */
export async function recordCustomerObjectEvent<K extends CustomerObjectEventType>(
  tx: DatabaseOrTransaction,
  merchantId: string,
  type: K,
  object: WebhookEventPayload[K],
): Promise<void> {
  await recordEvent(tx, { merchantId, type, object });
}

/**
 * Announce a committed transition on the transports that are not durable.
 *
 * Called AFTER `transitionIntent` returns, never inside it. Both halves are
 * fire-and-forget by design: the socket frame reaches whoever is watching right
 * now, and the outbox kick asks the dispatcher to run its next pass early. If
 * the kick never happens the loop picks the row up on its own — which is
 * exactly why the event had to be in the transaction and this does not.
 */
export function announceIntentChange(intent: PaymentIntentRow): void {
  emitIntentUpdateToActive(intent);
  kickWebhookOutbox();
}
