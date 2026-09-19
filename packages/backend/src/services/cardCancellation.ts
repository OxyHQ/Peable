/**
 * Cancelling a card payment AT THE PROVIDER, before the gateway says it is over.
 *
 * ## The gap this closes
 *
 * `POST /v1/payment_intents/:id/reject` moved the row to `rejected` and emitted
 * the merchant's event, and the expiry sweeper moved a batch to `expired` — and
 * neither told the acquirer anything. The payer's browser still held a live
 * confirmation credential for a PaymentIntent that remained confirmable, so a
 * payment this gateway had announced as cancelled could be completed minutes
 * later. The money would arrive against an intent in a terminal status, the
 * merchant would have already released the order, and the only record that the
 * two disagreed would be a `payment_intent.succeeded` the drain could not
 * apply.
 *
 * ## Why this is a RECONCILIATION and not a cancel call
 *
 * A cancel can lose. The payer may confirm in the same second, and the provider
 * then refuses the cancellation because the payment has already succeeded —
 * which is not a failure, it is the answer. So this reports what is TRUE at the
 * provider after trying, rather than whether the call returned: `settled` means
 * the payer won the race and the caller must not announce a cancellation.
 *
 * Nothing here writes to the database. Deciding what a provider's answer means
 * for an intent belongs to the caller, so "what happens when a cancellation
 * loses" is written where the transition is, not once per call site.
 */
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import {
  isRetryableProviderError,
  ProviderError,
  type PaymentProvider,
  type ProviderPaymentStatus,
} from "./providers/provider";
import { resolveProvider } from "./providers/registry";

export type CardCancellation =
  /** The provider reports the payment cancelled. Nothing can be charged. */
  | { readonly kind: "canceled" }
  /**
   * The payer got there first. The payment SUCCEEDED and no cancellation is
   * possible — the caller must reconcile to settlement rather than announce a
   * cancellation it cannot deliver.
   */
  | { readonly kind: "settled" }
  /**
   * The provider reports the payment still in flight — `processing`, or an SCA
   * challenge the payer is in the middle of. Cancelling would abandon a payment
   * that may be about to succeed, and the provider often refuses it outright.
   */
  | { readonly kind: "in_flight"; readonly status: ProviderPaymentStatus }
  /**
   * There is nothing at a provider to cancel: a FairCoin intent, a card intent
   * whose create never linked, or a deployment with the rail switched off.
   */
  | { readonly kind: "nothing_to_cancel" }
  /**
   * The provider could not be reached, or answered something transient. The
   * caller must NOT announce a cancellation: the payment is still live and its
   * state is unknown.
   */
  | { readonly kind: "unknown"; readonly error: string };

/** Map the provider's vocabulary onto what a cancellation attempt concluded. */
function fromProviderStatus(status: ProviderPaymentStatus): CardCancellation {
  switch (status) {
    case "canceled":
      return { kind: "canceled" };
    case "succeeded":
    case "refunded":
    case "partially_refunded":
      // Refunded means it succeeded and then some came back. Either way the
      // payer paid, which is the fact the caller has to act on.
      return { kind: "settled" };
    case "failed":
      // A declined payment is not cancelled, and treating it as cancelled would
      // let a caller announce a cancellation for a payment the payer can still
      // retry on the same object.
      return { kind: "in_flight", status };
    case "created":
    case "requires_action":
    case "processing":
      return { kind: "in_flight", status };
  }
}

/**
 * Try to cancel this payment, and report what is true afterwards.
 *
 * @param idempotencyKey derived from a durable gateway id by the caller, so a
 *   retry after a lost response is the same operation rather than a second one.
 */
export async function cancelCardPaymentAtProvider(
  intent: PaymentIntentRow,
  idempotencyKey: string,
): Promise<CardCancellation> {
  if (!intent.provider || !intent.providerObjectId) return { kind: "nothing_to_cancel" };
  const provider = resolveProvider(intent.provider);
  if (!provider) return { kind: "nothing_to_cancel" };

  try {
    const result = await provider.cancel({
      intentId: intent.publicId,
      providerObjectId: intent.providerObjectId,
      idempotencyKey,
    });
    return fromProviderStatus(result.status);
  } catch (error) {
    /**
     * A PERMANENT refusal is usually an answer, not a fault.
     *
     * "You cannot cancel this PaymentIntent because it has a status of
     * succeeded" and "…of canceled" both arrive as an invalid-request error,
     * and the two mean opposite things. Neither is readable from the message
     * without parsing provider prose, so the state is READ instead.
     */
    if (!isRetryableProviderError(error)) {
      return readCurrentState(provider, intent, error);
    }
    return {
      kind: "unknown",
      error: error instanceof Error ? error.message : "the provider could not be reached",
    };
  }
}

/** What the provider says now, after it refused to cancel. */
async function readCurrentState(
  provider: PaymentProvider,
  intent: PaymentIntentRow,
  cause: unknown,
): Promise<CardCancellation> {
  try {
    const current = await provider.getStatus(intent.providerObjectId ?? "");
    return fromProviderStatus(current.status);
  } catch (error) {
    // The refusal and the re-read both failed. The FIRST error is the useful
    // one — it is what the provider said about the operation that was actually
    // attempted — and the second is almost always the same fault repeated.
    return {
      kind: "unknown",
      error:
        cause instanceof ProviderError
          ? cause.message
          : error instanceof Error
            ? error.message
            : "the payment's state could not be established",
    };
  }
}
