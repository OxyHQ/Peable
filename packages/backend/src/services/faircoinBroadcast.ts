import type { PaymentIntentStatus } from '@peable.to/shared-types';
import type { IntentStateResult, PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { applyEvent } from './intentState';
import { transitionIntent } from './intentTransition';

/**
 * A FairCoin payer reported their broadcast transaction: `requires_action →
 * processing`, with the txid beside the status.
 *
 * The one implementation of that step, shared by the payer's `submit_tx` and
 * the test helper that simulates a payer (`services/testHelpers.ts`).
 *
 * Status and txid move in ONE statement: `payment_intents_processing_requires_txid_check`
 * refuses a FairCoin `processing` without the txid beside it, so two writes
 * could not satisfy the constraint in either order. The merchant is told
 * `payment_intent.processing`; the caller announces the committed row.
 *
 * @returns `illegal` (with the state machine's own message) when the intent is
 *   not in a status a broadcast can act from; otherwise the transition's result.
 */
export async function reportFaircoinBroadcast(
  intent: PaymentIntentRow,
  txid: string,
): Promise<IntentStateResult | { readonly kind: 'illegal'; readonly message: string }> {
  let next: PaymentIntentStatus;
  try {
    next = applyEvent(intent.status, 'broadcast', 'faircoin');
  } catch (err) {
    return {
      kind: 'illegal',
      message: err instanceof Error ? err.message : 'illegal state transition',
    };
  }
  return transitionIntent(intent.id, { from: intent.status, status: next, txid });
}
