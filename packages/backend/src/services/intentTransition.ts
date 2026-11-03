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
 * state change and the event (with its deliveries) commit together or neither happens.
 *
 * The realtime emit deliberately stays OUTSIDE the transaction and after it. A
 * socket frame is not durable, cannot be rolled back, and must never be sent
 * for a transition that then failed to commit.
 */
import type {
  ConnectedAccount,
  Dispute,
  PaymentIntentStatus,
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
import { emitIntentUpdateToActive } from '../realtime/socket';
import { toPaymentIntentDTO } from '../lib/serialize';
import { recordEvent } from './events';
import { kickWebhookOutbox } from './webhookOutbox';

/**
 * Which statuses a merchant is told about.
 *
 * The pre-payment statuses (`created`, `awaiting_approval`, `approved`,
 * `broadcast`, `requires_action`, `processing`) emit nothing: they describe a
 * payer moving through a flow, and a merchant integrating on Stripe-shaped
 * ergonomics acts on outcomes. Moved here from `server.ts` because the outbox
 * write is now part of the transition rather than part of the server's fan-out.
 */
export const WEBHOOK_EVENT_FOR: Partial<Record<PaymentIntentStatus, WebhookEventType>> = {
  confirming: 'payment_intent.confirming',
  settled: 'payment_intent.settled',
  failed: 'payment_intent.failed',
  rejected: 'payment_intent.rejected',
  expired: 'payment_intent.expired',
  // A refund is an OUTCOME, which is the line this map draws: the pre-payment
  // statuses describe a payer moving through a flow and emit nothing, while
  // money leaving again is something a merchant acts on.
  refunded: 'payment_intent.refunded',
  partially_refunded: 'payment_intent.partially_refunded',
};

/**
 * Apply a state change and enqueue the merchant's event in the same
 * transaction.
 *
 * @returns `updated` with the row; `stale` when the intent moved between the
 *   caller's read and this write, carrying the status it moved to; `missing`
 *   when there is no such row. Neither failure is an error on its own — a
 *   settlement poll racing the expiry sweeper is ordinary — but they mean
 *   different things to different callers, which is why they are told apart.
 *   Nothing is enqueued unless the row actually moved.
 */
export async function transitionIntent(
  intentId: string,
  change: IntentStateChange,
): Promise<IntentStateResult> {
  return getDb().transaction(async (tx) => {
    const result = await updateIntentState(tx, intentId, change);
    if (result.kind !== 'updated') return result;
    // A caller-reported hash is not acceptance of the FX quote. Only the
    // watcher proving the full output at the fixed address may lock it.
    if (
      result.row.rail === 'faircoin' &&
      (change.status === 'confirming' || change.status === 'settled')
    ) {
      const accepted = await tx
        .update(faircoinBillingInvoices)
        .set({ acceptedAt: result.row.updatedAt })
        .where(
          and(
            eq(faircoinBillingInvoices.paymentIntentId, intentId),
            isNull(faircoinBillingInvoices.acceptedAt),
          ),
        )
        .returning({
          id: faircoinBillingInvoices.id,
          taxSnapshot: faircoinBillingInvoices.taxSnapshot,
        });
      // The accepted payment's Peable Tax calculation becomes a committed tax
      // transaction in the same transaction: no filing can miss a paid sale.
      for (const invoice of accepted)
        await commitTaxTransaction(tx, {
          calculationPublicId: invoice.taxSnapshot.taxQuote.quote.tax_rate_evidence_id,
          reference: invoice.id,
          rail: 'faircoin',
          committedAt: result.row.updatedAt,
        });
    }
    await recordIntentEvent(tx, result.row, change.from);
    return result;
  });
}

/**
 * Record the merchant's event for a row that has ALREADY been advanced, on the
 * caller's transaction.
 *
 * Exported because `transitionIntent` is not the only path that moves an
 * intent: the expiry sweeper advances a whole batch in one claiming statement
 * (`expireDueIntents`) and cannot go through the one-row-at-a-time transition.
 * What it must not lose is the property that makes ADR 0001 D7 true — the state
 * change and the event commit together — so it takes this helper and its own
 * `tx` rather than growing a second copy of the write.
 *
 * `previousStatus` is the status the row moved FROM, when the caller knows it;
 * it becomes `data.previous_attributes.status`.
 *
 * MUST be called inside the same transaction as the state change.
 */
export async function recordIntentEvent(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  previousStatus?: PaymentIntentStatus,
): Promise<void> {
  const type = WEBHOOK_EVENT_FOR[row.status];
  if (type === undefined) return;
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type,
    object: toPaymentIntentDTO(row),
    previousAttributes:
      previousStatus !== undefined && previousStatus !== row.status
        ? { status: previousStatus }
        : undefined,
    account: row.connectedAccountPublicId,
    paymentIntentId: row.id,
  });
}

/**
 * Record a DISPUTE event, on the intent it contests.
 *
 * Its own function rather than an option on the one above because of the
 * payload: a dispute event carries a `Dispute` (`WebhookEventPayload`). The
 * event names the payment being contested, so a merchant can correlate it, and
 * is written in the CALLER's transaction (ADR 0001 D7).
 *
 * The intent's own status is deliberately untouched: a dispute is the
 * network's process, not a stage of the payment's lifecycle.
 */
export async function recordDisputeEvent(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  dispute: Dispute,
  type: 'payment_intent.disputed' | 'payment_intent.dispute_closed',
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
 * Record a SELLER's readiness change for the merchant who onboarded them —
 * an event about a seller, so it names no payment.
 *
 * In the CALLER's transaction (ADR 0001 D7): the snapshot and the event commit
 * together, or a crash between them leaves an account whose readiness changed
 * and a merchant who will never be told — the next refresh sees no change, so
 * nothing would ever record it again.
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

/**
 * Announce a committed transition on the transports that are not durable.
 *
 * Called AFTER `transitionIntent` returns, never inside it. Both halves are
 * fire-and-forget by design:
 *
 * - the socket frame reaches whoever is watching right now, and nobody
 *   watching is not a failure;
 * - the outbox kick just asks the dispatcher to run its next pass early. If it
 *   never happens, the loop picks the rows up on its own — which is exactly why
 *   the event had to be written in the transaction and this does not.
 */
export function announceIntentChange(intent: PaymentIntentRow): void {
  emitIntentUpdateToActive(intent);
  kickWebhookOutbox();
}
