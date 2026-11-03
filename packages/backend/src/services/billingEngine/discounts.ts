/**
 * Applying a discount to a subscription or an invoice (ADR 0018). The catalog
 * says what a coupon and a promotion code ARE (`pricing.ts` names every
 * refusal); this decides whether one may be applied HERE, counts the
 * redemption, and fixes the window it applies in:
 *
 *  - `once`: the next invoice only (a subscription drops it after drafting it);
 *  - `repeating`: `duration_in_months` from the moment it was applied;
 *  - `forever`: until removed.
 */
import type { CurrencyCode, DiscountParams } from '@peable.to/shared-types';
import { findCouponById, lockCoupon, type CouponRow } from '../../db/catalog/couponRepository';
import { lockPromotionCode, type PromotionCodeRow } from '../../db/catalog/promotionCodeRepository';
import {
  customerHasPaidBefore,
  redeemCoupon,
  redeemPromotionCode,
} from '../../db/billingEngine/redemptionRepository';
import type { Transaction, DatabaseOrTransaction } from '../../db/postgres';
import { applyDiscount, couponIsValid } from '../catalog/pricing';
import { pricingCouponOf, pricingPromotionCodeOf } from '../catalog/pricingRows';
import { BillingEngineError } from './errors';
import { addIntervals } from './periods';

export interface AppliedDiscount {
  readonly coupon: CouponRow;
  readonly promotionCode: PromotionCodeRow | null;
  readonly start: Date;
  readonly end: Date | null;
}

/** The one discount a request names — `coupon`, `promotion_code` or a one-entry `discounts[]`. */
export function discountRequest(input: {
  readonly coupon?: string | undefined;
  readonly promotionCode?: string | undefined;
  readonly discounts?: readonly DiscountParams[] | undefined;
}): { coupon?: string; promotionCode?: string; param: string } | null {
  const named = [input.coupon, input.promotionCode, input.discounts].filter((v) => v !== undefined);
  if (named.length > 1) {
    throw new BillingEngineError(
      'parameter_invalid',
      'pass one of coupon, promotion_code and discounts',
      'discounts',
    );
  }
  if (input.coupon !== undefined) return { coupon: input.coupon, param: 'coupon' };
  if (input.promotionCode !== undefined) {
    return { promotionCode: input.promotionCode, param: 'promotion_code' };
  }
  if (input.discounts === undefined || input.discounts.length === 0) return null;
  if (input.discounts.length > 1) {
    // Stacked discounts compound in an order Orbit does not model yet; one
    // discount is exact, several would be a guess.
    throw new BillingEngineError(
      'parameter_invalid',
      'at most one discount applies to a subscription or an invoice',
      'discounts',
    );
  }
  const [entry] = input.discounts;
  if (!entry || (entry.coupon === undefined) === (entry.promotion_code === undefined)) {
    throw new BillingEngineError(
      'parameter_invalid',
      'a discount names exactly one of coupon and promotion_code',
      'discounts[0]',
    );
  }
  return entry.coupon !== undefined
    ? { coupon: entry.coupon, param: 'discounts[0][coupon]' }
    : { promotionCode: entry.promotion_code as string, param: 'discounts[0][promotion_code]' };
}

/**
 * Lock, validate and REDEEM a discount for `customerId` at `now`. The
 * redemption is counted in the caller's transaction, so a request that fails
 * later gives it back.
 */
export async function applyDiscountFor(
  tx: Transaction,
  input: {
    readonly merchantId: string;
    readonly customerId: string;
    readonly currency: CurrencyCode;
    readonly now: Date;
    /** The first invoice's subtotal, for a promotion code's minimum. */
    readonly orderTotal: bigint;
    readonly request: { coupon?: string; promotionCode?: string; param: string };
  },
): Promise<AppliedDiscount> {
  const { request } = input;
  let promotionCode: PromotionCodeRow | null = null;
  let coupon: CouponRow | null = null;
  if (request.promotionCode !== undefined) {
    promotionCode = await lockPromotionCode(tx, request.promotionCode, input.merchantId);
    if (!promotionCode) {
      throw new BillingEngineError(
        'resource_missing',
        `no such promotion code: '${request.promotionCode}'`,
        request.param,
      );
    }
    coupon = await lockCoupon(tx, promotionCode.couponPublicId, input.merchantId);
  } else if (request.coupon !== undefined) {
    coupon = await lockCoupon(tx, request.coupon, input.merchantId);
    if (!coupon) {
      throw new BillingEngineError(
        'resource_missing',
        `no such coupon: '${request.coupon}'`,
        request.param,
      );
    }
  }
  if (!coupon) {
    throw new BillingEngineError(
      'coupon_invalid',
      'the coupon of this promotion code was deleted',
      request.param,
    );
  }
  const firstTime = promotionCode?.firstTimeTransaction
    ? !(await customerHasPaidBefore(tx, input.customerId))
    : undefined;
  const verdict = applyDiscount(
    {
      amount: input.orderTotal > 0n ? input.orderTotal : 0n,
      currency: input.currency,
      now: input.now,
      // `applies_to` is judged per line when invoices are priced; here only
      // whether the coupon can be redeemed at all.
      customerId: input.customerId,
      firstTimeTransaction: firstTime,
    },
    { ...pricingCouponOf(coupon), appliesToProducts: null },
    promotionCode ? pricingPromotionCodeOf(promotionCode) : undefined,
  );
  if (!verdict.ok) {
    throw new BillingEngineError(
      verdict.reason.startsWith('promotion_code') ? 'promotion_code_invalid' : 'coupon_invalid',
      `this discount cannot be applied: ${verdict.reason}`,
      request.param,
    );
  }
  if (!(await redeemCoupon(tx, coupon.id))) {
    throw new BillingEngineError(
      'coupon_invalid',
      'this coupon has no redemptions left',
      request.param,
    );
  }
  if (promotionCode && !(await redeemPromotionCode(tx, promotionCode.id))) {
    throw new BillingEngineError(
      'promotion_code_invalid',
      'this promotion code has no redemptions left',
      request.param,
    );
  }
  return {
    coupon,
    promotionCode,
    start: input.now,
    end:
      coupon.duration === 'repeating' && coupon.durationInMonths !== null
        ? addIntervals(input.now, 'month', coupon.durationInMonths)
        : null,
  };
}

/** The coupon a stored discount names, if it still applies to an invoice at `at`. */
export async function couponInEffect(
  db: DatabaseOrTransaction,
  discount: {
    readonly couponId: string | null;
    readonly start: Date | null;
    readonly end: Date | null;
  },
  at: Date,
): Promise<CouponRow | null> {
  if (discount.couponId === null || discount.start === null) return null;
  if (at.getTime() < discount.start.getTime()) return null;
  if (discount.end !== null && at.getTime() >= discount.end.getTime()) return null;
  return findCouponById(db, discount.couponId);
}

export { couponIsValid };
