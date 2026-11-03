import { describe, expect, it } from 'bun:test';
import { CURRENCY_DECIMALS } from '@peable.to/shared-types';
import { formatAmount, formatAmountValue, ORBIT_CURRENCY_DECIMALS, sumBaseUnits } from './money';

describe('ORBIT_CURRENCY_DECIMALS', () => {
  it('is the gateway table, not a copy that can drift', () => {
    expect(ORBIT_CURRENCY_DECIMALS).toEqual({ ...CURRENCY_DECIMALS });
  });
});

describe('formatAmountValue', () => {
  it('formats fiat in cents with both places', () => {
    expect(formatAmountValue('1250', 'EUR')).toBe('12.50');
    expect(formatAmountValue('5', 'USD')).toBe('0.05');
    expect(formatAmountValue('0', 'USD')).toBe('0.00');
  });

  it('groups thousands of the whole part', () => {
    expect(formatAmountValue('123456789', 'USD')).toBe('1,234,567.89');
  });

  it('formats FAIR from its 8 decimals, keeping two and dropping trailing zeros', () => {
    expect(formatAmountValue('100000000', 'FAIR')).toBe('1.00');
    expect(formatAmountValue('12345', 'FAIR')).toBe('0.00012345');
    expect(formatAmountValue('150000000', 'FAIR')).toBe('1.50');
  });

  it('is exact past Number.MAX_SAFE_INTEGER', () => {
    // 2^53 + 1 base units would round through a float.
    expect(formatAmountValue('9007199254740993', 'FAIR')).toBe('90,071,992.54740993');
  });

  it('refuses an amount or currency the gateway never sends', () => {
    expect(formatAmountValue('12.5', 'EUR')).toBeNull();
    expect(formatAmountValue('-1', 'EUR')).toBeNull();
    expect(formatAmountValue('007', 'EUR')).toBeNull();
    expect(formatAmountValue('100', 'GBP')).toBeNull();
    expect(formatAmountValue('100', 'toString')).toBeNull();
  });
});

describe('formatAmount', () => {
  it('appends the currency', () => {
    expect(formatAmount('1250', 'EUR')).toBe('12.50 EUR');
  });

  it('shows an unreadable amount as its raw base units rather than a wrong number', () => {
    expect(formatAmount('100', 'GBP')).toBe('100 (base units) GBP');
  });
});

describe('sumBaseUnits', () => {
  it('adds exactly with bigint', () => {
    expect(sumBaseUnits(['9007199254740993', '1'])).toBe('9007199254740994');
    expect(sumBaseUnits([])).toBe('0');
  });

  it('throws on a float', () => {
    expect(() => sumBaseUnits(['1.5'])).toThrow('Not a base-unit amount');
  });
});
