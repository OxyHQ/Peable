/**
 * Approving and refusing a review (ADR 0022 D5).
 *
 * An approval is one CAS: open, and no refusal in progress. A refusal moves
 * money, so it CLAIMS the review first (`pending_closed_reason`), acts through
 * the existing cancel or refund path, and only then closes it; a provider that
 * would not act lets the claim go and the review stays open. The cancellation
 * and the refund close the review themselves, in their own transactions
 * (`intentTransition.ts`, `refundService.ts`): a refusal's own close is only
 * the fallback for a payment that moved under it.
 */
import type { ReviewClosedReason, ReviewRefusalReason } from '@peable.to/shared-types';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { findIntentById, type PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import { getDb } from '../../db/postgres';
import {
  claimReviewClose,
  findReviewForMerchant,
  holdReviewClose,
  releaseReviewClose,
  type ReviewRow,
} from '../../db/radar/radarRepository';
import { cancelCardPaymentAtProvider } from '../cardCancellation';
import { reconcileIntentWithProvider } from '../intentReconciliation';
import { announceIntentChange, transitionIntent } from '../intentTransition';
import { ProviderError } from '../providers/provider';
import { redactProviderMessage } from '../providers/redact';
import {
  createRefund,
  PaymentNotRefundableError,
  RefundsUnavailableError,
  remainingRefundable,
} from '../refunds/refundService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { RadarError } from './errors';
import { closeReviewIn } from './reviewEvents';

async function openReviewOf(merchant: MerchantRow, publicId: string): Promise<ReviewRow> {
  const review = await findReviewForMerchant(getDb(), publicId, merchant.id);
  if (!review) throw new RadarError('resource_missing', 'review not found', undefined, 404);
  if (review.closedReason !== null) {
    throw new RadarError(
      'review_not_open',
      `this review is closed (${review.closedReason})`,
      undefined,
      409,
    );
  }
  return review;
}

async function intentOf(review: ReviewRow): Promise<PaymentIntentRow> {
  const intent = await findIntentById(getDb(), review.paymentIntentId);
  if (!intent) throw new Error(`review ${review.publicId} names no payment`);
  return intent;
}

/** Why a close lost its CAS: closed by someone else, or a refusal in progress. */
async function refuseLostClose(merchant: MerchantRow, publicId: string): Promise<never> {
  const current = await findReviewForMerchant(getDb(), publicId, merchant.id);
  if (current && current.closedReason === null) {
    throw new RadarError(
      'resource_conflict',
      'this review is being refused; read it again',
      undefined,
      409,
    );
  }
  throw new RadarError(
    'review_not_open',
    `this review is closed (${current?.closedReason ?? 'unknown'})`,
    undefined,
    409,
  );
}

/** `POST /v1/reviews/:id/approve` — Stripe's. A held capture may proceed. */
export async function approveReview(merchant: MerchantRow, publicId: string): Promise<ReviewRow> {
  const review = await openReviewOf(merchant, publicId);
  const intent = await intentOf(review);
  const closed = await getDb().transaction((tx) =>
    closeReviewIn(tx, intent, 'approved', { reviewId: review.id, requireNoPendingClaim: true }),
  );
  if (!closed) return refuseLostClose(merchant, publicId);
  kickWebhookOutbox();
  return closed;
}

/**
 * `POST /v1/reviews/:id/refuse` — Orbit's. Releases a held authorization or
 * refunds what was captured, in full, through the paths every other release
 * and refund takes.
 */
export async function refuseReview(
  merchant: MerchantRow,
  publicId: string,
  reason: ReviewRefusalReason | undefined,
): Promise<ReviewRow> {
  const review = await openReviewOf(merchant, publicId);
  const intent = await intentOf(review);

  let closing: ReviewClosedReason;
  if (intent.status === 'requires_capture' || intent.status === 'canceled') closing = 'canceled';
  else if (intent.status === 'succeeded') {
    closing = reason === 'fraudulent' ? 'refunded_as_fraud' : 'refunded';
  } else {
    throw new RadarError(
      'payment_intent_unexpected_state',
      `the payment is '${intent.status}'; it cannot be refused now`,
      undefined,
      409,
    );
  }

  const db = getDb();
  if (!(await claimReviewClose(db, review.id, closing))) return refuseLostClose(merchant, publicId);

  let refund: 'settled' | 'pending' | 'nothing' = 'nothing';
  try {
    if (intent.status === 'requires_capture') await releaseAuthorization(intent, review, reason);
    else if (intent.status === 'succeeded') {
      refund = await refundInFull(merchant, intent, review, reason);
    }
  } catch (error) {
    await releaseReviewClose(db, { id: review.id }, [closing]);
    throw error;
  }

  // A refund still pending at the provider: the review stays open, its claim
  // HELD until the refund succeeds (the refund closes it, `refundService.ts`)
  // or fails (the claim is let go). Closing it now would say money went back
  // that may never go back.
  if (refund === 'pending') {
    await holdReviewClose(db, review.id, closing);
    return (await findReviewForMerchant(db, publicId, merchant.id)) ?? review;
  }

  // The cancellation or the refund closed it in its own transaction; this is
  // the close for a payment that was already over.
  const closed = await db.transaction((tx) =>
    closeReviewIn(tx, intent, closing, { reviewId: review.id }),
  );
  kickWebhookOutbox();
  return closed ?? (await findReviewForMerchant(db, publicId, merchant.id)) ?? review;
}

async function releaseAuthorization(
  intent: PaymentIntentRow,
  review: ReviewRow,
  reason: ReviewRefusalReason | undefined,
): Promise<void> {
  const cancellationReason = reason === 'requested_by_customer' ? reason : 'fraudulent';
  const cancellation = await cancelCardPaymentAtProvider(
    intent,
    `review:${review.publicId}:cancel`,
    cancellationReason,
  );
  if (cancellation.kind === 'settled') {
    await reconcileIntentWithProvider(intent);
    throw new RadarError(
      'payment_intent_unexpected_state',
      'the payment was captured before its authorization could be released; refuse it again to refund it',
      undefined,
      409,
    );
  }
  if (cancellation.kind === 'in_flight') {
    throw new RadarError(
      'payment_intent_unexpected_state',
      `the provider still has this payment in flight ('${cancellation.status}')`,
      undefined,
      409,
    );
  }
  if (cancellation.kind === 'unknown') {
    throw new RadarError(
      null,
      `the authorization could not be released: ${redactProviderMessage(cancellation.error)}`,
      undefined,
      502,
    );
  }
  if (cancellation.kind === 'nothing_to_cancel') {
    throw new RadarError(
      'rail_unavailable',
      'the card rail cannot reach this payment',
      undefined,
      503,
    );
  }
  const moved = await transitionIntent(intent.id, {
    from: intent.status,
    status: 'canceled',
    cancellationReason,
  });
  if (moved.kind === 'updated') {
    announceIntentChange(moved.row);
    return;
  }
  // Moved under us — the provider's word decides, and the release happened.
  await reconcileIntentWithProvider(intent);
}

async function refundInFull(
  merchant: MerchantRow,
  intent: PaymentIntentRow,
  review: ReviewRow,
  reason: ReviewRefusalReason | undefined,
): Promise<'settled' | 'pending' | 'nothing'> {
  const remaining = await remainingRefundable(intent);
  if (remaining === '0') return 'nothing';
  try {
    const { refund } = await createRefund({
      merchantId: merchant.id,
      intent,
      externalRef: `review:${review.publicId}`,
      amount: remaining,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (refund.status === 'failed') {
      throw new RadarError(null, 'the provider refused the refund', undefined, 502);
    }
    return refund.status === 'succeeded' ? 'settled' : 'pending';
  } catch (error) {
    if (error instanceof RadarError) throw error;
    if (error instanceof PaymentNotRefundableError) {
      throw new RadarError('payment_intent_unexpected_state', error.message, undefined, 409);
    }
    if (error instanceof RefundsUnavailableError) {
      throw new RadarError('rail_unavailable', error.message, undefined, 503);
    }
    if (error instanceof ProviderError) {
      throw new RadarError(
        null,
        `the refund could not be made: ${redactProviderMessage(error.message)}`,
        undefined,
        502,
      );
    }
    throw error;
  }
}
