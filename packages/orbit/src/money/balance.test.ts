import { describe, expect, it } from 'bun:test';
import type { Balance } from '@peable.to/shared-types';
import { balanceRows, informationalRows, payableCurrencies, unresolvedMismatches } from './balance';

const balance: Balance = {
  object: 'balance',
  livemode: false,
  available: [
    { amount: '12500', currency: 'eur' },
    { amount: '0', currency: 'usd' },
  ],
  pending: [
    { amount: '-300', currency: 'EUR' },
    { amount: '900', currency: 'gbp' },
  ],
  informational: [{ amount: '100000000', currency: 'FAIR' }],
  account: 'ca_1',
};

describe('balanceRows', () => {
  it('lines up available and pending per currency, keeping an absent figure absent', () => {
    expect(balanceRows(balance)).toEqual([
      { currency: 'EUR', available: '12500', pending: '-300' },
      { currency: 'GBP', available: null, pending: '900' },
      { currency: 'USD', available: '0', pending: null },
    ]);
  });

  it('is empty for a balance with nothing in it, rather than inventing zeros', () => {
    expect(balanceRows({ ...balance, available: [], pending: [] })).toEqual([]);
  });
});

describe('informationalRows', () => {
  it('keeps FairCoin apart from the payable balance', () => {
    expect(informationalRows(balance)).toEqual([{ currency: 'FAIR', amount: '100000000' }]);
    expect(balanceRows(balance).some((row) => row.currency === 'FAIR')).toBe(false);
  });
});

describe('unresolvedMismatches', () => {
  it('keeps the ones still seen, oldest first', () => {
    expect(
      unresolvedMismatches([
        { id: 'b', resolved_at: null, detected_at: 20 },
        { id: 'a', resolved_at: 15, detected_at: 10 },
        { id: 'c', resolved_at: null, detected_at: 5 },
      ]).map((m) => m.id),
    ).toEqual(['c', 'b']);
  });
});

describe('payableCurrencies', () => {
  it('offers only a positive available figure in a currency Orbit can format', () => {
    expect(payableCurrencies(balance)).toEqual([{ currency: 'EUR', amount: '12500' }]);
  });

  it('offers nothing when every figure is zero or negative', () => {
    expect(
      payableCurrencies({ ...balance, available: [{ amount: '-10', currency: 'eur' }] }),
    ).toEqual([]);
  });

  it('never offers FairCoin, even if it appeared as available', () => {
    expect(
      payableCurrencies({ ...balance, available: [{ amount: '5', currency: 'FAIR' }] }),
    ).toEqual([]);
  });
});
