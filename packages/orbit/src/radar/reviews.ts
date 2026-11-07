import {
  REVIEW_CLOSED_REASONS,
  REVIEW_REFUSAL_REASONS,
  type ReviewRefusalReason,
} from '@peable.to/contracts/vocabulary';
import type { PaymentIntent, RadarEvaluation, Review } from '@peable.to/shared-types';
import { isOrbitApiError } from '../api/transport';
import type { StatusTone } from '../payments/status';

/**
 * The review queue as pure data (ADR 0022 D5): what a review allows, its
 * tone, the payment it holds, and what each refusal of an action means.
 */

export { REVIEW_CLOSED_REASONS, REVIEW_REFUSAL_REASONS };
export type { ReviewRefusalReason };

export type ReviewAction = 'approve' | 'refuse';

/** Only an open review is approved or refused; a closed one is history. */
export function reviewActions(review: Pick<Review, 'open'>): ReviewAction[] {
  return review.open ? ['approve', 'refuse'] : [];
}

export function reviewTone(review: Pick<Review, 'open' | 'closed_reason'>): StatusTone {
  if (review.open) return 'warning';
  switch (review.closed_reason) {
    case 'approved':
      return 'success';
    case 'refunded_as_fraud':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** The payment's id, whether or not the read expanded it. */
export function reviewPaymentId(review: Pick<Review, 'payment_intent'>): string {
  const reference = review.payment_intent;
  return typeof reference === 'string' ? reference : reference.id;
}

/** The expanded payment, when the read expanded it. */
export function reviewPayment(review: Pick<Review, 'payment_intent'>): PaymentIntent | null {
  return typeof review.payment_intent === 'string' ? null : review.payment_intent;
}

/** `none` in the form is "no reason given": the body then has no `reason`. */
export type RefusalChoice = ReviewRefusalReason | 'none';

export function refuseBody(choice: RefusalChoice): { reason?: ReviewRefusalReason } {
  return choice === 'none' ? {} : { reason: choice };
}

/**
 * The i18n key of the sentence a failed approve or refuse shows — what
 * happened and what to do — or `null` when the gateway's own words are the
 * best ones. `refresh` says the review should be read again (it moved).
 */
export function reviewFailure(error: unknown): { key: string; refresh: boolean } | null {
  if (!isOrbitApiError(error)) return null;
  if (error.code === 'review_not_open') return { key: 'review.error.notOpen', refresh: true };
  if (error.code === 'resource_conflict') return { key: 'review.error.inProgress', refresh: true };
  if (error.code === 'payment_intent_unexpected_state') {
    return { key: 'review.error.paymentState', refresh: true };
  }
  if (error.status === 502 || error.status === 503) {
    return { key: 'review.error.provider', refresh: false };
  }
  return null;
}

/** An evaluation's facts in a stable order, `null` (unknown) kept as such. */
export function evaluationFacts(
  evaluation: Pick<RadarEvaluation, 'facts'>,
): Array<[string, string | null]> {
  return Object.entries(evaluation.facts).sort(([a], [b]) => a.localeCompare(b));
}

/** How a decision reads at a glance. */
export function decisionTone(decision: RadarEvaluation['decision']): StatusTone {
  switch (decision) {
    case 'block':
      return 'danger';
    case 'review':
      return 'warning';
    default:
      return 'success';
  }
}
