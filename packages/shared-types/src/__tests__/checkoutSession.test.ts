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
  status: 'created',
  amount: '150000000',
  currency: 'FAIR',
  network: 'testnet',
  address: 'TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3',
  merchant_id: 'merch_1',
  txid: null,
  confirmations: 0,
  client_secret: 'pi_abc_secret_xyz',
  metadata: {},
  expires_at: '2026-07-19T00:15:00.000Z',
  created: '2026-07-19T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
};

test('CheckoutSession is assignable from a representative literal', () => {
  const session: CheckoutSession = {
    id: 'cs_abc',
    object: 'checkout_session',
    payment_intent: INTENT.id,
    connected_account: null,
    client_secret: INTENT.client_secret,
    amount: INTENT.amount,
    network: INTENT.network,
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
