import { test, expect } from 'bun:test';
import {
  PAYMENT_INTENT_STATUSES,
  POST_SETTLEMENT_STATUSES,
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
  /**
   * `false`, even though a declined card CAN be retried on the same provider
   * payment and `failed → settled` is therefore a legal edge.
   *
   * This answer drives the hosted checkout's reuse decision, and it has to be
   * right for both rails from a status alone. On the chain rail `failed` means
   * `underpaid`: coins arrived and were not enough, and handing that intent
   * back would show a payer an address that already holds part of their money.
   * Minting a fresh intent is correct on both rails; reusing one is correct on
   * only one of them.
   */
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
 * `canStillBePaid` used to derive its answer by walking `ALLOWED`, and every
 * derivation has eventually been broken by an edge added elsewhere — leaf-ness
 * by the refund transitions, reachability by `refunded → settled`. So the set
 * is stated and this checks it, in the one direction that can catch a real
 * defect: **a status the gateway calls payable must genuinely be able to reach
 * `settled`**. If someone removes `approved → broadcast`, a payer sitting in
 * `approved` can no longer pay and this goes red.
 *
 * The converse is NOT asserted, and the reason is `failed`. A declined card
 * attempt returns the provider's payment to `requires_payment_method`, so
 * `failed` can reach `settled` — while the hosted checkout must still mint a
 * FRESH intent rather than reuse it, because on the chain rail the same status
 * means `underpaid` and reusing it would show a payer an address that already
 * has part of their money. The two questions genuinely differ there, and
 * asserting they agree would force one of them to be wrong.
 */
test('every payable status can genuinely still reach settlement', () => {
  for (const status of PAYMENT_INTENT_STATUSES) {
    if (!PAYABLE[status]) continue;
    expect([status, reachesSettlementFromPayer(status)]).toEqual([status, true]);
  }
});

/** ...and nothing past settlement is payable, whatever edges it grows. */
test('no post-settlement status is payable', () => {
  for (const status of POST_SETTLEMENT_STATUSES) {
    expect([status, canStillBePaid(status)]).toEqual([status, false]);
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
