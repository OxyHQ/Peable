import { test, expect } from 'bun:test';
import {
  PAYMENT_INTENT_STATUSES,
  canStillBePaid,
  isValidStatusTransition,
  reachesSettlementFromPayer,
  type PaymentIntentStatus,
} from '../paymentIntent';

test('allows created -> awaiting_approval', () => {
  expect(isValidStatusTransition('created', 'awaiting_approval')).toBe(true);
});
test('forbids settled -> confirming (except reorg handled separately)', () => {
  expect(isValidStatusTransition('settled', 'confirming')).toBe(false);
});
test('forbids skipping broadcast', () => {
  expect(isValidStatusTransition('awaiting_approval', 'settled')).toBe(false);
});

/**
 * `canStillBePaid`, and the regression it exists because of.
 *
 * The hosted checkout used to decide reuse by asking whether a status was a
 * LEAF of the transition table. That answered correctly for `settled` right up
 * until `settled` gained `→ refunded | partially_refunded`, at which point a
 * settled payment stopped looking finished and the checkout began reusing a
 * remembered settled intent — showing a payer who had already paid their old
 * receipt forever, with no way to pay the link again. The table change was
 * correct; the question was wrong.
 *
 * Every status is listed below rather than the interesting few, because the
 * failure mode is a NEW status nobody classified, and a spot-check cannot see
 * one.
 */
const PAYABLE: Record<PaymentIntentStatus, boolean> = {
  created: true,
  awaiting_approval: true,
  approved: true,
  broadcast: true,
  confirming: true,
  requires_action: true,
  processing: true,
  // Where paying ENDS. Has outgoing edges, and none of them is the payer's.
  settled: false,
  partially_refunded: false,
  refunded: false,
  expired: false,
  failed: false,
  rejected: false,
};

test('says whether a payer can still complete a payment, for every status', () => {
  for (const status of PAYMENT_INTENT_STATUSES) {
    expect([status, canStillBePaid(status)]).toEqual([status, PAYABLE[status]]);
  }
});

test('classifies every status the table defines, and no others', () => {
  // Guards the table above against a status added to `ALLOWED` and forgotten
  // here — which would read as `undefined` and quietly assert nothing.
  expect([...PAYMENT_INTENT_STATUSES].sort()).toEqual(Object.keys(PAYABLE).sort());
});

/**
 * Reachability is TRANSITIVE, not one-step. `awaiting_approval` reaches
 * `settled` only through `approved → broadcast → confirming`, and a one-step
 * check would call it unpayable — abandoning a payer mid-flow.
 */
test('follows the chain path all the way to settled', () => {
  expect(isValidStatusTransition('awaiting_approval', 'settled')).toBe(false);
  expect(canStillBePaid('awaiting_approval')).toBe(true);
});

/**
 * The gate that keeps the STATED payable set honest against the table.
 *
 * `canStillBePaid` used to derive its answer by walking `ALLOWED`, and that
 * derivation broke the moment refunds could be undone: `refunded → settled`
 * makes `settled` reachable from `settled` in two steps, so reachability would
 * call a finished payment payable and reintroduce the original bug exactly.
 *
 * So the set is stated and this checks it: a payable status must still be able
 * to reach `settled` without passing through a post-settlement status, and a
 * non-payable one must not. The property survives any edge added to the table,
 * which is more than either previous derivation managed.
 */
test('every payable status reaches settlement from the payer, and no other does', () => {
  for (const status of PAYMENT_INTENT_STATUSES) {
    expect([status, reachesSettlementFromPayer(status)]).toEqual([status, PAYABLE[status]]);
  }
});

/**
 * A refund can be UNDONE, and the table has to say so.
 *
 * A bank can reject a refund days after the provider accepted it
 * (`refund.failed`). Without a path back, a payment whose only refund failed
 * would claim `refunded` forever — the merchant's books saying money went back
 * that is still with them, and no legal transition able to correct it.
 */
test('lets a failed refund return the payment to where the money actually is', () => {
  expect(isValidStatusTransition('refunded', 'settled')).toBe(true);
  expect(isValidStatusTransition('refunded', 'partially_refunded')).toBe(true);
  expect(isValidStatusTransition('partially_refunded', 'settled')).toBe(true);
  // ...and none of that makes a finished payment payable again.
  expect(canStillBePaid('refunded')).toBe(false);
  expect(canStillBePaid('partially_refunded')).toBe(false);
  expect(canStillBePaid('settled')).toBe(false);
});
