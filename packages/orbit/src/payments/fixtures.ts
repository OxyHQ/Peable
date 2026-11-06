import type { PaymentIntent } from '@peable.to/shared-types';

/**
 * A complete PaymentIntent for tests (ADR 0019 wire): a fresh FairCoin payment
 * waiting on its payer. Override what the case is about.
 */
export function intentFixture(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_test',
    object: 'payment_intent',
    livemode: false,
    status: 'requires_action',
    rail: 'faircoin',
    payment_method_types: ['faircoin'],
    payment_method_configuration_details: null,
    amount: '100000000',
    amount_capturable: '0',
    amount_received: '0',
    amount_refunded: '0',
    currency: 'FAIR',
    capture_method: 'automatic',
    setup_future_usage: null,
    customer: null,
    payment_method: null,
    latest_charge: null,
    next_action: null,
    last_payment_error: null,
    cancellation_reason: null,
    canceled_at: null,
    description: null,
    receipt_email: null,
    statement_descriptor_suffix: null,
    shipping: null,
    faircoin: {
      network: 'testnet',
      address: 'TAddress',
      outputs: [{ address: 'TAddress', amount: '100000000', connected_account: null }],
      txid: null,
      confirmations: 0,
      required_confirmations: 2,
      quote: null,
      recipient_key_replaced_at: null,
    },
    merchant_id: 'merch_test',
    connected_account: null,
    application_fee_amount: null,
    transfer_data: null,
    on_behalf_of: null,
    client_secret: 'pi_test_secret',
    metadata: {},
    expires_at: 2_000,
    can_expire: true,
    created: 1_000,
    updated_at: 1_500,
    ...overrides,
  };
}

/** A card payment fixture: no chain side, waiting for a payment method. */
export function cardIntentFixture(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return intentFixture({
    rail: 'card',
    payment_method_types: ['card'],
    currency: 'EUR',
    amount: '2500',
    status: 'requires_payment_method',
    faircoin: null,
    ...overrides,
  });
}
