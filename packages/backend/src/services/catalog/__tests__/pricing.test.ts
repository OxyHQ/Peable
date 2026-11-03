/**
 * `pricing.ts` — every amount rule the catalog promises, in exact integers.
 */
import { describe, expect, test } from 'bun:test';
import {
  amountForQuantity,
  applyDiscount,
  couponIsValid,
  discountAmount,
  type PricingCoupon,
  type PricingPrice,
  type PricingPromotionCode,
  type PricingTier,
  transformedQuantity,
} from '../pricing';

const perUnit = (
  unitAmount: bigint,
  transformQuantity: { divideBy: bigint; round: 'up' | 'down' } | null = null,
): PricingPrice => ({ currency: 'EUR', billingScheme: 'per_unit', unitAmount, transformQuantity });

const tiered = (tiersMode: 'graduated' | 'volume', tiers: PricingTier[]): PricingPrice => ({
  currency: 'EUR',
  billingScheme: 'tiered',
  tiersMode,
  tiers,
});

const tier = (upTo: bigint | null, unitAmount: bigint, flatAmount = 0n): PricingTier => ({
  upTo,
  unitAmount,
  flatAmount,
});

/** 1–5 at 10.00, 6–10 at 8.00 + 5.00 flat, 11+ at 5.00. */
const TIERS = [tier(5n, 1000n), tier(10n, 800n, 500n), tier(null, 500n)];

describe('per-unit amounts', () => {
  test('multiply the unit amount by the quantity', () => {
    expect(amountForQuantity(perUnit(1999n), 0n)).toBe(0n);
    expect(amountForQuantity(perUnit(1999n), 1n)).toBe(1999n);
    expect(amountForQuantity(perUnit(1999n), 3n)).toBe(5997n);
  });

  test('stay exact far beyond a JS number (a FAIR amount)', () => {
    const fair: PricingPrice = {
      currency: 'FAIR',
      billingScheme: 'per_unit',
      unitAmount: 99_999_999_999_999_999n,
      transformQuantity: null,
    };
    expect(amountForQuantity(fair, 1_000n)).toBe(99_999_999_999_999_999_000n);
  });

  test('refuse a negative quantity', () => {
    expect(() => amountForQuantity(perUnit(100n), -1n)).toThrow(RangeError);
  });
});

describe('transform_quantity', () => {
  test('round up bills a started pack', () => {
    expect(transformedQuantity(11n, { divideBy: 10n, round: 'up' })).toBe(2n);
    expect(transformedQuantity(10n, { divideBy: 10n, round: 'up' })).toBe(1n);
    expect(transformedQuantity(1n, { divideBy: 10n, round: 'up' })).toBe(1n);
    expect(transformedQuantity(0n, { divideBy: 10n, round: 'up' })).toBe(0n);
  });

  test('round down bills only full packs', () => {
    expect(transformedQuantity(19n, { divideBy: 10n, round: 'down' })).toBe(1n);
    expect(transformedQuantity(9n, { divideBy: 10n, round: 'down' })).toBe(0n);
  });

  test('applies before the unit amount', () => {
    expect(amountForQuantity(perUnit(500n, { divideBy: 10n, round: 'up' }), 11n)).toBe(1000n);
    expect(amountForQuantity(perUnit(500n, { divideBy: 10n, round: 'down' }), 11n)).toBe(500n);
  });

  test('none is the identity', () => {
    expect(transformedQuantity(7n, null)).toBe(7n);
  });

  test('refuses a divisor under one', () => {
    expect(() => transformedQuantity(1n, { divideBy: 0n, round: 'up' })).toThrow(RangeError);
  });
});

describe('volume tiers', () => {
  const price = tiered('volume', TIERS);

  test('price the WHOLE quantity at the tier it falls into', () => {
    expect(amountForQuantity(price, 3n)).toBe(3000n);
    expect(amountForQuantity(price, 5n)).toBe(5000n); // up_to is inclusive
    expect(amountForQuantity(price, 6n)).toBe(6n * 800n + 500n);
    expect(amountForQuantity(price, 10n)).toBe(10n * 800n + 500n);
    expect(amountForQuantity(price, 11n)).toBe(11n * 500n);
  });

  test('quantity zero falls in the first tier (its flat amount applies)', () => {
    expect(amountForQuantity(tiered('volume', [tier(null, 100n, 250n)]), 0n)).toBe(250n);
    expect(amountForQuantity(price, 0n)).toBe(0n);
  });
});

