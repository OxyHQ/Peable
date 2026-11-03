import { describe, expect, it } from 'bun:test';
import type { PaymentIntent } from '@peable.to/shared-types';
import { startOfDay, volumeSince } from './overview';

const intent = (overrides: Partial<PaymentIntent>): PaymentIntent =>
  ({
    id: 'pi',
    status: 'succeeded',
    currency: 'EUR',
    amount: '1000',
    amount_received: '1000',
    amount_refunded: '0',
    created: 1_000,
    ...overrides,
  }) as PaymentIntent;

describe('volumeSince', () => {
  it('sums only succeeded payments inside the window, per currency, largest first', () => {
    const result = volumeSince(
      [
        intent({ created: 2_000, amount_received: '1500' }),
        intent({ created: 1_900, currency: 'USD', amount_received: '700' }),
        intent({ created: 1_800, amount_received: '250' }),
        intent({ created: 1_700, status: 'canceled', amount_received: '0' }),
        intent({ created: 500, amount_received: '9999' }),
      ],
      1_000,
      false,
    );
    expect(result.succeeded).toBe(3);
    expect(result.volume).toEqual([
      { currency: 'EUR', amount: '1750', count: 2 },
      { currency: 'USD', amount: '700', count: 1 },
    ]);
    // The sample reaches before the window: the figure is whole.
    expect(result.covered).toBe(true);
  });

  it('says when the sample does not reach back to the window start', () => {
    const result = volumeSince([intent({ created: 2_000 })], 1_000, false);
    expect(result.covered).toBe(false);
    expect(volumeSince([intent({ created: 2_000 })], 1_000, true).covered).toBe(true);
  });

  it('starts a day at local midnight', () => {
    const now = Math.floor(new Date(2026, 10, 4, 15, 30).getTime() / 1000);
    expect(startOfDay(now)).toBe(Math.floor(new Date(2026, 10, 4).getTime() / 1000));
  });
});
