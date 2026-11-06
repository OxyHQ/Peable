import { describe, expect, test } from 'bun:test';
import { splitFaircoinAmount } from '../split';

const total = (shares: { amount: bigint }[]) => shares.reduce((acc, s) => acc + s.amount, 0n);

describe('splitFaircoinAmount (ADR 0021 D6)', () => {
  test('one recipient takes the whole amount', () => {
    expect(splitFaircoinAmount(12345n, [{ key: 'a', weight: 999n }])).toEqual([
      { key: 'a', amount: 12345n },
    ]);
  });

  test('proportional shares sum to the total exactly', () => {
    const shares = splitFaircoinAmount(1000n, [
      { key: 'a', weight: 3000n },
      { key: 'b', weight: 1000n },
    ]);
    expect(shares).toEqual([
      { key: 'a', amount: 750n },
      { key: 'b', amount: 250n },
    ]);
  });

  test('the remainder goes to the largest remainders, ties to the earlier recipient', () => {
    // 100 / 3: floors 33, 33, 33, remainders equal — the first gets the unit.
    expect(
      splitFaircoinAmount(100n, [
        { key: 'a', weight: 1n },
        { key: 'b', weight: 1n },
        { key: 'c', weight: 1n },
      ]).map((s) => s.amount),
    ).toEqual([34n, 33n, 33n]);
    // 10 split 1:2:2 → exact 2, 4, 4: no remainder.
    expect(
      splitFaircoinAmount(10n, [
        { key: 'a', weight: 1n },
        { key: 'b', weight: 2n },
        { key: 'c', weight: 2n },
      ]).map((s) => s.amount),
    ).toEqual([2n, 4n, 4n]);
    // 11 split 1:2:2 → exact 2.2, 4.4, 4.4: one unit left, to b (earlier of the two .4s).
    expect(
      splitFaircoinAmount(11n, [
        { key: 'a', weight: 1n },
        { key: 'b', weight: 2n },
        { key: 'c', weight: 2n },
      ]).map((s) => s.amount),
    ).toEqual([2n, 5n, 4n]);
  });

  test('every share is within one unit of the exact share, for many totals', () => {
    const recipients = [
      { key: 'a', weight: 1999n },
      { key: 'b', weight: 1n },
      { key: 'c', weight: 7331n },
      { key: 'd', weight: 250n },
    ];
    const weightSum = 9581n;
    for (let t = 1n; t < 3000n; t += 7n) {
      const shares = splitFaircoinAmount(t, recipients);
      expect(total(shares)).toBe(t);
      for (const share of shares) {
        const weight = recipients.find((r) => r.key === share.key)?.weight ?? 0n;
        const exactFloor = (t * weight) / weightSum;
        expect(share.amount === exactFloor || share.amount === exactFloor + 1n).toBe(true);
      }
    }
  });

  test('a zero share has no output, and all-zero weights share equally', () => {
    expect(
      splitFaircoinAmount(1n, [
        { key: 'a', weight: 5n },
        { key: 'b', weight: 5n },
      ]),
    ).toEqual([{ key: 'a', amount: 1n }]);
    expect(
      splitFaircoinAmount(9n, [
        { key: 'a', weight: 0n },
        { key: 'b', weight: 0n },
      ]).map((s) => s.amount),
    ).toEqual([5n, 4n]);
    expect(
      splitFaircoinAmount(9n, [
        { key: 'a', weight: 0n },
        { key: 'b', weight: 3n },
      ]),
    ).toEqual([{ key: 'b', amount: 9n }]);
  });

  test('refuses what is not a split', () => {
    expect(() => splitFaircoinAmount(1n, [])).toThrow();
    expect(() => splitFaircoinAmount(-1n, [{ key: 'a', weight: 1n }])).toThrow();
    expect(() => splitFaircoinAmount(1n, [{ key: 'a', weight: -1n }])).toThrow();
  });
});
