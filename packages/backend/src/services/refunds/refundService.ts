/**
 * Sending money back to a payer.
 *
 * The whole service turns on one arithmetic question — how much of this payment
 * has ALREADY gone back — and on getting it from the one place that knows: the
 * sum of succeeded refund rows. A stored total on the payment would be a second
 * home for the same fact, and the two disagree the first time a write is lost.
 */
import type { CurrencyCode } from "@peable.to/shared-types";
import {
  findRefundByExternalRef,
  insertRefund,
  markRefundFailed,
  markRefundSucceeded,
  sumSucceededRefunds,
  type RefundRow,
} from "../../db/refunds/refundRepository";
import type { PaymentIntentRow } from "../../db/payments/paymentIntentRepository";
import { getDb } from "../../db/postgres";
import { newId } from "../../lib/ids";
import { applyEvent } from "../intentState";
import { announceIntentChange, transitionIntent } from "../intentTransition";
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
 * `BigInt`, not `Number`: these are unbounded canonical integer strings, and a
 * float comparison starts rounding above `Number.MAX_SAFE_INTEGER` — which is
 * reachable in a minor-unit currency and is exactly where letting one unit
 * through matters most.
 */
export async function remainingRefundable(intent: PaymentIntentRow): Promise<string> {
  const refunded = await sumSucceededRefunds(getDb(), intent.id);
  const remaining = BigInt(intent.amount) - BigInt(refunded);
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
  try {
    const result = await provider.refund({
      intentId: intent.publicId,
      providerObjectId: intent.providerObjectId ?? "",
      refundId: inserted.publicId,
      amount: { amount: input.amount, currency: intent.currency as CurrencyCode },
      idempotencyKey: `re:${inserted.publicId}`,
      metadata: { peable_refund_id: inserted.publicId },
    });
    settled =
      (await markRefundSucceeded(db, inserted.id, result.providerObjectId)) ?? inserted;
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

  const paymentStatus = await applyRefundToIntent(intent);
  return { refund: settled, created: true, paymentStatus };
}

/**
 * Move the payment to `refunded` or `partially_refunded`, from the rows.
 *
 * Recomputed from the sum rather than incremented, so it is correct however
 * many refunds landed and in whatever order — including ones this gateway never
 * initiated, which arrive through the event drain and call this same function.
 */
export async function applyRefundToIntent(intent: PaymentIntentRow): Promise<string> {
  const refunded = await sumSucceededRefunds(getDb(), intent.id);
  if (BigInt(refunded) <= 0n) return intent.status;

  const target = BigInt(refunded) >= BigInt(intent.amount) ? "refunded" : "partially_refunded";
  // `applyEvent` short-circuits when the intent is already at the target, which
  // is what makes a second partial refund of an already partially-refunded
  // payment a no-op on the STATUS while the amounts still change.
  const next = applyEvent(intent.status, target === "refunded" ? "refund_full" : "refund_partial");
  if (next === intent.status) return intent.status;

  const result = await transitionIntent(intent.id, { from: intent.status, status: next });
  // The caller is told the status it still has, not the one it wanted. A refund
  // recomputes from the SUM, so the next call over these same rows reaches the
  // right target from wherever the row actually ended up.
  if (result.kind !== "updated") return intent.status;
  announceIntentChange(result.row);
  return result.row.status;
}
