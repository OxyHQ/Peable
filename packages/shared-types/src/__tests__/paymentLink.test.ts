import { test, expect } from 'bun:test';
import type { PaymentLink, PublicPaymentLink, CreatePaymentLinkParams } from '../paymentLink';

test('PaymentLink is assignable from a representative literal', () => {
  const link: PaymentLink = {
    id: 'link_abc',
    object: 'payment_link',
    amount: '150000000',
    network: 'testnet',
    active: true,
    metadata: { orderId: 'o1' },
    success_url: 'https://merchant.example/thank-you',
    url: 'https://checkout.peable.to/l/link_abc',
    created: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
  };
  expect(link.object).toBe('payment_link');
});

test('PublicPaymentLink carries only display-safe fields', () => {
  const publicLink: PublicPaymentLink = {
    id: 'link_abc',
    object: 'payment_link',
    amount: '150000000',
    network: 'testnet',
    active: true,
    merchant: { name: 'Acme', avatar_url: null, description: null },
  };
  expect(publicLink.merchant.name).toBe('Acme');
});

test('CreatePaymentLinkParams accepts the minimal required shape', () => {
  const params: CreatePaymentLinkParams = { amount: '150000000', network: 'testnet' };
  expect(params.metadata).toBeUndefined();
});
