import type { Coupon, Price, Product, PromotionCode } from '@peable.to/shared-types';
import type { CouponRow } from '../db/catalog/couponRepository';
import type { PriceRow } from '../db/catalog/priceRepository';
import type { ProductRow } from '../db/catalog/productRepository';
import type { PromotionCodeRow } from '../db/catalog/promotionCodeRepository';
import { couponIsValid } from '../services/catalog/pricing';
import { pricingCouponOf } from '../services/catalog/pricingRows';
import { toUnix, toUnixOrNull } from './time';

/**
 * The catalog's wire objects (ADR 0014 D1, ADR 0018). Every reference that
 * can be expanded is named without `_id` and rendered as the PUBLIC id of the
 * object it names (`lib/expand.ts`).
 */

export function toProductDTO(row: ProductRow): Product {
  return {
    id: row.publicId,
    object: 'product',
    livemode: row.livemode,
    active: row.active,
    name: row.name,
    description: row.description,
    images: row.images,
    metadata: row.metadata,
    tax_code: row.taxCode,
    default_price: row.defaultPricePublicId,
    unit_label: row.unitLabel,
    url: row.url,
    statement_descriptor: row.statementDescriptor,
    marketing_features: row.marketingFeatures,
    created: toUnix(row.createdAt),
    updated: toUnix(row.updatedAt),
  };
}

export function toPriceDTO(row: PriceRow): Price {
  return {
    id: row.publicId,
    object: 'price',
    livemode: row.livemode,
    active: row.active,
    product: row.productPublicId,
    currency: row.currency,
    unit_amount: row.unitAmount,
    billing_scheme: row.billingScheme,
    tiers: row.tiers,
    tiers_mode: row.tiersMode,
    transform_quantity:
      row.transformQuantityDivideBy !== null && row.transformQuantityRound !== null
        ? { divide_by: row.transformQuantityDivideBy, round: row.transformQuantityRound }
        : null,
    type: row.type,
    recurring:
      row.recurringInterval !== null &&
      row.recurringIntervalCount !== null &&
      row.recurringUsageType !== null
        ? {
            interval: row.recurringInterval,
            interval_count: row.recurringIntervalCount,
            usage_type: row.recurringUsageType,
            meter: row.meterPublicId,
          }
        : null,
    tax_behavior: row.taxBehavior,
    lookup_key: row.lookupKey,
    nickname: row.nickname,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

/**
 * `valid` is judged at `now` — the moment of rendering, so an event's snapshot
 * says whether the coupon was redeemable when the change happened.
 */
export function toCouponDTO(row: CouponRow, now: Date = new Date()): Coupon {
  return {
    id: row.publicId,
    object: 'coupon',
    livemode: row.livemode,
    name: row.name,
    // Basis points back to a percentage: 1250 → 12.5, exact for two decimals.
    percent_off: row.percentOffBps === null ? null : row.percentOffBps / 100,
    amount_off: row.amountOff,
    currency: row.currency,
    duration: row.duration,
    duration_in_months: row.durationInMonths,
    max_redemptions: row.maxRedemptions,
    redeem_by: toUnixOrNull(row.redeemBy),
    times_redeemed: row.timesRedeemed,
    valid: couponIsValid(pricingCouponOf(row), now),
    applies_to: row.appliesToProducts === null ? null : { products: row.appliesToProducts },
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

export function toPromotionCodeDTO(row: PromotionCodeRow): PromotionCode {
  return {
    id: row.publicId,
    object: 'promotion_code',
    livemode: row.livemode,
    code: row.code,
    coupon: row.couponPublicId,
    customer: row.customerPublicId,
    active: row.active,
    max_redemptions: row.maxRedemptions,
    expires_at: toUnixOrNull(row.expiresAt),
    times_redeemed: row.timesRedeemed,
    restrictions: {
      first_time_transaction: row.firstTimeTransaction,
      minimum_amount: row.minimumAmount,
      minimum_amount_currency: row.minimumAmountCurrency,
    },
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}
