/**
 * Sending money back to a payer.
 *
 * The whole service turns on one arithmetic question — how much of this payment
 * has ALREADY gone back — and on getting it from the one place that knows: the
 * sum of succeeded refund rows. A stored total on the payment would be a second
 * home for the same fact, and the two disagree the first time a write is lost.
 */
import type { CurrencyCode, MerchantEnvironment } from "@peable.to/shared-types";
import {
  findRefundByExternalRef,
  insertRefund,
  linkRefundObject,
  markRefundFailed,
  markRefundSucceeded,
  sumCommittedRefunds,
  sumSucceededRefunds,
  type RefundRow,
} from "../../db/refunds/refundRepository";
import type { PaymentIntentRow } from "../../db/payments/paymentIntentRepository";
import { getDb } from "../../db/postgres";
import { newId } from "../../lib/ids";
import { applyEvent } from "../intentState";
import { announceIntentChange, transitionIntent } from "../intentTransition";
import { assertEnvironmentMatchesProvider } from "../providers/environmentGuard";
import { ProviderError, type PaymentProvider } from "../providers/provider";
import { redactProviderMessage } from "../providers/redact";
import { resolveProvider } from "../providers/registry";

/** The payment cannot be refunded from where it stands. */
export class PaymentNotRefundableError extends Error {
  constructor(status: string) {
    super(`a refund needs a settled payment; this one is '${status}'`);
    this.name = "PaymentNotRefundableError";
  }
}

/** More was asked for than the payment has left. */
export class RefundExceedsRemainingError extends Error {
  constructor(requested: string, remaining: string) {
    super(`a refund of ${requested} exceeds the ${remaining} still refundable on this payment`);
    this.name = "RefundExceedsRemainingError";
  }
}

/** The rail cannot refund — true of the chain rail, whose money it never held. */
export class RefundsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundsUnavailableError";
  }
}

export interface CreateRefundInput {
  readonly merchantId: string;
  /**
   * The environment of the credential asking. Checked against the provider's
   * mode before anything is sent — separating merchant ROWS by environment does
   * not stop a development credential reaching a live key.
   */
  readonly environment: MerchantEnvironment;
  readonly intent: PaymentIntentRow;
  /** The MERCHANT's own id for this refund. The idempotency. */
  readonly externalRef: string;
  readonly amount: string;
}

export interface CreateRefundResult {
  readonly refund: RefundRow;
  /** `false` when this refund had already been made. */
  readonly created: boolean;
  /** Where the PAYMENT stands after it. */
  readonly paymentStatus: string;
}

/**
 * How much of a payment can still go back.
 *
 * Counts PENDING refunds as well as succeeded ones, and that is the budget
 * rather than the history. A refund sitting `pending` at the provider will most
 * likely land; two concurrent refunds that each read only the succeeded total
 * would both pass a check only one of them should, and the payer would be sent
 * more than they paid — which nothing reverses automatically and which they
 * have no reason to report. A `failed` refund moved nothing and is excluded, so
 * a refusal never becomes permanent.
 *
 * The PAYMENT's own status is still derived from `sumSucceededRefunds` — money
 * that actually moved. The two questions are different and both get asked.
 *
 * `BigInt`, not `Number`: these are unbounded canonical integer strings, and a
 * float comparison starts rounding above `Number.MAX_SAFE_INTEGER` — which is
 * reachable in a minor-unit currency and is exactly where letting one unit
 * through matters most.
 */
export async function remainingRefundable(intent: PaymentIntentRow): Promise<string> {
  const committed = await sumCommittedRefunds(getDb(), intent.id);
  const remaining = BigInt(intent.amount) - BigInt(committed);
  return (remaining > 0n ? remaining : 0n).toString();
}

function requireRefundProvider(intent: PaymentIntentRow): PaymentProvider {
  if (!intent.provider || !intent.providerObjectId) {
    // A settled payment with no provider object is a FairCoin payment. This
    // gateway never held those funds, so it has nothing to send back — not a
    // gap, a different rail.
    throw new RefundsUnavailableError(
      "this payment did not settle through a provider this gateway can refund from",
    );
  }
  const provider = resolveProvider(intent.provider);
  if (!provider) {
    throw new RefundsUnavailableError(
      `the ${intent.provider} rail is not configured on this deployment`,
    );
  }
  return provider;
}

/**
 * Refund part or all of a payment.
 *
 * Row first, provider second — the same two-step every money movement here
 * uses. A crash between them leaves a row that says an attempt was made, which
 * recovery can finish with the same idempotency key; the reverse leaves a payer
 * refunded with nothing recording it.
 */
