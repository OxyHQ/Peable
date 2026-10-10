import { test, expect } from 'bun:test';
import { toBaseUnits, fromBaseUnits } from '../money';

/**
 * These three tests are RESCUED from `models/__tests__/models.test.ts`, which
 * the Mongo→Postgres switch deleted along with the models it tested.
 *
 * They were never model tests. They sat in that file only because it was the
 * one place that already imported `lib/money.ts`, and deleting the file took
 * the ONLY coverage of base-unit conversion with it — invisibly, because the
 * switch's expected test delta made the loss look like part of the deletion.
 *
 * The conversion matters: `toBaseUnits` is what the settlement watcher compares
 * an on-chain payment against, so a rounding or sign bug here decides whether a
 * payer is credited. No float ever touches a money value.
 */

test('toBaseUnits / fromBaseUnits round-trip canonical integer strings', () => {
  expect(toBaseUnits('150000000')).toBe(150_000_000n);
  expect(fromBaseUnits(150_000_000n)).toBe('150000000');
  expect(fromBaseUnits(toBaseUnits('42'))).toBe('42');
  expect(toBaseUnits('0')).toBe(0n);
});

test('toBaseUnits rejects a fractional amount', () => {
  expect(() => toBaseUnits('1.5')).toThrow();
});

test('fromBaseUnits rejects a negative amount', () => {
  expect(() => fromBaseUnits(-1n)).toThrow();
});
