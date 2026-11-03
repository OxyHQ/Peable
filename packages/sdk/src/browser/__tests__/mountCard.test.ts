import { expect, it } from 'bun:test';
import type { PaymentIntent } from '@peable.to/shared-types';
import { cardStatusText } from '../mount';

const card = (status: PaymentIntent['status'], types: PaymentIntent['payment_method_types']) =>
  ({ rail: 'card', status, payment_method_types: types }) as PaymentIntent;

it("keeps the card fields while the payer can still pay, and reports the gateway's status after", () => {
  expect(cardStatusText(card('requires_payment_method', ['card']))).toBe('');
  expect(cardStatusText(card('requires_action', ['card']))).toBe('');
  expect(cardStatusText(card('processing', ['card']))).toBe('Processing your payment…');
  expect(cardStatusText(card('processing', ['sepa_debit']))).toBe(
    'Bank debit submitted — this can take a few business days.',
  );
  expect(cardStatusText(card('succeeded', ['card']))).toBe('Paid');
  expect(cardStatusText(card('canceled', ['card']))).toBe('Payment unavailable');
});