export async function createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
  const { intent } = input;
  // FIRST, before the payment's own state is examined. This is an
  // authorization decision, and a wrong-mode credential must not be able to
  // learn whether a payment is settled by reading which refusal it gets.
  assertEnvironmentMatchesProvider(input.environment);
  if (intent.status !== "settled" && intent.status !== "partially_refunded") {
    throw new PaymentNotRefundableError(intent.status);
  }
  const provider = requireRefundProvider(intent);
  const db = getDb();

  const remaining = await remainingRefundable(intent);
  if (BigInt(input.amount) > BigInt(remaining)) {
    throw new RefundExceedsRemainingError(input.amount, remaining);
  }

  const inserted = await insertRefund(db, {
    publicId: newId("re"),
    merchantId: input.merchantId,
    paymentIntentId: intent.id,
    externalRef: input.externalRef,
    amount: input.amount,
    currency: intent.currency,
    provider: provider.id,
  });

  if (!inserted) {
    const existing = await findRefundByExternalRef(db, input.merchantId, input.externalRef);
    if (!existing) throw new Error(`refund ${input.externalRef} neither inserted nor found`);
    return { refund: existing, created: false, paymentStatus: intent.status };
  }

  let settled: RefundRow;
  let moved = false;
  try {
    const result = await provider.refund({
      intentId: intent.publicId,
      providerObjectId: intent.providerObjectId ?? "",
      refundId: inserted.publicId,
      amount: { amount: input.amount, currency: intent.currency as CurrencyCode },
      idempotencyKey: `re:${inserted.publicId}`,
      metadata: { peable_refund_id: inserted.publicId },
    });

    /**
     * The provider's own answer about THIS refund decides the row — not the
     * fact that a call returned.
     *
     * This used to call `markRefundSucceeded` unconditionally, ignoring
     * `result.state`, which the adapter has always reported. A refund the
     * provider called `pending` was stored as `succeeded`, counted toward the
     * payment's refunded total and moved the payment to `refunded`; one that
     * then FAILED left a payment permanently claiming money had gone back that
     * never did, discoverable only in the merchant's own reconciliation.
     * Stripe is explicit that refunds can be pending and can fail — a bank can
     * reject one days later.
     *
     * All three branches record the provider's id, and that is not
     * bookkeeping: it is the only handle a later `refund.updated` can be
     * matched on (`refunds_provider_object_key`), so a pending refund with no
     * id stored is one whose eventual outcome arrives as `unmatched`.
     */
    if (result.state === "succeeded") {
      settled = (await markRefundSucceeded(db, inserted.id, result.providerObjectId)) ?? inserted;
      moved = true;
    } else if (result.state === "failed") {
      settled =
        (await markRefundFailed(
          db,
          inserted.id,
          result.failureCode ?? "the provider refused the refund",
          result.providerObjectId,
        )) ?? inserted;
    } else {
      // PENDING. The object exists, the money has not moved, and the row says
      // exactly that until an authoritative event or reconciliation says
      // otherwise.
      settled = (await linkRefundObject(db, inserted.id, result.providerObjectId)) ?? inserted;
    }
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      // A PERMANENT refusal is recorded and reported. A retryable one is left
      // `pending` and rethrown: marking it failed would tell the merchant the
      // payer's money is not coming when the next attempt would have sent it.
      const failed = await markRefundFailed(
        db,
        inserted.id,
        redactProviderMessage(error.message),
      );
      return {
        refund: failed ?? inserted,
        created: true,
        paymentStatus: intent.status,
      };
    }
    throw error;
  }

  // Only money that ACTUALLY moved changes the payment. A pending refund
  // leaves it `settled`, which is what it is.
  const paymentStatus = moved ? await applyRefundToIntent(intent) : intent.status;
  return { refund: settled, created: true, paymentStatus };
}

/**
 * Put the payment where the refund rows say it is.
 *
 * Recomputed from the sum rather than incremented, so it is correct however
 * many refunds landed and in whatever order — including ones this gateway never
 * initiated, which arrive through the event drain and call this same function.
 *
 * ## It can move DOWN, and that is new
 *
 * This used to return early when the sum was zero, which was right while a
 * succeeded refund was final. It is not: a bank can reject a refund days after
 * the provider accepted it, `refund.failed` says so, and the sum drops. Without
 * a downward target a payment whose only refund failed would claim `refunded`
 * forever — the merchant's books saying money went back that is still with
 * them, and no transition able to correct it.
 *
 * Three targets from one sum, and the intent's own status is left alone for any
 * status a refund cannot describe: a `created` or `expired` payment has nothing
 * to recompute, and moving it to `settled` because it has no refunds would be
 * this function inventing a settlement.
 */
const REFUND_AFFECTED_STATUSES: ReadonlySet<string> = new Set([
  "settled",
  "partially_refunded",
  "refunded",
]);

export async function applyRefundToIntent(intent: PaymentIntentRow): Promise<string> {
  if (!REFUND_AFFECTED_STATUSES.has(intent.status)) return intent.status;

  const refunded = BigInt(await sumSucceededRefunds(getDb(), intent.id));
  const event =
    refunded <= 0n
      ? "refund_voided"
      : refunded >= BigInt(intent.amount)
        ? "refund_full"
        : "refund_partial";

  // `applyEvent` short-circuits when the intent is already at the target, which
  // is what makes a second partial refund of an already partially-refunded
  // payment a no-op on the STATUS while the amounts still change.
  const next = applyEvent(intent.status, event);
  if (next === intent.status) return intent.status;

  const result = await transitionIntent(intent.id, { from: intent.status, status: next });
  // The caller is told the status it still has, not the one it wanted. A refund
  // recomputes from the SUM, so the next call over these same rows reaches the
  // right target from wherever the row actually ended up.
  if (result.kind !== "updated") return intent.status;
  announceIntentChange(result.row);
  return result.row.status;
}
