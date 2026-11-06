import type { PaymentIntent } from '@peable.to/shared-types';

/**
 * A complete wire `PaymentIntent` (ADR 0019) for suites that need a DTO and not
 * a row: a succeeded FairCoin payment, overridable field by field.
 */
export function intentDTO(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_0000000000000000000000a1',
    object: 'payment_intent',
    livemode: false,
    status: 'succeeded',
    rail: 'faircoin',
    payment_method_types: ['faircoin'],
    payment_method_configuration_details: null,
    amount: '100000000',
    amount_capturable: '0',
    amount_received: '100000000',
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
      address: 'TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3',
      outputs: [
        {
          address: 'TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3',
          amount: '100000000',
          connected_account: null,
        },
      ],
      txid: 'tx_1',
      confirmations: 2,
      required_confirmations: 1,
      quote: null,
      recipient_key_replaced_at: null,
    },
    merchant_id: 'merch_1',
    connected_account: null,
    application_fee_amount: null,
    transfer_data: null,
    on_behalf_of: null,
    client_secret: 'pi_0000000000000000000000a1_secret_x',
    metadata: {},
    expires_at: 1_784_332_800,
    can_expire: false,
    created: 1_784_332_800,
    updated_at: 1_784_332_800,
    ...overrides,
  };
}