describe('graduated tiers', () => {
  const price = tiered('graduated', TIERS);

  test("each unit takes its tier's rate, plus each reached tier's flat amount", () => {
    expect(amountForQuantity(price, 3n)).toBe(3000n);
    expect(amountForQuantity(price, 5n)).toBe(5000n);
    expect(amountForQuantity(price, 6n)).toBe(5000n + 800n + 500n);
    expect(amountForQuantity(price, 10n)).toBe(5000n + 5n * 800n + 500n);
    expect(amountForQuantity(price, 12n)).toBe(5000n + 4000n + 500n + 2n * 500n);
  });

  test("the first tier's flat amount is charged at quantity zero", () => {
    const flatFirst = tiered('graduated', [tier(10n, 0n, 900n), tier(null, 100n)]);
    expect(amountForQuantity(flatFirst, 0n)).toBe(900n);
    expect(amountForQuantity(flatFirst, 10n)).toBe(900n);
    expect(amountForQuantity(flatFirst, 11n)).toBe(1000n);
  });

  test('a single open tier is per-unit with a flat fee', () => {
    expect(amountForQuantity(tiered('graduated', [tier(null, 300n, 50n)]), 4n)).toBe(1250n);
  });

  test('refuse tiers that are not ascending or not closed by an open tier', () => {
    expect(() => amountForQuantity(tiered('graduated', []), 1n)).toThrow(RangeError);
    expect(() => amountForQuantity(tiered('graduated', [tier(5n, 1n)]), 1n)).toThrow(RangeError);
    expect(() =>
      amountForQuantity(tiered('graduated', [tier(5n, 1n), tier(5n, 1n), tier(null, 1n)]), 1n),
    ).toThrow(RangeError);
    expect(() => amountForQuantity(tiered('volume', [tier(null, 1n), tier(null, 1n)]), 1n)).toThrow(
      RangeError,
    );
  });
});

const NOW = new Date('2026-11-03T12:00:00Z');

function coupon(overrides: Partial<PricingCoupon> = {}): PricingCoupon {
  return {
    percentOffBps: 1500,
    amountOff: null,
    currency: null,
    redeemBy: null,
    maxRedemptions: null,
    timesRedeemed: 0,
    deleted: false,
    appliesToProducts: null,
    ...overrides,
  };
}

function promo(overrides: Partial<PricingPromotionCode> = {}): PricingPromotionCode {
  return {
    active: true,
    customerId: null,
    expiresAt: null,
    maxRedemptions: null,
    timesRedeemed: 0,
    firstTimeTransaction: false,
    minimumAmount: null,
    minimumAmountCurrency: null,
    ...overrides,
  };
}

describe('percent discounts', () => {
  test('round half up, once per line', () => {
    // 15% of 333 = 49.95 → 50; of 330 = 49.5 → 50; of 329 = 49.35 → 49.
    expect(discountAmount(333n, 'EUR', coupon())).toBe(50n);
    expect(discountAmount(330n, 'EUR', coupon())).toBe(50n);
    expect(discountAmount(329n, 'EUR', coupon())).toBe(49n);
  });

  test('two-decimal percentages are basis points', () => {
    // 12.5% of 999 = 124.875 → 125; 33.33% of 100 = 33.33 → 33.
    expect(discountAmount(999n, 'EUR', coupon({ percentOffBps: 1250 }))).toBe(125n);
    expect(discountAmount(100n, 'EUR', coupon({ percentOffBps: 3333 }))).toBe(33n);
    expect(discountAmount(1n, 'EUR', coupon({ percentOffBps: 1 }))).toBe(0n);
  });

  test('100% takes the whole line and never more', () => {
    expect(discountAmount(12_345n, 'EUR', coupon({ percentOffBps: 10_000 }))).toBe(12_345n);
  });

  test('stay exact on a FAIR-sized amount', () => {
    expect(discountAmount(10n ** 20n + 1n, 'FAIR', coupon({ percentOffBps: 5000 }))).toBe(
      5n * 10n ** 19n + 1n,
    );
  });

  test('refuse a percentage outside (0, 100]', () => {
    expect(() => discountAmount(1n, 'EUR', coupon({ percentOffBps: 0 }))).toThrow(RangeError);
    expect(() => discountAmount(1n, 'EUR', coupon({ percentOffBps: 10_001 }))).toThrow(RangeError);
  });
});

describe('amount discounts', () => {
  const fiveEuros = coupon({ percentOffBps: null, amountOff: 500n, currency: 'EUR' });

  test('take the fixed amount, capped at the line', () => {
    expect(discountAmount(2000n, 'EUR', fiveEuros)).toBe(500n);
    expect(discountAmount(300n, 'EUR', fiveEuros)).toBe(300n);
  });

  test('take nothing in another currency', () => {
    expect(discountAmount(2000n, 'USD', fiveEuros)).toBe(0n);
  });
});

