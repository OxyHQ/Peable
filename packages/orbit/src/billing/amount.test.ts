import { describe, expect, it } from 'bun:test';
import { describeBalance, formatSignedAmount } from './amount';

describe('formatSignedAmount', () => {
  it('formats charges and credits exactly, sign kept', () => {
    expect(formatSignedAmount('1999', 'EUR')).toBe('19.99 EUR');
    expect(formatSignedAmount('-500', 'EUR')).toBe('-5.00 EUR');
    expect(formatSignedAmount('0', 'USD')).toBe('0.00 USD');
    expect(formatSignedAmount('-150000000', 'FAIR')).toBe('-1.50 FAIR');
  });

  it('shows anything the gateway would not send as raw text', () => {
    expect(formatSignedAmount('-0', 'EUR')).toBe('-0 (base units) EUR');
    expect(formatSignedAmount('1.5', 'EUR')).toBe('1.5 (base units) EUR');
  });
});

describe('describeBalance', () => {
  it('reads negative as credit the customer holds, positive as owed', () => {
    expect(describeBalance('-1250', 'EUR')).toEqual({ kind: 'credit', amount: '12.50 EUR' });
    expect(describeBalance('300', 'USD')).toEqual({ kind: 'owed', amount: '3.00 USD' });
  });

  it('has nothing to say for a zero or currency-less balance', () => {
    expect(describeBalance('0', 'EUR')).toEqual({ kind: 'none', amount: null });
    expect(describeBalance('0', null)).toEqual({ kind: 'none', amount: null });
  });
});
