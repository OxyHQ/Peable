/**
 * Test helpers (`/v1/test_helpers/*`) — test mode only. They drive a test-mode
 * object through the SAME state machine a real payment moves through, so a
 * merchant can exercise their integration end to end without a wallet or a
 * card. The wire types are the contract's (`@peable.to/contracts`).
 */
export type { SimulateFaircoinPaymentParams } from '@peable.to/contracts';
export {
  SIMULATED_FAIRCOIN_OUTCOMES,
  type SimulatedFaircoinOutcome,
} from '@peable.to/contracts/vocabulary';
