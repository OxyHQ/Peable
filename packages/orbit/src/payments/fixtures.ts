import type { PaymentIntent } from '@peable.to/shared-types';

/** A complete PaymentIntent for tests; override what the case is about. */
export function intentFixture(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_test',
    object: 'payment_intent',
    status: 'created',
    rail: 'faircoin',
    amount: '100000000',
    currency: 'FAIR',
    network: 'testnet',
    address: 'TAddress',
    merchant_id: 'merch_test',
    livemode: false,
    connected_account: null,
    txid: null,
    confirmations: 0,
    client_secret: 'pi_test_secret',
    metadata: {},
    expires_at: 2_000,
    can_expire: true,
    created: 1_000,
    updated_at: 1_500,
    ...overrides,
  };
}
