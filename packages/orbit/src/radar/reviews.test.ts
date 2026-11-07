import { describe, expect, it } from 'bun:test';
import {
  REVIEW_CLOSED_REASONS as SHARED_CLOSED,
  REVIEW_REFUSAL_REASONS as SHARED_REFUSAL,
  type Review,
} from '@peable.to/shared-types';
import { OrbitApiError } from '../api/transport';
import { intentFixture } from '../payments/fixtures';
import {
  decisionTone,
  evaluationFacts,
  REVIEW_CLOSED_REASONS,
  REVIEW_REFUSAL_REASONS,
  refuseBody,
  reviewActions,
  reviewFailure,
  reviewPayment,
  reviewPaymentId,
  reviewTone,
} from './reviews';
import { RADAR_EN, RADAR_ES } from './strings';

const open: Review = {
  id: 'prv_1',
  object: 'review',
  livemode: false,
  open: true,
  reason: 'rule',
  opened_reason: 'rule',
  closed_reason: null,
  payment_intent: 'pi_1',
  charge: 'ch_1',
  rule: { id: 'rule_1', action: 'review', predicate: ":risk_level: = 'elevated'", version: 2 },
  created: 1_800_000_000,
  closed_at: null,
};
const closed: Review = {
  ...open,
  open: false,
  reason: 'refunded_as_fraud',
  closed_reason: 'refunded_as_fraud',
  closed_at: 1_800_000_500,
};

const refusal = (status: number, code?: string) =>
  new OrbitApiError({
    status,
    type: 'invalid_request_error',
    message: 'refused',
    requestId: 'req_1',
    ...(code ? { code } : {}),
  });

describe('the vocabulary', () => {
  it('is the one shared-types re-exports', () => {
    expect(REVIEW_CLOSED_REASONS).toEqual(SHARED_CLOSED);
    expect(REVIEW_REFUSAL_REASONS).toEqual(SHARED_REFUSAL);
  });

  it('names every closed reason and refusal reason in both languages', () => {
    const keys = [
      ...REVIEW_CLOSED_REASONS.map((reason) => `review.closedReason.${reason}`),
      ...REVIEW_REFUSAL_REASONS.map((reason) => `review.refusalReason.${reason}`),
      'review.openedReason.rule',
      'review.refusalReason.none',
    ];
    for (const key of keys) {
      expect({ key, en: Object.hasOwn(RADAR_EN, key), es: Object.hasOwn(RADAR_ES, key) }).toEqual({
        key,
        en: true,
        es: true,
      });
    }
  });
});

describe('a review', () => {
  it('is approved or refused only while open', () => {
    expect(reviewActions(open)).toEqual(['approve', 'refuse']);
    expect(reviewActions(closed)).toEqual([]);
  });

  it('reads as waiting while open, and as how it ended once closed', () => {
    expect(reviewTone(open)).toBe('warning');
    expect(reviewTone({ open: false, closed_reason: 'approved' })).toBe('success');
    expect(reviewTone(closed)).toBe('danger');
    expect(reviewTone({ open: false, closed_reason: 'canceled' })).toBe('neutral');
  });

  it('names its payment whether or not the read expanded it', () => {
    expect(reviewPaymentId(open)).toBe('pi_1');
    expect(reviewPayment(open)).toBeNull();
    const payment = intentFixture({ id: 'pi_9' });
    const expanded: Review = { ...open, payment_intent: payment };
    expect(reviewPaymentId(expanded)).toBe('pi_9');
    expect(reviewPayment(expanded)).toBe(payment);
  });

  it('sends a refusal reason only when one was chosen', () => {
    expect(refuseBody('fraudulent')).toEqual({ reason: 'fraudulent' });
    expect(refuseBody('requested_by_customer')).toEqual({ reason: 'requested_by_customer' });
    expect(refuseBody('none')).toEqual({});
  });
});

describe('a failed approve or refuse', () => {
  it('says what happened for each refusal the gateway gives, and re-reads when it moved', () => {
    expect(reviewFailure(refusal(409, 'review_not_open'))).toEqual({
      key: 'review.error.notOpen',
      refresh: true,
    });
    expect(reviewFailure(refusal(409, 'resource_conflict'))).toEqual({
      key: 'review.error.inProgress',
      refresh: true,
    });
    expect(reviewFailure(refusal(409, 'payment_intent_unexpected_state'))).toEqual({
      key: 'review.error.paymentState',
      refresh: true,
    });
    expect(reviewFailure(refusal(502))).toEqual({ key: 'review.error.provider', refresh: false });
    expect(reviewFailure(refusal(503))).toEqual({ key: 'review.error.provider', refresh: false });
  });

  it("leaves anything else to the gateway's own words", () => {
    expect(reviewFailure(refusal(400, 'parameter_invalid'))).toBeNull();
    expect(reviewFailure(new TypeError('offline'))).toBeNull();
  });

  it('spells every sentence it names', () => {
    for (const key of [
      'review.error.notOpen',
      'review.error.inProgress',
      'review.error.paymentState',
      'review.error.provider',
    ]) {
      expect(Object.hasOwn(RADAR_EN, key) && Object.hasOwn(RADAR_ES, key)).toBe(true);
    }
  });
});

describe('an evaluation', () => {
  it('lists its facts in a stable order, keeping unknown as unknown', () => {
    expect(
      evaluationFacts({ facts: { card_country: null, amount: '250000', currency: 'EUR' } }),
    ).toEqual([
      ['amount', '250000'],
      ['card_country', null],
      ['currency', 'EUR'],
    ]);
  });

  it('reads a block as danger, a review as a warning and an allow as success', () => {
    expect(decisionTone('block')).toBe('danger');
    expect(decisionTone('review')).toBe('warning');
    expect(decisionTone('allow')).toBe('success');
  });
});
