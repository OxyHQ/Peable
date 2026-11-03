import { describe, expect, it } from 'bun:test';
import { CURRENCY_DECIMALS } from '@peable.to/shared-types';
import {
  exceedsBaseUnits,
  formatAmount,
  formatAmountValue,
  formatOptionalAmount,
  formatSignedAmount,
  ORBIT_CURRENCY_DECIMALS,
  parseAmountInput,
  sumBaseUnits,
} from './money';

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

  it('formats a zero-decimal currency without a fraction', () => {
    expect(formatAmountValue('1500', 'JPY')).toBe('1,500');
    expect(formatAmountValue('0', 'JPY')).toBe('0');
    expect(formatAmountValue('1250', 'GBP')).toBe('12.50');
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
    expect(formatAmountValue('100', 'BRL')).toBeNull();
    expect(formatAmountValue('100', 'toString')).toBeNull();
  });
});

describe('formatAmount', () => {
  it('appends the currency', () => {
    expect(formatAmount('1250', 'EUR')).toBe('12.50 EUR');
  });

  it('shows an unreadable amount as its raw base units rather than a wrong number', () => {
    expect(formatAmount('100', 'BRL')).toBe('100 (base units) BRL');
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

describe('formatSignedAmount', () => {
  it('formats a ledger figure with its sign, whatever case the currency is in', () => {
    expect(formatSignedAmount('-1500', 'eur')).toBe('-15.00 EUR');
    expect(formatSignedAmount('2395', 'EUR')).toBe('23.95 EUR');
    expect(formatSignedAmount('0', 'usd')).toBe('0.00 USD');
  });

  it('shows an unreadable figure raw rather than a wrong number', () => {
    expect(formatSignedAmount('-0', 'EUR')).toBe('-0 (base units) EUR');
    expect(formatSignedAmount('12', 'xyz')).toBe('12 (base units) XYZ');
  });
});

describe('formatOptionalAmount', () => {
  it('says a missing figure is missing, never zero', () => {
    expect(formatOptionalAmount(null, 'EUR', 'Not reported')).toBe('Not reported');
    expect(formatOptionalAmount('0', 'EUR', 'Not reported')).toBe('0.00 EUR');
  });
});

describe('parseAmountInput', () => {
  it('reads a typed decimal as exact base units', () => {
    expect(parseAmountInput('12.5', 'EUR')).toBe('1250');
    expect(parseAmountInput('1,000.00', 'eur')).toBe('100000');
    expect(parseAmountInput('0.01', 'USD')).toBe('1');
    expect(parseAmountInput('90071992.54740993', 'FAIR')).toBe('9007199254740993');
  });

  it('refuses zero, a sign, too many decimals, or an unknown currency', () => {
    for (const text of ['0', '0.0', '-1', '+1', '1.001', '1e3', '', '.']) {
      expect(parseAmountInput(text, 'EUR')).toBeNull();
    }
    expect(parseAmountInput('1', 'XYZ')).toBeNull();
  });
});

describe('exceedsBaseUnits', () => {
  it('compares exactly, against a negative balance too', () => {
    expect(exceedsBaseUnits('9007199254740994', '9007199254740993')).toBe(true);
    expect(exceedsBaseUnits('1', '-5')).toBe(true);
    expect(exceedsBaseUnits('5', '5')).toBe(false);
  });
});
