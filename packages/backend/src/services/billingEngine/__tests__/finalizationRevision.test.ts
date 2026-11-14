import { describe, expect, test } from 'bun:test';
import { canonicalFinalizationInput } from '../finalizationRevision';

describe('invoice approval canonical input', () => {
  test('object ordering, exact amounts, dates and Unicode are deterministic', () => {
    const a = {
      z: '<♥>\u2028',
      money: 900719925474099312345n,
      at: new Date('2026-11-13T01:02:03.456Z'),
      nested: { b: '0.000000000001', a: 1 },
    };
    const b = {
      nested: { a: 1, b: '0.000000000001' },
      at: new Date('2026-11-13T01:02:03.456Z'),
      money: '900719925474099312345',
      z: '<♥>\u2028',
    };
    expect(canonicalFinalizationInput(a)).toBe(canonicalFinalizationInput(b));
    expect(canonicalFinalizationInput(a)).toContain('900719925474099312345');
    expect(canonicalFinalizationInput({ ...b, money: '900719925474099312346' })).not.toBe(
      canonicalFinalizationInput(a),
    );
  });
  test.each([NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1, undefined, new Map()])(
    'rejects noncanonical input %s',
    (value) => {
      expect(() => canonicalFinalizationInput({ value })).toThrow(
        'unsupported invoice finalization input',
      );
    },
  );
});
