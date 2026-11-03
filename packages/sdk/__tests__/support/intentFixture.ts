import type { PaymentIntent } from '@peable.to/shared-types';

/**
 * One complete ADR 0019 PaymentIntent, so every suite builds its fixture from
 * the same wire shape and a field added to the contract is added here once.
 * Defaults to a FairCoin intent waiting for the payer's broadcast.
 */
export function paymentIntentFixture(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  const base: PaymentIntent = {
    id: 'pi_0123456789abcdef01234567',
    object: 'payment_intent',
    livemode: false,
    status: 'requires_action',
    rail: 'faircoin',
    payment_method_types: ['faircoin'],
    amount: '100000',
    amount_capturable: '0',
    amount_received: '0',
    amount_refunded: '0',
    currency: 'FAIR',
    capture_method: 'automatic',
    setup_future_usage: null,
    customer: null,
    payment_method: null,
    latest_charge: null,
    next_action: {
      type: 'faircoin_payment',
      faircoin_payment: {
        address: 'addr1',
        network: 'testnet',
        amount: '100000',
        currency: 'FAIR',
        uri: 'faircoin:addr1?amount=0.001',
      },
    },
    last_payment_error: null,
    cancellation_reason: null,
    canceled_at: null,
    description: null,
    receipt_email: null,
    statement_descriptor_suffix: null,
    shipping: null,
    faircoin: {
      network: 'testnet',
      address: 'addr1',
      txid: null,
      confirmations: 0,
      required_confirmations: 1,
    },
    merchant_id: 'merch_1',
    connected_account: null,
    client_secret: 'pi_0123456789abcdef01234567_secret_abc',
    metadata: {},
    expires_at: 1767225600,
    can_expire: true,
    created: 1767225000,
    updated_at: 1767225000,
  };
  return { ...base, ...overrides };
}

/** The same intent once the payer has broadcast (`processing`). */
export function processingFixture(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  const base = paymentIntentFixture();
  return paymentIntentFixture({
    status: 'processing',
    next_action: null,
    can_expire: false,
    faircoin: { ...(base.faircoin as NonNullable<PaymentIntent['faircoin']>), txid: 'tx1' },
    ...overrides,
  });
}

/** A card intent waiting for a payment method. */
export function cardIntentFixture(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return paymentIntentFixture({
    status: 'requires_payment_method',
    rail: 'card',
    payment_method_types: ['card'],
    currency: 'EUR',
    next_action: null,
    faircoin: null,
    ...overrides,
  });
}