describe('coupon validity', () => {
  test('a live coupon is valid', () => {
    expect(couponIsValid(coupon(), NOW)).toBe(true);
  });

  test('redeem_by is the last redeemable instant', () => {
    expect(couponIsValid(coupon({ redeemBy: NOW }), NOW)).toBe(true);
    expect(couponIsValid(coupon({ redeemBy: new Date(NOW.getTime() - 1) }), NOW)).toBe(false);
  });

  test('a used-up or deleted coupon is not', () => {
    expect(couponIsValid(coupon({ maxRedemptions: 2, timesRedeemed: 2 }), NOW)).toBe(false);
    expect(couponIsValid(coupon({ maxRedemptions: 2, timesRedeemed: 1 }), NOW)).toBe(true);
    expect(couponIsValid(coupon({ deleted: true }), NOW)).toBe(false);
  });
});

describe('applyDiscount', () => {
  const context = { amount: 1000n, currency: 'EUR' as const, now: NOW, productId: 'p1' };

  test('discount plus total is always the amount', () => {
    expect(applyDiscount(context, coupon())).toEqual({ ok: true, discount: 150n, total: 850n });
  });

  test('names every refusal', () => {
    expect(applyDiscount(context, coupon({ deleted: true }))).toEqual({
      ok: false,
      reason: 'coupon_invalid',
    });
    expect(
      applyDiscount(context, coupon({ percentOffBps: null, amountOff: 100n, currency: 'USD' })),
    ).toEqual({ ok: false, reason: 'coupon_currency_mismatch' });
    expect(applyDiscount(context, coupon({ appliesToProducts: ['p2'] }))).toEqual({
      ok: false,
      reason: 'coupon_not_applicable',
    });
    expect(
      applyDiscount({ ...context, productId: undefined }, coupon({ appliesToProducts: ['p1'] })),
    ).toEqual({ ok: false, reason: 'coupon_not_applicable' });
    expect(applyDiscount(context, coupon(), promo({ active: false }))).toEqual({
      ok: false,
      reason: 'promotion_code_inactive',
    });
    expect(applyDiscount(context, coupon(), promo({ customerId: 'cus_a' }))).toEqual({
      ok: false,
      reason: 'promotion_code_customer_mismatch',
    });
    expect(applyDiscount(context, coupon(), promo({ expiresAt: NOW }))).toEqual({
      ok: false,
      reason: 'promotion_code_expired',
    });
    expect(
      applyDiscount(context, coupon(), promo({ maxRedemptions: 1, timesRedeemed: 1 })),
    ).toEqual({ ok: false, reason: 'promotion_code_max_redemptions' });
    expect(
      applyDiscount(
        context,
        coupon(),
        promo({ minimumAmount: 1001n, minimumAmountCurrency: 'EUR' }),
      ),
    ).toEqual({ ok: false, reason: 'promotion_code_minimum_amount' });
    expect(
      applyDiscount(context, coupon(), promo({ minimumAmount: 1n, minimumAmountCurrency: 'USD' })),
    ).toEqual({ ok: false, reason: 'promotion_code_minimum_amount' });
    expect(applyDiscount(context, coupon(), promo({ firstTimeTransaction: true }))).toEqual({
      ok: false,
      reason: 'promotion_code_first_time_only',
    });
  });

  test('a promotion code that passes every restriction redeems its coupon', () => {
    const restricted = promo({
      customerId: 'cus_a',
      expiresAt: new Date(NOW.getTime() + 1000),
      maxRedemptions: 5,
      timesRedeemed: 4,
      firstTimeTransaction: true,
      minimumAmount: 1500n,
      minimumAmountCurrency: 'EUR',
    });
    expect(
      applyDiscount(
        { ...context, customerId: 'cus_a', firstTimeTransaction: true, orderTotal: 1500n },
        coupon({ appliesToProducts: ['p1'] }),
        restricted,
      ),
    ).toEqual({ ok: true, discount: 150n, total: 850n });
  });

  test('the minimum is judged on the order total when one is given', () => {
    const minimum = promo({ minimumAmount: 1500n, minimumAmountCurrency: 'EUR' });
    expect(applyDiscount({ ...context, orderTotal: 1499n }, coupon(), minimum).ok).toBe(false);
    expect(applyDiscount({ ...context, orderTotal: 1500n }, coupon(), minimum).ok).toBe(true);
  });
});
