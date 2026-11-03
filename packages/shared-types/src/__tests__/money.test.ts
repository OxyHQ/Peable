import { test, expect } from 'bun:test';
import {
  CURRENCY_CODES,
  CURRENCY_DECIMALS,
  FIAT_CURRENCY_CODES,
  UNITS_PER_COIN,
  decimalsFor,
  isBaseUnitString,
  isCurrencyCode,
} from '../money';

/**
 * Two spellings of one consensus fact. `UNITS_PER_COIN` is what the wallet and
 * `@fairco.in/core` divide by; `CURRENCY_DECIMALS.FAIR` is what every
 * currency-generic formatter will read. A drift between them would render every
 * FairCoin amount off by a power of ten, in a direction nothing else notices.
 */
test('FAIR decimals agree with UNITS_PER_COIN', () => {
  expect(10n ** BigInt(CURRENCY_DECIMALS.FAIR)).toBe(UNITS_PER_COIN);
});

/**
 * The gap this table exists to close: a fiat amount divided by
 * `UNITS_PER_COIN` is wrong by six orders of magnitude, and nothing throws.
 */
test('fiat currencies do not share FairCoin scale', () => {
  expect(decimalsFor('EUR')).toBe(2);
  expect(decimalsFor('USD')).toBe(2);
  expect(decimalsFor('FAIR')).toBe(8);
});

/**
 * ISO 4217 minor units. JPY is the one zero-decimal member: an amount of `1500`
 * is fifteen hundred yen, and a formatter that assumed two decimals would show
 * fifteen.
 */
test('the fiat scales are ISO 4217 minor units', () => {
  expect(decimalsFor('JPY')).toBe(0);
  for (const code of ['GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD'] as const) {
    expect(decimalsFor(code)).toBe(2);
  }
  expect(FIAT_CURRENCY_CODES).not.toContain('FAIR');
  expect(FIAT_CURRENCY_CODES.length).toBe(CURRENCY_CODES.length - 1);
});

test('every listed currency has a scale', () => {
  for (const code of CURRENCY_CODES) {
    expect(Number.isInteger(CURRENCY_DECIMALS[code])).toBe(true);
    expect(CURRENCY_DECIMALS[code]).toBeGreaterThanOrEqual(0);
  }
  expect(Object.keys(CURRENCY_DECIMALS).sort()).toEqual([...CURRENCY_CODES].sort());
});

test('isCurrencyCode admits exactly the listed set', () => {
  expect(isCurrencyCode('EUR')).toBe(true);
  expect(isCurrencyCode('FAIR')).toBe(true);
  expect(isCurrencyCode('GBP')).toBe(true);
  expect(isCurrencyCode('BRL')).toBe(false);
  expect(isCurrencyCode('eur')).toBe(false);
});

/**
 * The spelling rule is about the STRING, not the scale — it did not change when
 * the currency set widened, and a fiat amount is validated by the same pattern.
 */
test('the amount pattern is currency-agnostic', () => {
  expect(isBaseUnitString('2500')).toBe(true);
  expect(isBaseUnitString('0')).toBe(true);
  expect(isBaseUnitString('025')).toBe(false);
  expect(isBaseUnitString('25.00')).toBe(false);
  expect(isBaseUnitString('-25')).toBe(false);
});
