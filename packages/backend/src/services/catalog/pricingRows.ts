import type { CouponRow } from '../../db/catalog/couponRepository';
import type { PriceRow, PriceShape } from '../../db/catalog/priceRepository';
import type { PromotionCodeRow } from '../../db/catalog/promotionCodeRepository';
import { toBaseUnits } from '../../lib/money';
import type { PricingCoupon, PricingPrice, PricingPromotionCode } from './pricing';

/**
 * Stored catalog rows → the shapes `pricing.ts` computes over. The one place a
 * stored amount string becomes a `bigint` for pricing, through the same guard
 * (`toBaseUnits`) every other amount in the gateway passes.
 */

/** A stored price, priced. */
export function pricingPriceOf(row: PriceRow): PricingPrice {
  return pricingPriceOfShape({
    currency: row.currency,
    unitAmount: row.unitAmount,
    billingScheme: row.billingScheme,
    tiers: row.tiers,
    tiersMode: row.tiersMode,
    transformQuantity:
      row.transformQuantityDivideBy !== null && row.transformQuantityRound !== null
        ? { divideBy: row.transformQuantityDivideBy, round: row.transformQuantityRound }
        : null,
    recurring: null,
    taxBehavior: row.taxBehavior,
  });
}

/** A price shape — stored, or an inline `price_data` — priced. */
export function pricingPriceOfShape(shape: PriceShape): PricingPrice {
  if (shape.billingScheme === 'tiered') {
    if (shape.tiers === null || shape.tiersMode === null) {
      throw new Error('a tiered price shape without tiers');
    }
    return {
      currency: shape.currency,
      billingScheme: 'tiered',
      tiersMode: shape.tiersMode,
      tiers: shape.tiers.map((tier) => ({
        upTo: tier.up_to === null ? null : BigInt(tier.up_to),
        unitAmount: tier.unit_amount === null ? 0n : toBaseUnits(tier.unit_amount),
        flatAmount: tier.flat_amount === null ? 0n : toBaseUnits(tier.flat_amount),
      })),
    };
  }
  if (shape.unitAmount === null) throw new Error('a per-unit price shape without an amount');
  return {
    currency: shape.currency,
    billingScheme: 'per_unit',
    unitAmount: toBaseUnits(shape.unitAmount),
    transformQuantity: shape.transformQuantity
      ? {
          divideBy: BigInt(shape.transformQuantity.divideBy),
          round: shape.transformQuantity.round,
        }
      : null,
  };
}

export function pricingCouponOf(row: CouponRow): PricingCoupon {
  return {
    percentOffBps: row.percentOffBps,
    amountOff: row.amountOff === null ? null : toBaseUnits(row.amountOff),
    currency: row.currency,
    redeemBy: row.redeemBy,
    maxRedemptions: row.maxRedemptions,
    timesRedeemed: row.timesRedeemed,
    deleted: row.deletedAt !== null,
    appliesToProducts: row.appliesToProductIds,
  };
}

export function pricingPromotionCodeOf(row: PromotionCodeRow): PricingPromotionCode {
  return {
    active: row.active,
    customerId: row.customerId,
    expiresAt: row.expiresAt,
    maxRedemptions: row.maxRedemptions,
    timesRedeemed: row.timesRedeemed,
    firstTimeTransaction: row.firstTimeTransaction,
    minimumAmount: row.minimumAmount === null ? null : toBaseUnits(row.minimumAmount),
    minimumAmountCurrency: row.minimumAmountCurrency,
  };
}
