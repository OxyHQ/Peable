import { afterEach, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { intentFixture } from '../../__tests__/intentFixture';
import { StatusPanel } from '../StatusPanel';

afterEach(() => {
  cleanup();
});

/**
 * A SEPA Debit is `processing` for days. A spinner saying "being processed..."
 * for three days reads as stuck; the payer is told how long it really takes.
 */
test('says a bank debit takes business days', () => {
  render(
    <StatusPanel
      intent={intentFixture({
        rail: 'card',
        status: 'processing',
        payment_method_types: ['sepa_debit'],
      })}
    />,
  );
  expect(
    screen.getByText('Bank debit submitted — this can take a few business days.'),
  ).toBeDefined();
});

test('keeps the ordinary copy for a card payment', () => {
  render(
    <StatusPanel
      intent={intentFixture({ rail: 'card', status: 'processing', payment_method_types: ['card'] })}
    />,
  );
  expect(screen.getByText('Your payment is being processed…')).toBeDefined();
});
