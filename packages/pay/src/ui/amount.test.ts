import { describe, test, expect } from 'bun:test';
import { UNITS_PER_COIN } from '@fairco.in/core';
import {
  DEFAULT_PRESETS_SAT,
  amountEntryMessage,
  amountInputFor,
  parseAmountInput,
  sanitizeAmountInput,
} from './amount';

describe('parseAmountInput', () => {
  test('a whole number is base units', () => {
    expect(parseAmountInput('1')).toEqual({ kind: 'ok', amountSat: UNITS_PER_COIN });
  });

  test('a decimal is scaled, not floated', () => {
    expect(parseAmountInput('0.00000001')).toEqual({ kind: 'ok', amountSat: 1n });
    expect(parseAmountInput('1234.56789012')).toEqual({
      kind: 'ok',
      amountSat: 123456789012n,
    });
  });

  test('an empty or blank field has not made a mistake', () => {
    expect(parseAmountInput('')).toEqual({ kind: 'empty' });
    expect(parseAmountInput('   ')).toEqual({ kind: 'empty' });
    expect(amountEntryMessage({ kind: 'empty' })).toBeNull();
  });

  test('a malformed amount is invalid', () => {
    for (const bad of ['abc', '1.2.3', '-1', '1e8', '.']) {
      expect(parseAmountInput(bad).kind).toBe('invalid');
    }
  });

  /**
   * The case a `null` check alone would miss: `parseFairToUnits` TRUNCATES past
   * eight decimals, so this parses SUCCESSFULLY to zero. Treated as `ok` it
   * would be quoted, reviewed and sent as a payment of nothing, under a number
   * the payer can see on screen.
   */
  test('an amount below the smallest unit is refused, not rounded into a send', () => {
    expect(parseAmountInput('0.000000001')).toEqual({ kind: 'too-small' });
    expect(parseAmountInput('0')).toEqual({ kind: 'too-small' });
    expect(parseAmountInput('0.00000000')).toEqual({ kind: 'too-small' });
    expect(amountEntryMessage({ kind: 'too-small' })).not.toBeNull();
  });

  test('a grouped number is read as the number it prints', () => {
    // Only after sanitising — the raw string is what `parseFairToUnits` rejects.
    expect(parseAmountInput(sanitizeAmountInput('1,234.5'))).toEqual({
      kind: 'ok',
      amountSat: 1234n * UNITS_PER_COIN + UNITS_PER_COIN / 2n,
    });
  });
});

describe('sanitizeAmountInput', () => {
  test('drops anything that is not a digit or a point', () => {
    expect(sanitizeAmountInput('12a3')).toBe('123');
    expect(sanitizeAmountInput('⊜ 4.5')).toBe('4.5');
  });

  /**
   * The two readings of a comma are a thousand apart, so blanket stripping is a
   * silent ten-fold overpayment for anyone who writes `1,5` for one and a half.
   * Commas go only when EVERY one of them is in a grouping position.
   */
  test('a comma is only a thousands separator when the whole number is grouped', () => {
    expect(sanitizeAmountInput('1,234.56')).toBe('1234.56');
    expect(sanitizeAmountInput('12,345,678')).toBe('12345678');
    expect(sanitizeAmountInput('1,5')).toBe('1.5');
    expect(sanitizeAmountInput('1 234,56')).toBe('1234.56');
  });

  test('keeps only the first decimal point', () => {
    expect(sanitizeAmountInput('1.2.3')).toBe('1.23');
    expect(sanitizeAmountInput('...')).toBe('.');
  });

  test('leaves a well-formed amount alone', () => {
    expect(sanitizeAmountInput('1234.5678')).toBe('1234.5678');
  });
});

describe('amountInputFor', () => {
  test('a preset round-trips back through the parser', () => {
    // The regression this exists for: `formatFair` groups thousands, and
    // `parseFairToUnits` returns null for a comma — so a preset above 999 would
    // put its own field into the invalid state.
    for (const preset of [...DEFAULT_PRESETS_SAT, 1_000n * UNITS_PER_COIN, 1n]) {
      const text = amountInputFor(preset);
      expect(text).not.toContain(',');
      expect(parseAmountInput(text)).toEqual({ kind: 'ok', amountSat: preset });
    }
  });

  test('reads as a person would write it', () => {
    expect(amountInputFor(UNITS_PER_COIN)).toBe('1');
    expect(amountInputFor(UNITS_PER_COIN + UNITS_PER_COIN / 2n)).toBe('1.5');
  });
});
