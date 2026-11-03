/**
 * Catalog pricing — the one answer to "how much is this" (ADR 0018).
 *
 * Pure: no database, no clock, no provider. Checkout line items, invoice
 * items and subscription renewals call these functions with rows they have
 * already read and the instant they are acting at, so one price, one quantity
 * and one coupon always produce the same amount wherever they are priced.
 *
 * ## Exact integer arithmetic
 *
 * Every amount is a `bigint` in the currency's smallest unit (cents, m⊜). No
 * float touches money: a percentage is basis points (hundredths of a percent)
 * and is applied as an integer ratio.
 *
 * ## Rounding, and where it happens
 *
 * - **A percentage discount rounds half UP, once, on the amount it applies
 *   to** (Stripe rounds percent-off per line the same way): 15% of 333 cents
 *   is 49.95 → 50. Rounding a line once — rather than per unit — is what keeps
 *   `discount + total = amount` exact.
 * - **`transform_quantity` rounds the PACK count** up or down as the price
 *   says, before the per-unit amount multiplies it; nothing else rounds.
 * - Tiers never round: a tier's unit and flat amounts are integers already.
 *
 * ## Tiers
 *
 * `up_to` is inclusive and ascending, the last tier is open (`null`).
 *
 * - `volume`: the whole quantity takes the unit and flat amount of the tier it
 *   falls into.
 * - `graduated`: each unit takes the tier it falls into, and the flat amount
 *   of EVERY tier the quantity reaches is added — including the first tier at
 *   quantity zero, so a graduated price with a flat first tier charges that
 *   flat amount even for no usage (Stripe's behaviour).
 */
import type { CurrencyCode, PriceTiersMode, TransformQuantityRound } from '@peable.to/shared-types';

export interface PricingTier {
  /** Inclusive upper bound; `null` on the last, open tier. */
  readonly upTo: bigint | null;
  readonly unitAmount: bigint;
  readonly flatAmount: bigint;
}

/** A price as pricing needs it — built from a stored price or an inline `price_data`. */
export type PricingPrice =
  | {
      readonly currency: CurrencyCode;
      readonly billingScheme: 'per_unit';
      readonly unitAmount: bigint;
      readonly transformQuantity: {
        readonly divideBy: bigint;
        readonly round: TransformQuantityRound;
      } | null;
    }
  | {
      readonly currency: CurrencyCode;
      readonly billingScheme: 'tiered';
      readonly tiersMode: PriceTiersMode;
      readonly tiers: readonly PricingTier[];
    };

/** The quantity a per-unit price is multiplied by, after `transform_quantity`. */
export function transformedQuantity(
  quantity: bigint,
  transform: { readonly divideBy: bigint; readonly round: TransformQuantityRound } | null,
): bigint {
  assertQuantity(quantity);
  if (transform === null) return quantity;
  if (transform.divideBy < 1n) throw new RangeError('transform_quantity.divide_by must be ≥ 1');
  const whole = quantity / transform.divideBy;
  if (transform.round === 'down' || quantity % transform.divideBy === 0n) return whole;
  return whole + 1n;
}

/**
 * The amount, in base units, of `quantity` of `price` — before any discount
 * and before tax.
 */
export function amountForQuantity(price: PricingPrice, quantity: bigint): bigint {
  assertQuantity(quantity);
  if (price.billingScheme === 'per_unit') {
    return price.unitAmount * transformedQuantity(quantity, price.transformQuantity);
  }
  assertTiers(price.tiers);
  if (price.tiersMode === 'volume') {
    const tier = price.tiers.find((t) => t.upTo === null || quantity <= t.upTo);
    // `assertTiers` proved the last tier is open, so one always matches.
    if (!tier) throw new Error('unreachable: no tier covers the quantity');
    return tier.unitAmount * quantity + tier.flatAmount;
  }
  let amount = 0n;
  let lower = 0n;
  for (const [index, tier] of price.tiers.entries()) {
    const upper = tier.upTo === null || quantity < tier.upTo ? quantity : tier.upTo;
    const units = upper > lower ? upper - lower : 0n;
    if (units > 0n || index === 0) amount += units * tier.unitAmount + tier.flatAmount;
    if (tier.upTo === null || quantity <= tier.upTo) break;
    lower = tier.upTo;
  }
  return amount;
}

function assertQuantity(quantity: bigint): void {
  if (quantity < 0n) throw new RangeError(`quantity cannot be negative: ${quantity}`);
}

function assertTiers(tiers: readonly PricingTier[]): void {
  if (tiers.length === 0) throw new RangeError('a tiered price needs at least one tier');
  let previous = 0n;
  for (const [index, tier] of tiers.entries()) {
    const last = index === tiers.length - 1;
    if (last !== (tier.upTo === null)) {
      throw new RangeError('only the last tier is open (up_to: inf), and it must be');
    }
    if (tier.upTo !== null) {
      if (tier.upTo <= previous) throw new RangeError('tier up_to values must ascend');
      previous = tier.upTo;
    }
  }
}

// ---- Discounts -------------------------------------------------------------

/** A coupon as pricing needs it. */
export interface PricingCoupon {
  /** Basis points: 1250 is 12.5 %. Exactly one of this and `amountOff` is set. */
  readonly percentOffBps: number | null;
  readonly amountOff: bigint | null;
  /** The currency of `amountOff`; `null` for a percentage. */
  readonly currency: CurrencyCode | null;
  readonly redeemBy: Date | null;
  readonly maxRedemptions: number | null;
  readonly timesRedeemed: number;
  readonly deleted: boolean;
  /** Internal product ids it is restricted to; `null` applies to every product. */
  readonly appliesToProducts: readonly string[] | null;
}

