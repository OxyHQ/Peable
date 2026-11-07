/**
 * Opening and closing a review WITH its event, in the caller's transaction
 * (ADR 0022 D5, ADR 0001 D7). The only writers of a review's open/closed state
 * besides a refusal's claim: `review.opened` and `review.closed` cannot be
 * missed or told twice, because each commits with the CAS that moved the row.
 *
 * A leaf module on purpose: `intentTransition.ts`, the refund service and the
 * dispute recorder close a review in THEIR transactions, and none of them may
 * import the approve/refuse flows that themselves move payments.
 */
import type { ReviewClosedReason } from '@peable.to/shared-types';
import type { PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import {
  closeReview,
  insertReview,
  type RadarRuleRow,
  type ReviewRow,
} from '../../db/radar/radarRepository';
import { toReviewDTO } from '../../lib/serializeRadar';
import { recordEvent } from '../events';

/** Open the payment's review, or `null` when it already has one. */
export async function openReviewIn(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
  rule: RadarRuleRow | null,
): Promise<ReviewRow | null> {
  const row = await insertReview(tx, {
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    rule:
      rule === null
        ? null
        : {
            publicId: rule.publicId,
            version: rule.version,
            action: rule.action,
            predicate: rule.predicate,
          },
  });
  if (!row) return null;
  await recordEvent(tx, {
    merchantId: intent.merchantId,
    type: 'review.opened',
    object: toReviewDTO(row),
    account: intent.connectedAccountPublicId,
    paymentIntentId: intent.id,
  });
  return row;
}

/**
 * Close a payment's (or one) review if it is open, recording `review.closed`.
 * `null` when there was nothing open to close.
 */
export async function closeReviewIn(
  tx: DatabaseOrTransaction,
  intent: Pick<PaymentIntentRow, 'id' | 'merchantId' | 'connectedAccountPublicId'>,
  reason: ReviewClosedReason,
  options: { readonly reviewId?: string; readonly requireNoPendingClaim?: boolean } = {},
): Promise<ReviewRow | null> {
  const row = await closeReview(
    tx,
    options.reviewId !== undefined ? { id: options.reviewId } : { paymentIntentId: intent.id },
    reason,
    { requireNoPendingClaim: options.requireNoPendingClaim ?? false },
  );
  if (!row) return null;
  await recordEvent(tx, {
    merchantId: intent.merchantId,
    type: 'review.closed',
    object: toReviewDTO(row),
    previousAttributes: { open: true, reason: row.openedReason, closed_reason: null },
    account: intent.connectedAccountPublicId,
    paymentIntentId: intent.id,
  });
  return row;
}
