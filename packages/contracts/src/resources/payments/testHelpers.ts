import { z } from 'zod';
import { defineRoute } from '../../route';
import { SIMULATED_FAIRCOIN_OUTCOMES } from '../../vocabulary/payments';
import { paymentIntentSchema } from './paymentIntents';

/**
 * Test helpers for payment intents — test mode only. They drive a test-mode
 * payment through the SAME state machine a real one moves through, with the
 * same events and webhooks, so an integration is exercised end to end without
 * a wallet.
 */
export const simulateFaircoinPaymentParams = z
  .object({
    outcome: z
      .enum(SIMULATED_FAIRCOIN_OUTCOMES)
      .optional()
      .describe(
        '`settled` (the default): paid in full, seen and confirmed. `underpaid`: less than the amount arrived.',
      ),
  })
  .strict();
export type SimulateFaircoinPaymentParams = z.input<typeof simulateFaircoinPaymentParams>;

export const paymentIntentTestHelperRoutes = [
  defineRoute({
    operationId: 'simulateFaircoinPayment',
    method: 'post',
    path: '/v1/test_helpers/payment_intents/{id}/simulate_faircoin_payment',
    tag: 'Test helpers',
    summary: 'Simulate a FairCoin payment',
    description:
      'Pretend the payer broadcast and the chain confirmed (or underpaid) a FairCoin payment in `requires_action`. A live credential is refused with 403 `test_mode_only`.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    testModeOnly: true,
    params: { id: 'The payment intent (`pi_…`).' },
    body: simulateFaircoinPaymentParams,
    response: paymentIntentSchema,
    sdk: 'testHelpers.paymentIntents.simulateFaircoinPayment',
  }),
] as const;
