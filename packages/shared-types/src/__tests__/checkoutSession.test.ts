import { test, expect } from 'bun:test';
import type {
  CheckoutSession,
  CheckoutSessionPublic,
  CreateCheckoutSessionParams,
} from '../checkoutSession';
import type { PaymentIntent } from '../paymentIntent';

const INTENT: PaymentIntent = {
  id: 'pi_abc',
  object: 'payment_intent',
  livemode: false,
  status: 'requires_action',
  rail: 'faircoin',
  payment_method_types: ['faircoin'],
  amount: '150000000',
  amount_capturable: '0',
  amount_received: '0',
  amount_refunded: '0',
  currency: 'FAIR',
  capture_method: 'automatic',
  setup_future_usage: null,
  customer: null,
  payment_method: null,
  latest_charge: null,
  review: null,
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
    txid: null,
    confirmations: 0,
    required_confirmations: 1,
  },
  merchant_id: 'merch_1',
  connected_account: null,
  client_secret: 'pi_abc_secret_xyz',
  metadata: {},
  expires_at: 1784419500,
  can_expire: true,
  created: 1784418600,
  updated_at: 1784418600,
};

test('CheckoutSession is assignable from a representative literal', () => {
  const session: CheckoutSession = {
    id: 'cs_abc',
    object: 'checkout_session',
    payment_intent: INTENT.id,
    connected_account: null,
    client_secret: INTENT.client_secret,
    amount: INTENT.amount,
    network: 'testnet',
    metadata: {},
    success_url: 'https://merchant.example/success',
    cancel_url: 'https://merchant.example/cancel',
    url: 'https://checkout.peable.to/c/cs_abc',
    created: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
  };
  expect(session.object).toBe('checkout_session');
});

test('CheckoutSessionPublic wraps the full PaymentIntent DTO the page renders from', () => {
  const publicSession: CheckoutSessionPublic = {
    id: 'cs_abc',
    object: 'checkout_session',
    merchant: { name: 'Acme', avatar_url: null, description: null },
    payment_intent: INTENT,
  };
  expect(publicSession.payment_intent.client_secret).toBe(INTENT.client_secret);
});

test('CreateCheckoutSessionParams accepts the minimal required shape', () => {
  const params: CreateCheckoutSessionParams = { amount: '150000000', network: 'testnet' };
  expect(params.success_url).toBeUndefined();
});
