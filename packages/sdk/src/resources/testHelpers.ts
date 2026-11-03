import type {
  CheckoutSession,
  PaymentIntent,
  SimulateFaircoinPaymentParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

/**
 * `peable.testHelpers` — move a TEST-MODE object the way the outside world
 * would. Each helper feeds the gateway's real state machine, so the
 * transitions, events and webhooks are exactly those of a real payment. A live
 * credential is refused (`PeablePermissionError`, code `test_mode_only`).
 */

class PaymentIntentTestHelpers {
  constructor(private readonly client: RestClient) {}

  /**
   * Pretend a FairCoin payer paid this test-mode intent and the chain
   * confirmed it: `processing`, then `succeeded` — or, with
   * `{ outcome: 'underpaid' }`, `canceled` (`payment_failed` + `canceled`).
   * Nothing touches the chain: the recorded txid is synthetic.
   */
  simulateFaircoinPayment(
    id: string,
    params: SimulateFaircoinPaymentParams = {},
    options: { idempotencyKey?: string } = {},
  ): Promise<PaymentIntent> {
    return this.client.request<PaymentIntent>(
      'POST',
      `/v1/test_helpers/payment_intents/${encodeURIComponent(id)}/simulate_faircoin_payment`,
      { body: params, idempotencyKey: options.idempotencyKey },
    );
  }
}

class CheckoutSessionTestHelpers {
  constructor(private readonly client: RestClient) {}

  /**
   * Expire a test-mode session now, as its clock running out would: its
   * payment is `canceled` with `cancellation_reason: 'abandoned'`
   * (`payment_intent.canceled`).
   */
  expire(id: string, options: { idempotencyKey?: string } = {}): Promise<CheckoutSession> {
    return this.client.request<CheckoutSession>(
      'POST',
      `/v1/test_helpers/checkout_sessions/${encodeURIComponent(id)}/expire`,
      { body: {}, idempotencyKey: options.idempotencyKey },
    );
  }
}

export class TestHelpersResource {
  readonly paymentIntents: PaymentIntentTestHelpers;
  readonly checkoutSessions: CheckoutSessionTestHelpers;

  constructor(client: RestClient) {
    this.paymentIntents = new PaymentIntentTestHelpers(client);
    this.checkoutSessions = new CheckoutSessionTestHelpers(client);
  }
}
