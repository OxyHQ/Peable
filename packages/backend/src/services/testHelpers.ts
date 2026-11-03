/**
 * Test helpers — what `/v1/test_helpers/*` does (test mode only; the route
 * refuses a live credential before anything here runs).
 *
 * ## The rule: a helper is a FAKE INPUT, never a shortcut
 *
 * A helper replaces only what a test-mode developer cannot easily produce — a
 * payer with a testnet wallet, a chain that confirms on demand, a clock that
 * has run out — and hands that input to the SAME code that would have received
 * the real one. It never writes a status itself:
 *
 * - the payer's broadcast is `reportFaircoinBroadcast`, what `submit_tx` runs;
 * - the chain's answer is `applyChainObservation`, the settlement watcher's own
 *   decision (`services/settlementWatcher.ts`);
 * - the clock is `expireIntentNow`, the expiry sweep's own step.
 *
 * So every transition is a compare-and-swap through `transitionIntent`, every
 * event is recorded in that transition's transaction, and a billing invoice or
 * a tax transaction behind the payment moves exactly as it would for a real one.
 *
 * ## It does not touch the chain
 *
 * `simulate_faircoin_payment` broadcasts nothing and reads nothing from the
 * Explorer. The txid it records is SYNTHETIC — 64 random hex characters naming
 * no transaction on any network — and the intent stops being watched the
 * moment it leaves `processing`, which it does inside the same request. Should
 * the watcher poll it in between, the Explorer does not know the txid and the
 * watcher leaves the row alone.
 */
import { randomBytes } from 'node:crypto';
import type { SimulatedFaircoinOutcome } from '@peable.to/shared-types';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { reportFaircoinBroadcast } from './faircoinBroadcast';
import { announceIntentChange } from './intentTransition';
import { applyChainObservation } from './settlementWatcher';

export type SimulationResult =
  | { readonly kind: 'ok'; readonly row: PaymentIntentRow }
  | {
      readonly kind: 'refused';
      readonly status: 400 | 409;
      readonly message: string;
      readonly code?: string;
    };

/** A txid that names no transaction: see the module comment. */
function syntheticTxid(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Pretend a FairCoin payer paid `intent` (or underpaid it), and the chain
 * confirmed it: `requires_action → processing → succeeded`, or `→ canceled`
 * (`underpaid`). An intent already `processing` (a payer really broadcast)
 * continues from there with its own txid.
 */
export async function simulateFaircoinPayment(
  intent: PaymentIntentRow,
  outcome: SimulatedFaircoinOutcome,
): Promise<SimulationResult> {
  if (intent.rail !== 'faircoin') {
    return {
      kind: 'refused',
      status: 400,
      message:
        "simulate_faircoin_payment drives a FairCoin payment; this one is on the card rail. Confirm a test card payment with the provider's test cards instead.",
      code: 'rail_mismatch',
    };
  }
  if (intent.network !== 'testnet') {
    return {
      kind: 'refused',
      status: 400,
      message: 'simulate_faircoin_payment only drives a testnet payment.',
      code: 'network_mismatch',
    };
  }

  let row = intent;
  if (row.status !== 'processing') {
    const broadcast = await reportFaircoinBroadcast(row, syntheticTxid());
    if (broadcast.kind === 'illegal') {
      return { kind: 'refused', status: 409, message: broadcast.message };
    }
    if (broadcast.kind === 'stale') {
      return {
        kind: 'refused',
        status: 409,
        message: `the payment intent moved to '${broadcast.current}' while this request was in flight`,
      };
    }
    if (broadcast.kind === 'missing') {
      return { kind: 'refused', status: 409, message: 'the payment intent no longer exists' };
    }
    row = broadcast.row;
    announceIntentChange(row);
  }

  // What the watcher would see: the transaction in the mempool, then buried
  // under the merchant's required confirmations — or, underpaid, at once.
  const observations =
    outcome === 'underpaid'
      ? [{ paid: false, confirmations: 0 }]
      : [
          { paid: true, confirmations: 0 },
          { paid: true, confirmations: row.requiredConfirmations },
        ];
  for (const observation of observations) {
    if (row.status !== 'processing') break;
    const moved = await applyChainObservation(row, observation);
    if (moved === null) continue;
    row = moved;
    announceIntentChange(row);
  }
  return { kind: 'ok', row };
}
