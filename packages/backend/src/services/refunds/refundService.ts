/**
 * Sending money back to a payer.
 *
 * The whole service turns on one arithmetic question — how much of this payment
 * has ALREADY gone back — and on getting it from the one place that knows: the
 * sum of succeeded refund rows. A stored total on the payment would be a second
 * home for the same fact, and the two disagree the first time a write is lost.
 */
import { closeReviewIn } from '../radar/reviewEvents';
import { releaseReviewClose, REVIEW_REFUND_REF_PREFIX } from '../../db/radar/radarRepository';
import type { CurrencyCode, RefundReason } from '@peable.to/shared-types';
import {
  findRefundByPublicId,
  markRefundCanceled,
  findRefundByExternalRef,
  insertRefund,
  linkRefundObject,
  markRefundFailed,
  markRefundSucceeded,
  sumCommittedRefunds,
  type RefundRow,
} from '../../db/refunds/refundRepository';
import type { PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import { findChargeForIntent } from '../../db/payments/chargeRepository';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toChargeDTO, toRefundDTO } from '../../lib/serialize';
import { recordChargeEvent, recordRefundEvent } from '../intentTransition';
import { kickWebhookOutbox } from '../webhookOutbox';
import { selectStoredProvider } from '../providers/environmentGuard';
import {
  isMoneyMirroringProvider,
  ProviderError,
  type PaymentProvider,
} from '../providers/provider';
import { redactProviderMessage } from '../providers/redact';

/** The payment cannot be refunded from where it stands. */
export class PaymentNotRefundableError extends Error {
  constructor(status: string) {
    super(`a refund needs a succeeded payment; this one is '${status}'`);
    this.name = 'PaymentNotRefundableError';
  }
}

/** More was asked for than the payment has left. */
export class RefundExceedsRemainingError extends Error {
  constructor(requested: string, remaining: string) {
    super(`a refund of ${requested} exceeds the ${remaining} still refundable on this payment`);
    this.name = 'RefundExceedsRemainingError';
  }
}

/** The rail cannot refund — true of the chain rail, whose money it never held. */
export class RefundsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundsUnavailableError';
  }
}

export interface CreateRefundInput {
  readonly merchantId: string;
  readonly intent: PaymentIntentRow;
  /** The MERCHANT's own id for this refund. The idempotency. */
  readonly externalRef: string;
  readonly amount: string;
  readonly reason?: RefundReason;
  readonly metadata?: Record<string, string>;
  /** Destination charges (ADR 0015 §3): refund Orbit's fee and pull the funds back, in proportion. */
  readonly refundApplicationFee?: boolean;
  readonly reverseTransfer?: boolean;
}