/** A promotion code as pricing needs it. */
export interface PricingPromotionCode {
  readonly active: boolean;
  /** Internal id of the one customer who may redeem it; `null` for anyone. */
  readonly customerId: string | null;
  readonly expiresAt: Date | null;
  readonly maxRedemptions: number | null;
  readonly timesRedeemed: number;
  readonly firstTimeTransaction: boolean;
  readonly minimumAmount: bigint | null;
  readonly minimumAmountCurrency: CurrencyCode | null;
}

/**
 * Whether a coupon can be redeemed at `now`: not deleted, `now` not after
 * `redeem_by`, and not used up. This is the coupon's `valid`.
 */
export function couponIsValid(coupon: PricingCoupon, now: Date): boolean {
  if (coupon.deleted) return false;
  if (coupon.redeemBy !== null && now.getTime() > coupon.redeemBy.getTime()) return false;
  if (coupon.maxRedemptions !== null && coupon.timesRedeemed >= coupon.maxRedemptions) return false;
  return true;
}

const BASIS_POINTS = 10_000n;

/**
 * What a coupon takes off `amount` (in `currency`): a percentage rounded half
 * up, or a fixed amount capped at `amount` — a discount never makes a line
 * negative. A fixed amount in another currency takes nothing off; the caller
 * decides whether that is a refusal (see {@link applyDiscount}).
 */
export function discountAmount(
  amount: bigint,
  currency: CurrencyCode,
  coupon: Pick<PricingCoupon, 'percentOffBps' | 'amountOff' | 'currency'>,
): bigint {
  if (amount < 0n) throw new RangeError(`amount cannot be negative: ${amount}`);
  if (coupon.percentOffBps !== null) {
    const bps = BigInt(coupon.percentOffBps);
    if (bps < 1n || bps > BASIS_POINTS) throw new RangeError('percent_off must be in (0, 100]');
    return (amount * bps + BASIS_POINTS / 2n) / BASIS_POINTS;
  }
  if (coupon.amountOff === null || coupon.currency !== currency) return 0n;
  return coupon.amountOff < amount ? coupon.amountOff : amount;
}

/** Why a discount does not apply. */
export type DiscountRefusal =
  | 'coupon_invalid'
  | 'coupon_currency_mismatch'
  | 'coupon_not_applicable'
  | 'promotion_code_inactive'
  | 'promotion_code_customer_mismatch'
  | 'promotion_code_expired'
  | 'promotion_code_max_redemptions'
  | 'promotion_code_minimum_amount'
  | 'promotion_code_first_time_only';

export interface DiscountContext {
  /** The line's amount before the discount. */
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  /** The instant the discount is being applied at (an injected clock, ADR 0018 §3). */
  readonly now: Date;
  /** The internal id of the line's product, checked against `applies_to`. */
  readonly productId?: string | undefined;
  /**
   * The order total a promotion code's `minimum_amount` is judged against;
   * defaults to `amount` (a one-line order).
   */
  readonly orderTotal?: bigint | undefined;
  /** Internal id of the customer redeeming, checked against a promotion code's `customer`. */
  readonly customerId?: string | undefined;
  /** Whether this is the customer's first transaction with the merchant. */
  readonly firstTimeTransaction?: boolean | undefined;
}

export type DiscountResult =
  | { readonly ok: true; readonly discount: bigint; readonly total: bigint }
  | { readonly ok: false; readonly reason: DiscountRefusal };

/**
 * Apply a coupon — redeemed directly, or through a promotion code — to one
 * line. Every refusal is named, so a checkout can tell the payer why a code
 * did not work, and nothing is ever silently discounted by zero.
 */
export function applyDiscount(
  context: DiscountContext,
  coupon: PricingCoupon,
  promotionCode?: PricingPromotionCode,
): DiscountResult {
  if (!couponIsValid(coupon, context.now)) return { ok: false, reason: 'coupon_invalid' };
  if (coupon.amountOff !== null && coupon.currency !== context.currency) {
    return { ok: false, reason: 'coupon_currency_mismatch' };
  }
  if (
    coupon.appliesToProducts !== null &&
    (context.productId === undefined || !coupon.appliesToProducts.includes(context.productId))
  ) {
    return { ok: false, reason: 'coupon_not_applicable' };
  }
  if (promotionCode) {
    const refusal = promotionCodeRefusal(promotionCode, context);
    if (refusal) return { ok: false, reason: refusal };
  }
  const discount = discountAmount(context.amount, context.currency, coupon);
  return { ok: true, discount, total: context.amount - discount };
}

function promotionCodeRefusal(
  code: PricingPromotionCode,
  context: DiscountContext,
): DiscountRefusal | null {
  if (!code.active) return 'promotion_code_inactive';
  if (code.customerId !== null && code.customerId !== context.customerId) {
    return 'promotion_code_customer_mismatch';
  }
  if (code.expiresAt !== null && context.now.getTime() >= code.expiresAt.getTime()) {
    return 'promotion_code_expired';
  }
  if (code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions) {
    return 'promotion_code_max_redemptions';
  }
  if (code.minimumAmount !== null) {
    const total = context.orderTotal ?? context.amount;
    if (code.minimumAmountCurrency !== context.currency || total < code.minimumAmount) {
      return 'promotion_code_minimum_amount';
    }
  }
  if (code.firstTimeTransaction && context.firstTimeTransaction !== true) {
    return 'promotion_code_first_time_only';
  }
  return null;
}
