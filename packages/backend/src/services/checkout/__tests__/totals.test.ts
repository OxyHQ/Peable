import { describe, expect, test } from 'bun:test';
import type { StoredLinePrice } from '../../../db/schema/checkout';
import type { PricingCoupon, PricingPromotionCode } from '../../catalog/pricing';
import { allocate, orderTotals, taxBases, type TotalsLine } from '../totals';

const NOW = new Date('2026-11-03T12:00:00Z');

function perUnit(unitAmount: string): StoredLinePrice {
  return {
    billingScheme: 'per_unit',
    unitAmount,
    tiers: null,
    tiersMode: null,
    transformQuantity: null,
    recurring: null,
  };
}

function line(
  key: string,
  price: StoredLinePrice,
  quantity: number,
  productId: string | null = null,
): TotalsLine {
  return { key, currency: 'EUR', price, quantity, productId };
}

function coupon(values: Partial<PricingCoupon>): PricingCoupon {
  return {
    percentOffBps: null,
    amountOff: null,
    currency: null,
    redeemBy: null,
    maxRedemptions: null,
    timesRedeemed: 0,
    deleted: false,
    appliesToProducts: null,
    ...values,
  };
}

function totals(result: ReturnType<typeof orderTotals>) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.totals;
}

describe('order totals', () => {
  test('multiplies per-unit prices and prices tiers by quantity', () => {
    const graduated: StoredLinePrice = {
      billingScheme: 'tiered',
      unitAmount: null,
      tiers: [
        { up_to: 10, unit_amount: '100', flat_amount: null },
        { up_to: null, unit_amount: '50', flat_amount: '20' },
      ],
      tiersMode: 'graduated',
      transformQuantity: null,
      recurring: null,
    };
    const t = totals(
      orderTotals([line('a', perUnit('199'), 3), line('b', graduated, 12)], null, { now: NOW }),
    );
    expect(t.lines.map((l) => l.amountSubtotal)).toEqual([597n, 1000n + 2n * 50n + 20n]);
    expect(t.amountTotal).toBe(597n + 1120n);
    expect(t.amountDiscount).toBe(0n);
  });

  test('a percentage rounds half up once per line', () => {
    const t = totals(
      orderTotals(
        [line('a', perUnit('333'), 1), line('b', perUnit('333'), 1)],
        { coupon: coupon({ percentOffBps: 1500 }) },
        { now: NOW },
      ),
    );
    expect(t.lines.map((l) => l.amountDiscount)).toEqual([50n, 50n]);
    expect(t.amountTotal).toBe(666n - 100n);
  });

  test('an amount off is capped and allocated in proportion, summing exactly', () => {
    const t = totals(
      orderTotals(
        [line('a', perUnit('100'), 1), line('b', perUnit('200'), 1), line('c', perUnit('700'), 1)],
        { coupon: coupon({ amountOff: 101n, currency: 'EUR' }) },
        { now: NOW },
      ),
    );
    expect(t.amountDiscount).toBe(101n);
    expect(t.lines.reduce((sum, l) => sum + l.amountDiscount, 0n)).toBe(101n);
    const capped = totals(
      orderTotals(
        [line('a', perUnit('50'), 1)],
        { coupon: coupon({ amountOff: 500n, currency: 'EUR' }) },
        { now: NOW },
      ),
    );
    expect(capped.amountTotal).toBe(0n);
  });

  test('applies_to restricts the discount to its products and refuses an order with none', () => {
    const restricted = coupon({ percentOffBps: 5000, appliesToProducts: ['prod-a'] });
    const t = totals(
      orderTotals(
        [line('a', perUnit('100'), 1, 'prod-a'), line('b', perUnit('100'), 1, 'prod-b')],
        { coupon: restricted },
        { now: NOW },
      ),
    );
    expect(t.lines.map((l) => l.amountDiscount)).toEqual([50n, 0n]);
    const none = orderTotals(
      [line('b', perUnit('100'), 1, 'prod-b')],
      { coupon: restricted },
      { now: NOW },
    );
    expect(none).toEqual({ ok: false, reason: 'coupon_not_applicable' });
  });

  test("a promotion code's minimum is judged on the order and its limits are named", () => {
    const code: PricingPromotionCode = {
      active: true,
      customerId: null,
      expiresAt: null,
      maxRedemptions: 1,
      timesRedeemed: 1,
      firstTimeTransaction: false,
      minimumAmount: null,
      minimumAmountCurrency: null,
    };
    expect(
      orderTotals(
        [line('a', perUnit('100'), 1)],
        { coupon: coupon({ percentOffBps: 100 }), promotionCode: code },
        { now: NOW },
      ),
    ).toEqual({ ok: false, reason: 'promotion_code_max_redemptions' });
    const minimum = {
      ...code,
      timesRedeemed: 0,
      minimumAmount: 1000n,
      minimumAmountCurrency: 'EUR' as const,
    };
    expect(
      orderTotals(
        [line('a', perUnit('600'), 1)],
        { coupon: coupon({ percentOffBps: 100 }), promotionCode: minimum },
        { now: NOW },
      ),
    ).toEqual({ ok: false, reason: 'promotion_code_minimum_amount' });
    expect(
      orderTotals(
        [line('a', perUnit('600'), 2)],
        { coupon: coupon({ percentOffBps: 100 }), promotionCode: minimum },
        { now: NOW },
      ).ok,
    ).toBe(true);
  });

  test('tax is priced after the discount; exclusive adds, inclusive is only reported', () => {
    const lines = [line('a', perUnit('1000'), 1), line('b', perUnit('1000'), 1)];
    const discount = { coupon: coupon({ percentOffBps: 1000 }) };
    const bases = taxBases(lines, discount, { now: NOW });
    if (!bases.ok) throw new Error('refused');
    expect([...bases.bases.values()]).toEqual([900n, 900n]);
    const t = totals(
      orderTotals(
        lines,
        discount,
        { now: NOW },
        new Map([
          ['a', { amountTax: 189n, inclusive: false }],
          ['b', { amountTax: 156n, inclusive: true }],
        ]),
      ),
    );
    expect(t.amountTax).toBe(345n);
    expect(t.amountTotal).toBe(900n + 189n + 900n);
  });

  test('allocate gives the remainder to the largest fractional shares', () => {
    expect(allocate(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(allocate(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocate(7n, [0n, 3n])).toEqual([0n, 7n]);
  });
});
