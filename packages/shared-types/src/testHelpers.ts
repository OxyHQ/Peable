/**
 * Test helpers (`/v1/test_helpers/*`) — test mode only.
 *
 * They drive a test-mode object through the SAME state machine a real payment
 * moves through, so a merchant can exercise their integration end to end
 * without a wallet or a card: every transition a helper makes is one the
 * gateway would make, with the same events and webhooks.
 */

/**
 * What `simulate_faircoin_payment` pretends the payer did.
 *
 *  - `settled`   — paid the full amount, which is then seen in the mempool and
 *    confirmed: `broadcast → confirming → settled`
 *    (`payment_intent.confirming`, then `payment_intent.settled`).
 *  - `underpaid` — sent less than the amount: `broadcast → failed`
 *    (`payment_intent.failed`).
 */
export const SIMULATED_FAIRCOIN_OUTCOMES = ['settled', 'underpaid'] as const;
export type SimulatedFaircoinOutcome = (typeof SIMULATED_FAIRCOIN_OUTCOMES)[number];

export interface SimulateFaircoinPaymentParams {
  /** Default `settled`. */
  outcome?: SimulatedFaircoinOutcome;
}
