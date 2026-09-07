/**
 * Advancing an intent, and telling the merchant about it, as ONE commit.
 *
 * This module exists because of the ordering, not because of the convenience.
 * Every path that moves an intent used to update the row and then, separately,
 * try to POST a webhook — so a crash, a deploy or a lost connection between
 * those two steps left the intent settled and the merchant never told, with
 * nothing anywhere recording that an event had been owed. ADR 0001 D7: the
 * state change and the outbox row commit together or neither happens.
 *
 * The realtime emit deliberately stays OUTSIDE the transaction and after it. A
 * socket frame is not durable, cannot be rolled back, and must never be sent
 * for a transition that then failed to commit.
 */
import type {
  Dispute,
  PaymentIntentStatus,
  WebhookEvent,
  WebhookEventType,
} from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import type { DatabaseOrTransaction } from "../db/postgres";
import { findWebhookTarget } from "../db/merchants/merchantRepository";
import {
  updateIntentState,
  type IntentStateChange,
  type PaymentIntentRow,
} from "../db/payments/paymentIntentRepository";
import { enqueueWebhook } from "../db/webhooks/webhookOutboxRepository";
import { emitIntentUpdateToActive } from "../realtime/socket";
import { toPaymentIntentDTO } from "../lib/serialize";
import { buildEvent } from "./webhookDispatcher";
import { kickWebhookOutbox } from "./webhookOutbox";

/**
 * Which statuses a merchant is told about.
 *
 * The pre-payment statuses (`created`, `awaiting_approval`, `approved`,
 * `broadcast`, `requires_action`, `processing`) emit nothing: they describe a
 * payer moving through a flow, and a merchant integrating on Stripe-shaped
 * ergonomics acts on outcomes. Moved here from `server.ts` because the outbox
 * write is now part of the transition rather than part of the server's fan-out.
 */
export const WEBHOOK_EVENT_FOR: Partial<
  Record<PaymentIntentStatus, WebhookEventType>
> = {
  confirming: "payment_intent.confirming",
  settled: "payment_intent.settled",
  failed: "payment_intent.failed",
  rejected: "payment_intent.rejected",
  expired: "payment_intent.expired",
  // A refund is an OUTCOME, which is the line this map draws: the pre-payment
  // statuses describe a payer moving through a flow and emit nothing, while
  // money leaving again is something a merchant acts on.
  refunded: "payment_intent.refunded",
  partially_refunded: "payment_intent.partially_refunded",
};

/**
 * Apply a state change and enqueue the merchant's event in the same
 * transaction.
 *
 * @returns the updated row, or `null` when no row matched — which is not an
 *   error: a row that vanished between a poll and this update is the settlement
 *   watcher's ordinary race, and the caller decides what that means.
 */
export async function transitionIntent(
  intentId: string,
  change: IntentStateChange,
): Promise<PaymentIntentRow | null> {
  return getDb().transaction(async (tx) => {
    const row = await updateIntentState(tx, intentId, change);
    if (!row) return null;
    await enqueueIntentWebhook(tx, row);
    return row;
  });
}

/**
 * Enqueue the merchant's event for a row that has ALREADY been advanced, on the
 * caller's transaction.
 *
 * Exported because `transitionIntent` is no longer the only path that moves an
 * intent: the expiry sweeper advances a whole batch in one claiming statement
 * (`expireDueIntents`) and cannot go through the one-row-at-a-time transition.
 * What it must not lose is the property that makes ADR 0001 D7 true — the state
 * change and the outbox row commit together — so it takes this helper and its
 * own `tx` rather than growing a third copy of the enqueue.
 *
 * MUST be called inside the same transaction as the state change. Called after
 * a commit it becomes the best-effort delivery the outbox exists to replace.
 */
export async function enqueueIntentWebhook(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
): Promise<void> {
  const eventType = WEBHOOK_EVENT_FOR[row.status];
  if (eventType === undefined) return;
  await enqueue(tx, row, buildEvent(eventType, toPaymentIntentDTO(row)));
}

/**
 * Enqueue a DISPUTE event for the merchant, on the intent it contests.
 *
 * Its own function rather than an `eventType` option on the one above, and the
 * reason is the payload rather than the name. A dispute event carries a
 * `Dispute` (`WebhookEventPayload`), so a shared function would have to take
 * the resource as a parameter too — and then "which resource goes with which
 * event" would be the caller's problem at every call site instead of the
 * contract's.
 *
 * Two things stay true from the intent path and are why this still takes the
 * row: the delivery is keyed to the payment being contested, so a merchant can
 * correlate it, and the enqueue is in the CALLER's transaction (ADR 0001 D7).
 *
 * The intent's own status is deliberately untouched. It stayed `settled`
 * throughout — a dispute is the network's process, not a stage of the payment's
 * lifecycle — and emitting the status-derived event here would have told the
 * merchant their payment had just succeeded, again, at the exact moment it was
 * being contested.
 */
export async function enqueueDisputeWebhook(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  dispute: Dispute,
  eventType: 'payment_intent.disputed' | 'payment_intent.dispute_closed',
): Promise<void> {
  await enqueue(tx, row, buildEvent(eventType, dispute));
}

/**
 * The shared half: find the merchant's endpoint and write the outbox row.
 *
 * The one read allowed to select `webhook_secret`. Only the URL is used here —
 * the secret is re-read at attempt time, so a merchant who rotates it
 * mid-backoff has their retries signed with the new one.
 *
 * A merchant with no endpoint enqueues NOTHING, which is not a silent drop: an
 * outbox row for an endpoint that does not exist would retry to exhaustion and
 * dead-letter, filling an operator surface with deliveries nobody ever asked
 * for.
 */
async function enqueue(
  tx: DatabaseOrTransaction,
  row: PaymentIntentRow,
  event: WebhookEvent,
): Promise<void> {
  const target = await findWebhookTarget(tx, row.merchantId);
  if (!target) return;

  await enqueueWebhook(tx, {
    merchantId: row.merchantId,
    paymentIntentId: row.id,
    event,
    url: target.url,
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
 * - the outbox kick just asks the dispatcher to run its next pass early, so a
 *   merchant does not wait a poll interval for an event that is already
 *   durably enqueued. If the kick never happens, the loop picks the row up on
 *   its own — which is exactly why the enqueue had to be in the transaction and
 *   this does not.
 */
export function announceIntentChange(intent: PaymentIntentRow): void {
  emitIntentUpdateToActive(intent);
  kickWebhookOutbox();
}
