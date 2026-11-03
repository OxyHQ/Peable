import { expect, test } from 'bun:test';
import {
  CARD_ONLY_STATUSES,
  EXPIRABLE_STATUSES,
  PAYMENT_INTENT_STATUSES,
  TERMINAL_STATUSES,
  canExpire,
  canStillBePaid,
  isValidStatusTransition,
  type PaymentIntentStatus,
} from '../paymentIntent';

test("the status vocabulary is exactly Stripe's seven", () => {
  expect([...PAYMENT_INTENT_STATUSES].sort()).toEqual(
    [
      'canceled',
      'processing',
      'requires_action',
      'requires_capture',
      'requires_confirmation',
      'requires_payment_method',
      'succeeded',
    ].sort(),
  );
});

/**
 * Every status is listed, not the interesting few: the failure mode is a status
 * nobody classified, and a spot-check cannot see one.
 */
const PAYABLE: Record<PaymentIntentStatus, boolean> = {
  requires_payment_method: true,
  requires_confirmation: true,
  requires_action: true,
  processing: true,
  requires_capture: true,
  succeeded: false,
  canceled: false,
};

test('says whether a payer can still complete a payment, for every status', () => {
  for (const status of PAYMENT_INTENT_STATUSES) {
    expect([status, canStillBePaid(status)]).toEqual([status, PAYABLE[status]]);
  }
});

/** Reachability walked over the table: every payable status can still end `succeeded`. */
function reaches(from: PaymentIntentStatus, to: PaymentIntentStatus): boolean {
  const seen = new Set<PaymentIntentStatus>();
  const queue = [from];
  while (queue.length > 0) {
    const next = queue.shift() as PaymentIntentStatus;
    for (const candidate of PAYMENT_INTENT_STATUSES) {
      if (!isValidStatusTransition(next, candidate) || seen.has(candidate)) continue;
      if (candidate === to) return true;
      seen.add(candidate);
      queue.push(candidate);
    }
  }
  return false;
}

test('every payable status can genuinely still reach succeeded, and no terminal one leaves', () => {
  for (const status of PAYMENT_INTENT_STATUSES) {
    if (PAYABLE[status]) expect([status, reaches(status, 'succeeded')]).toEqual([status, true]);
  }
  for (const status of TERMINAL_STATUSES) {
    for (const target of PAYMENT_INTENT_STATUSES) {
      expect([status, target, isValidStatusTransition(status, target)]).toEqual([
        status,
        target,
        false,
      ]);
    }
  }
});

test('the FairCoin path is requires_action -> processing -> succeeded, with canceled from both', () => {
  expect(isValidStatusTransition('requires_action', 'processing')).toBe(true);
  expect(isValidStatusTransition('processing', 'succeeded')).toBe(true);
  expect(isValidStatusTransition('requires_action', 'canceled')).toBe(true);
  expect(isValidStatusTransition('processing', 'canceled')).toBe(true);
  // ...and it never touches a card-only status.
  for (const status of ['requires_action', 'processing', 'succeeded', 'canceled'] as const) {
    expect(CARD_ONLY_STATUSES.includes(status)).toBe(false);
  }
});

test('a declined card returns to requires_payment_method from every attempt state', () => {
  for (const from of ['requires_confirmation', 'requires_action', 'processing'] as const) {
    expect(isValidStatusTransition(from, 'requires_payment_method')).toBe(true);
  }
});

test('manual capture: requires_capture -> succeeded | canceled', () => {
  expect(isValidStatusTransition('requires_capture', 'succeeded')).toBe(true);
  expect(isValidStatusTransition('requires_capture', 'canceled')).toBe(true);
  expect(isValidStatusTransition('requires_capture', 'requires_payment_method')).toBe(false);
});

/**
 * The expirable set is stated; pinned against the table here. Each member must
 * be able to reach `canceled` (expiry is a cancellation), and `processing` —
 * coins moving — must never be in it.
 */
test('expirable statuses are pre-payment and can be cancelled', () => {
  for (const status of EXPIRABLE_STATUSES) {
    expect(isValidStatusTransition(status, 'canceled')).toBe(true);
    expect(canExpire(status)).toBe(true);
  }
  expect(canExpire('processing')).toBe(false);
  expect(canExpire('requires_capture')).toBe(false);
  expect(canExpire('succeeded')).toBe(false);
});
