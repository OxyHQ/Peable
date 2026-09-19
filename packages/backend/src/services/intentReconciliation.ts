/**
 * Making a card intent agree with the provider, when the two have diverged.
 *
 * ## What diverges, and why re-reading is the only answer
 *
 * The drain turns a stored event into a transition over the status it reads
 * from the row. That is correct when events arrive in order and is not
 * otherwise, and out of order is ordinary: the provider acknowledges receipt
 * before processing, so it redelivers; an endpoint that was briefly unreachable
 * gets a burst; a `payment_failed` for an attempt the payer abandoned can land
 * after the `succeeded` of the attempt they completed.
 *
 * Applied naively, those produce two failures in opposite directions. A stale
 * `payment_failed` after a success would DEGRADE a settled payment — which the
 * state machine refuses, correctly, by throwing. And an event the machine
 * refuses is recorded as a processing FAILURE and retried forever, so one stale
 * delivery pins a row in the drain and reads like a broken handler.
 *
 * The resolution for both is the same and it is not a rule about ordering: ask
 * the provider what is true NOW. The event says something changed; only a fresh
 * read says what.
 */
import type { PaymentIntentStatus } from "@peable.to/shared-types";
import {
  findIntentById,
  type PaymentIntentRow,
} from "../db/payments/paymentIntentRepository";
import { getDb } from "../db/postgres";
import { applyEvent, type IntentEvent } from "./intentState";
import { announceIntentChange, transitionIntent } from "./intentTransition";
import type { ProviderPaymentStatus } from "./providers/provider";
import { resolveProvider } from "./providers/registry";

/**
 * Which card event a provider's own status means.
 *
 * `null` for a status that says nothing about the intent's lifecycle:
 * `created` is where a payment sits before the payer acts, and
 * `refunded`/`partially_refunded` are decided by the refund ROWS, never by a
 * payment read — the sum of succeeded refunds is the authority there, and a
 * status read would be a second one.
 */
function eventForProviderStatus(status: ProviderPaymentStatus): IntentEvent | null {
  switch (status) {
    case "succeeded":
      return "card_settled";
    case "failed":
      return "card_failed";
    case "canceled":
      return "card_canceled";
    case "processing":
      return "card_processing";
    case "requires_action":
      return "card_requires_action";
    case "created":
    case "refunded":
    case "partially_refunded":
      return null;
  }
}

export type ReconcileOutcome =
  /** The row moved to match the provider. */
  | { readonly kind: "applied"; readonly status: PaymentIntentStatus }
  /** The provider agrees with the row, or says nothing that changes it. */
  | { readonly kind: "agreed"; readonly status: PaymentIntentStatus }
  /** There is no provider object to read — a FairCoin intent, or an unlinked one. */
  | { readonly kind: "unreadable" }
  /** The provider's truth is not a legal move from where the row stands. */
  | { readonly kind: "irreconcilable"; readonly error: string };

/**
 * Re-read a card payment and move the row to whatever the provider says.
 *
 * Never throws: every caller is either an HTTP handler or the drain, and both
 * need the outcome as a value. `irreconcilable` is the honest answer for a
 * disagreement no transition can express — a settled payment the provider now
 * calls cancelled, say — and it is left for an operator rather than forced.
 */
export async function reconcileIntentWithProvider(
  intent: PaymentIntentRow,
): Promise<ReconcileOutcome> {
  if (!intent.provider || !intent.providerObjectId) return { kind: "unreadable" };
  const provider = resolveProvider(intent.provider);
  if (!provider) return { kind: "unreadable" };

  let current;
  try {
    current = await provider.getStatus(intent.providerObjectId);
  } catch (error) {
    return {
      kind: "irreconcilable",
      error: error instanceof Error ? error.message : "the payment could not be read",
    };
  }

  // Re-read the ROW too. The provider call is a network round trip, and the
  // drain, the expiry sweeper and a merchant request all reach here — the
  // status this decision is made from must be the one that was true when the
  // write is attempted, and `transitionIntent`'s compare-and-swap is what
  // enforces that.
  const fresh = (await findIntentById(getDb(), intent.id)) ?? intent;

  const event = eventForProviderStatus(current.status);
  if (!event) return { kind: "agreed", status: fresh.status };

  let target: PaymentIntentStatus;
  try {
    target = applyEvent(fresh.status, event);
  } catch (error) {
    return {
      kind: "irreconcilable",
      error: error instanceof Error ? error.message : "the provider's state is not reachable",
    };
  }
  if (target === fresh.status) return { kind: "agreed", status: fresh.status };

  const result = await transitionIntent(fresh.id, { from: fresh.status, status: target });
  if (result.kind !== "updated") {
    // Something else moved the row between the read and the write. Not an
    // error: the next pass reads the new status and either agrees with it or
    // reconciles from there.
    return { kind: "agreed", status: fresh.status };
  }
  announceIntentChange(result.row);
  return { kind: "applied", status: result.row.status };
}