export interface CreateRefundResult {
  readonly refund: RefundRow;
  /** `false` when this refund had already been made. */
  readonly created: boolean;
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
 * The payment's `amount_refunded` is still `sumSucceededRefunds` — money that
 * actually moved. The two questions are different and both get asked. The
 * budget is what was RECEIVED: a partial capture refunds no more than it took.
 *
 * `BigInt`, not `Number`: these are unbounded canonical integer strings, and a
 * float comparison starts rounding above `Number.MAX_SAFE_INTEGER` — which is
 * reachable in a minor-unit currency and is exactly where letting one unit
 * through matters most.
 */
export async function remainingRefundable(intent: PaymentIntentRow): Promise<string> {
  const committed = await sumCommittedRefunds(getDb(), intent.id);
  const remaining = BigInt(intent.amountReceived) - BigInt(committed);
  return (remaining > 0n ? remaining : 0n).toString();
}

function requireRefundProvider(intent: PaymentIntentRow): PaymentProvider {
  if (!intent.provider || !intent.providerObjectId) {
    // A settled payment with no provider object is a FairCoin payment. This
    // gateway never held those funds, so it has nothing to send back — not a
    // gap, a different rail.
    throw new RefundsUnavailableError(
      'this payment did not settle through a provider this gateway can refund from',
    );
  }
  // The payment's own mode (ADR 0017): a refund goes back through the key that
  // took the money, never a process-wide default.
  const provider = selectStoredProvider(intent.provider, intent.livemode);
  if (!provider) {
    throw new RefundsUnavailableError(
      `the ${intent.provider} rail is not configured for ${intent.livemode ? 'live' : 'test'} mode on this deployment`,
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
  if (intent.status !== 'succeeded') {
    throw new PaymentNotRefundableError(intent.status);
  }
  const provider = requireRefundProvider(intent);
  const db = getDb();

  /**
   * An existing row for this reference is either FINISHED or INTERRUPTED.
   *
   * `provider_object_id` tells them apart: a refund that reached the provider
   * has one — whatever its state — and one that did not is `pending` with
   * nothing behind it. Handing that pending row back unchanged, which is what
   * used to happen, left a refund no path ever retried: the merchant's retry
   * got a 200 for money that had not gone anywhere.
   *
   * The remaining-balance check is NOT re-applied when resuming. This amount
   * was reserved when the row was written and `remainingRefundable` counts
   * pending refunds, so charging it again would refuse every resume.
   */
  const existing = await findRefundByExternalRef(db, input.merchantId, input.externalRef);
  if (existing && (existing.providerObjectId !== null || existing.status === 'failed')) {
    return { refund: existing, created: false };
  }

  if (!existing) {
    const remaining = await remainingRefundable(intent);
    if (BigInt(input.amount) > BigInt(remaining)) {
      throw new RefundExceedsRemainingError(input.amount, remaining);
    }
  }

  const inserted =
    existing ??
    (await db.transaction(async (tx) => {
      const row = await insertRefund(tx, {
        publicId: newId('re'),
        merchantId: input.merchantId,
        paymentIntentId: intent.id,
        externalRef: input.externalRef,
        amount: input.amount,
        currency: intent.currency,
        provider: provider.id,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
        refundApplicationFee: input.refundApplicationFee ?? false,
        reverseTransfer: input.reverseTransfer ?? false,
      });
      // `refund.created` commits with the row (ADR 0001 D7).
      if (row) await emitRefundEvents(tx, intent, row, null);
      return row;
    })) ??
    // `null` only from the insert: a concurrent request won the unique index
    // between the read above and the write. Its row is this reference's row.
    (await findRefundByExternalRef(db, input.merchantId, input.externalRef));

  if (!inserted) throw new Error(`refund ${input.externalRef} neither inserted nor found`);
  if (inserted.providerObjectId !== null) {
    return { refund: inserted, created: false };
  }

  let settled: RefundRow;
  try {
    const result = await provider.refund({
      intentId: intent.publicId,
      providerObjectId: intent.providerObjectId ?? '',
      refundId: inserted.publicId,
      // From the ROW, not the request. A resume re-sends the amount the
      // interrupted attempt reserved; taking it from the request would let a
      // retry that mistyped the amount refund a different one under the same
      // reference — and under the same provider idempotency key, which the
      // provider would then refuse as a changed payload.
      amount: { amount: inserted.amount, currency: intent.currency as CurrencyCode },
      idempotencyKey: `re:${inserted.publicId}`,
      metadata: { peable_refund_id: inserted.publicId },
      // From the ROW too, for the reason the amount is: a resume sends what
      // the interrupted attempt recorded.
      ...(inserted.reason !== null ? { reason: inserted.reason } : {}),
      ...(inserted.refundApplicationFee ? { refundApplicationFee: true } : {}),
      ...(inserted.reverseTransfer ? { reverseTransfer: true } : {}),
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
    if (result.state === 'succeeded') {
      settled = await db.transaction(async (tx) => {
        const row = await markRefundSucceeded(tx, inserted.id, result.providerObjectId);
        if (row) await emitRefundEvents(tx, intent, row, inserted.status);
        return row ?? inserted;
      });
    } else if (result.state === 'failed') {
      settled = await db.transaction(async (tx) => {
        const row = await markRefundFailed(
          tx,
          inserted.id,
          result.failureCode ?? 'the provider refused the refund',
          result.providerObjectId,
        );
        if (row) await emitRefundEvents(tx, intent, row, inserted.status);
        return row ?? inserted;
      });
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
      const failed = await db.transaction(async (tx) => {
        const row = await markRefundFailed(tx, inserted.id, redactProviderMessage(error.message));
        if (row) await emitRefundEvents(tx, intent, row, inserted.status);
        return row;
      });
      kickWebhookOutbox();
      return { refund: failed ?? inserted, created: true };
    }
    throw error;
  }

  kickWebhookOutbox();
  return { refund: settled, created: true };
}

/** The refund is not one the provider can still cancel. 400. */
export class RefundNotCancelableError extends Error {
  constructor(status: RefundRow['status']) {
    super(`a ${status} refund cannot be canceled`);
    this.name = 'RefundNotCancelableError';
  }
}

/**
 * Cancel a refund the provider still holds. Only a `pending` refund the
 * provider has (Stripe allows it while the refund `requires_action`); the
 * provider decides, and a refusal is a 400 that changes nothing here.
 */
export async function cancelRefund(
  intent: PaymentIntentRow,
  refund: RefundRow,
): Promise<RefundRow> {
  if (refund.status !== 'pending' || refund.providerObjectId === null) {
    throw new RefundNotCancelableError(refund.status);
  }
  const provider = requireRefundProvider(intent);
  if (!isMoneyMirroringProvider(provider)) {
    throw new RefundsUnavailableError(`the ${provider.id} rail cannot cancel refunds`);
  }
  let result: Awaited<ReturnType<typeof provider.cancelRefund>>;
  try {
    result = await provider.cancelRefund({
      providerObjectId: refund.providerObjectId,
      idempotencyKey: `re_cancel:${refund.publicId}`,
    });
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      throw new RefundNotCancelableError(refund.status);
    }
    throw error;
  }
  if (result.state !== 'canceled') throw new RefundNotCancelableError(refund.status);
  const db = getDb();
  const canceled = await db.transaction(async (tx) => {
    const row = await markRefundCanceled(tx, refund.id);
    if (row) await emitRefundEvents(tx, intent, row, refund.status);
    return row;
  });
  kickWebhookOutbox();
  return canceled ?? (await findRefundByPublicId(db, refund.merchantId, refund.publicId)) ?? refund;
}

/**
 * Tell the merchant what a refund row just did, in the transaction that did it
 * (ADR 0001 D7). Refunds are not PaymentIntent statuses (ADR 0019): the refund
 * carries its own lifecycle, and the CHARGE carries the running total.
 *
 *  - a new row                      → `refund.created`
 *  - a row that reached `succeeded` → `refund.updated`, then `charge.refunded`
 *                                      (the charge whose `amount_refunded` grew)
 *  - a row that reached `failed`    → `refund.failed` (a bank can reject a
 *                                      refund days after it succeeded; the
 *                                      charge's total drops with it)
 *  - anything else                  → `refund.updated` when the status moved
 *
 * Shared with the provider-event drain, which records refunds this gateway did
 * not make.
 */
export async function emitRefundEvents(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
  refund: RefundRow,
  previous: RefundRow['status'] | null,
): Promise<void> {
  const dto = toRefundDTO(refund, intent.publicId);
  if (previous === null) {
    await recordRefundEvent(tx, intent, dto, 'refund.created');
  } else if (previous === refund.status) {
    return;
  } else if (refund.status === 'failed') {
    await recordRefundEvent(tx, intent, dto, 'refund.failed');
    // A refusal waiting on this refund lets go of its claim: the review is
    // open again, to approve or refuse anew (ADR 0022 D5).
    // Only the refund a refusal made (`review:<prv>`): any other refund of the
    // payment failing says nothing about the refusal.
    if (refund.externalRef?.startsWith(REVIEW_REFUND_REF_PREFIX)) {
      await releaseReviewClose(
        tx,
        {
          paymentIntentId: intent.id,
          publicId: refund.externalRef.slice(REVIEW_REFUND_REF_PREFIX.length),
        },
        ['refunded', 'refunded_as_fraud'],
      );
    }
    return;
  } else {
    await recordRefundEvent(tx, intent, dto, 'refund.updated');
  }
  if (refund.status === 'succeeded') {
    // Money went back: the payment's open review is over (ADR 0022 D5).
    await closeReviewIn(
      tx,
      intent,
      refund.reason === 'fraudulent' ? 'refunded_as_fraud' : 'refunded',
    );
    const charge = await findChargeForIntent(tx, intent.id);
    if (charge) await recordChargeEvent(tx, intent, toChargeDTO(charge), 'charge.refunded');
  }
}
