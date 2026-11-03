// The catalog (ADR 0016, ADR 0018): Products, Prices, Coupons and Promotion
// codes — Orbit's own rows with Orbit's own ids, which checkout, invoices and
// subscriptions price from. Stripe's object model, Peable's wire (ADR 0014 D1):
// snake_case, Unix seconds, `livemode`, and every amount a base-unit STRING.
import type { ListParams } from './list';
import type { Customer } from './customer';
import type { CurrencyCode } from './money';

/** How a price's amount is computed from a quantity. */
export const PRICE_BILLING_SCHEMES = ['per_unit', 'tiered'] as const;
export type PriceBillingScheme = (typeof PRICE_BILLING_SCHEMES)[number];

/**
 * How a tiered price reads its tiers.
 *
 *  - `volume`    — the WHOLE quantity is priced at the tier it falls into.
 *  - `graduated` — each unit is priced at the tier it falls into, so a
 *                  quantity crossing two tiers pays each tier's rate for its
 *                  share, plus the flat amount of every tier it reaches.
 */
export const PRICE_TIERS_MODES = ['graduated', 'volume'] as const;
export type PriceTiersMode = (typeof PRICE_TIERS_MODES)[number];

/** `recurring` when the price has a recurring component, `one_time` otherwise. */
export const PRICE_TYPES = ['one_time', 'recurring'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const RECURRING_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

/**
 * `licensed` bills the quantity on the subscription. `metered` bills the usage
 * a meter (`recurring.meter`, `mtr_…`) aggregated over the period, in arrears.
 */
export const RECURRING_USAGE_TYPES = ['licensed', 'metered'] as const;
export type RecurringUsageType = (typeof RECURRING_USAGE_TYPES)[number];

/**
 * Whether a price includes tax (Peable Tax, ADR 0011). `unspecified` defers to
 * the merchant's default tax behavior; once a price says `inclusive` or
 * `exclusive` it can never change.
 */
export const PRICE_TAX_BEHAVIORS = ['inclusive', 'exclusive', 'unspecified'] as const;
export type PriceTaxBehavior = (typeof PRICE_TAX_BEHAVIORS)[number];

export const TRANSFORM_QUANTITY_ROUNDS = ['up', 'down'] as const;
export type TransformQuantityRound = (typeof TRANSFORM_QUANTITY_ROUNDS)[number];

/** How long a coupon's discount lasts once applied to a subscription. */
export const COUPON_DURATIONS = ['once', 'repeating', 'forever'] as const;
export type CouponDuration = (typeof COUPON_DURATIONS)[number];

/** The bounds the gateway enforces, published so a form can say them first. */
export const CATALOG_LIMITS = Object.freeze({
  productNameMax: 250,
  productDescriptionMax: 40_000,
  productImagesMax: 8,
  urlMax: 2048,
  unitLabelMax: 12,
  statementDescriptorMax: 22,
  marketingFeaturesMax: 15,
  marketingFeatureNameMax: 80,
  priceNicknameMax: 250,
  lookupKeyMax: 200,
  lookupKeysFilterMax: 10,
  priceTiersMax: 250,
  couponIdMax: 64,
  couponNameMax: 40,
  couponAppliesToProductsMax: 100,
  couponDurationInMonthsMax: 1200,
  promotionCodeMax: 64,
  idsFilterMax: 100,
});

/** A product feature shown on pricing tables and checkout (Stripe's marketing features). */
export interface ProductMarketingFeature {
  name: string;
}

/**
 * A product (`prod_…`) — what a merchant sells. Its prices say how much.
 *
 * A product with prices cannot be deleted; set `active: false` to archive it.
 */
export interface Product {
  id: string;
  object: 'product';
  /** The mode of the merchant that owns it (ADR 0017). */
  livemode: boolean;
  active: boolean;
  name: string;
  description: string | null;
  /** Up to 8 image URLs. */
  images: string[];
  metadata: Record<string, string>;
  /** A Peable Tax code (`txcd_…`), or `null` for the merchant's default. */
  tax_code: string | null;
  /** The product's default price — a `price_…`, or the Price when expanded. */
  default_price: string | Price | null;
  /** The unit a quantity counts (`seat`), shown on receipts and invoices. */
  unit_label: string | null;
  url: string | null;
  /** What appears on a card statement; at most 22 characters. */
  statement_descriptor: string | null;
  marketing_features: ProductMarketingFeature[];
  created: number;
  updated: number;
}

/** What `DELETE /v1/products/:id` answers. */
export interface DeletedProduct {
  id: string;
  object: 'product';
  deleted: true;
}

/**
 * One tier of a tiered price. `up_to` is the last quantity the tier covers
 * (inclusive), and `null` on the last tier, which covers everything above —
 * sent as `'inf'`. Each amount is a base-unit string; at least one is set.
 */
export interface PriceTier {
  up_to: number | null;
  unit_amount: string | null;
  flat_amount: string | null;
}

/**
 * Divide the quantity before pricing it: `divide_by: 10, round: 'up'` bills
 * 11 units as 2 packs of ten. Per-unit prices only.
 */
export interface PriceTransformQuantity {
  divide_by: number;
  round: TransformQuantityRound;
}

export interface PriceRecurring {
  interval: RecurringInterval;
  /** Intervals between billings: `interval: 'month', interval_count: 3` is quarterly. At most three years. */
  interval_count: number;
  usage_type: RecurringUsageType;
  /** The meter (`mtr_…`) a `metered` price bills; `null` when `licensed`. */
  meter: string | null;
}

/**
 * A price (`price_…`) — how much a product costs, in one currency, once or per
 * interval.
 *
 * IMMUTABLE once created except for `active`, `nickname`, `metadata`,
 * `lookup_key` and — while it is `unspecified` — `tax_behavior`. To change an
 * amount, create a new price and archive the old one: a subscription priced
 * from it must keep meaning what it meant.
 */
export interface Price {
  id: string;
  object: 'price';
  livemode: boolean;
  active: boolean;
  /** The product it prices — a `prod_…`, or the Product when expanded. */
  product: string | Product;
  currency: CurrencyCode;
  /** Base units per unit; `null` on a tiered price. */
  unit_amount: string | null;
  billing_scheme: PriceBillingScheme;
  /** `null` unless `billing_scheme` is `tiered`. */
  tiers: PriceTier[] | null;
  tiers_mode: PriceTiersMode | null;
  transform_quantity: PriceTransformQuantity | null;
  type: PriceType;
  /** `null` exactly when `type` is `one_time`. */
  recurring: PriceRecurring | null;
  tax_behavior: PriceTaxBehavior;
  /**
   * The merchant's own stable name for this price, unique among its prices
   * (per mode): retrieve the current price of a plan with `lookup_keys[]`
   * without storing an id that changes whenever the amount does.
   */
  lookup_key: string | null;
  nickname: string | null;
  metadata: Record<string, string>;
  created: number;
}

/**
 * A coupon — a discount, by percentage or by a fixed amount in one currency.
 * Its `id` is the merchant's own (`SUMMER25`) or generated (`coupon_…`), and
 * names that one coupon forever: a deleted coupon's id is never reused.
 *
 * Only `name` and `metadata` can change; the terms of a discount a customer
 * already holds cannot.
 */
export interface Coupon {
  id: string;
  object: 'coupon';
  livemode: boolean;
  name: string | null;
  /** 0 < x ≤ 100, at most two decimals. Set exactly when `amount_off` is not. */
  percent_off: number | null;
  /** Base units taken off, in `currency`. */
  amount_off: string | null;
  currency: CurrencyCode | null;
  duration: CouponDuration;
  /** Months a `repeating` coupon lasts; `null` otherwise. */
  duration_in_months: number | null;
  max_redemptions: number | null;
  /** The last instant (Unix seconds) it can be redeemed. */
  redeem_by: number | null;
  times_redeemed: number;
  /** Whether it can still be redeemed: not past `redeem_by` and not used up. */
  valid: boolean;
  /** The products it is restricted to, or `null` for every product. */
  applies_to: { products: string[] } | null;
  metadata: Record<string, string>;
  created: number;
}

/** What `DELETE /v1/coupons/:id` answers. Existing discounts are not affected. */
export interface DeletedCoupon {
  id: string;
  object: 'coupon';
  deleted: true;
}

export interface PromotionCodeRestrictions {
  /** Only a customer's first transaction may redeem it. */
  first_time_transaction: boolean;
  /** The smallest order total (base units) it applies to, in `minimum_amount_currency`. */
  minimum_amount: string | null;
  minimum_amount_currency: CurrencyCode | null;
}

/**
 * A promotion code (`promo_…`) — a customer-facing `code` that redeems a
 * coupon, with its own limits. Codes are case-insensitive and unique among a
 * merchant's ACTIVE codes.
 */
export interface PromotionCode {
  id: string;
  object: 'promotion_code';
  livemode: boolean;
  code: string;
  /** The coupon it redeems — its id, or the Coupon when expanded. */
  coupon: string | Coupon;
  /** The one customer who may redeem it (`cus_…`, or the Customer when expanded); `null` for anyone. */
  customer: string | Customer | null;
  active: boolean;
  max_redemptions: number | null;
  /** Unix seconds; never after the coupon's `redeem_by`. */
  expires_at: number | null;
  times_redeemed: number;
  restrictions: PromotionCodeRestrictions;
  metadata: Record<string, string>;
  created: number;
}

// ---- Parameters ----------------------------------------------------------

export interface RecurringParams {
  interval: RecurringInterval;
  /** Default 1. */
  interval_count?: number;
  /** Default `licensed`. */
  usage_type?: RecurringUsageType;
  /** Required with `usage_type: 'metered'`: the meter (`mtr_…`) it bills. */
  meter?: string;
}

export interface PriceTierParams {
  /** A positive integer, ascending; the last tier is `'inf'`. */
  up_to: number | 'inf';
  unit_amount?: string;
  flat_amount?: string;
}

/**
 * An inline price (Stripe's `price_data`): what a checkout line item or an
 * invoice item names when it has no stored `price_…`. Per-unit only.
 */
export interface PriceDataParams {
  currency: CurrencyCode;
  /** The `prod_…` it prices. */
  product: string;
  unit_amount: string;
  recurring?: Omit<RecurringParams, 'usage_type'>;
  tax_behavior?: PriceTaxBehavior;
}

/** `default_price_data` on a product create: `price_data` for the product being created. */
export type DefaultPriceDataParams = Omit<PriceDataParams, 'product'>;

export interface CreateProductParams {
  name: string;
  active?: boolean;
  description?: string;
  images?: string[];
  metadata?: Record<string, string>;
  tax_code?: string;
  /** Create the product's default price with it. */
  default_price_data?: DefaultPriceDataParams;
  unit_label?: string;
  url?: string;
  statement_descriptor?: string;
  marketing_features?: ProductMarketingFeature[];
}

/** `''` clears an optional text field; `metadata` is merged. */
export interface UpdateProductParams {
  name?: string;
  active?: boolean;
  description?: string;
  images?: string[];
  metadata?: Record<string, string>;
  tax_code?: string;
  /** One of this product's active prices; `''` clears it. */
  default_price?: string;
  unit_label?: string;
  url?: string;
  statement_descriptor?: string;
  marketing_features?: ProductMarketingFeature[];
}

export interface ProductListParams extends ListParams {
  active?: boolean;
  /** Only these products (at most 100). */
  ids?: string[];
}

export interface CreatePriceParams {
  product: string;
  currency: CurrencyCode;
  /** Required for `per_unit`; absent for `tiered`. */
  unit_amount?: string;
  /** Default `per_unit`. */
  billing_scheme?: PriceBillingScheme;
  tiers?: PriceTierParams[];
  tiers_mode?: PriceTiersMode;
  transform_quantity?: PriceTransformQuantity;
  /** Present: a recurring price. Absent: one-time. */
  recurring?: RecurringParams;
  /** Default `unspecified`. */
  tax_behavior?: PriceTaxBehavior;
  lookup_key?: string;
  /** Move `lookup_key` here from the price that holds it. */
  transfer_lookup_key?: boolean;
  nickname?: string;
  active?: boolean;
  metadata?: Record<string, string>;
}

export interface UpdatePriceParams {
  active?: boolean;
  /** `''` clears it. */
  nickname?: string;
  metadata?: Record<string, string>;
  /** `''` clears it. */
  lookup_key?: string;
  transfer_lookup_key?: boolean;
  /** Only while the price's is `unspecified`. */
  tax_behavior?: PriceTaxBehavior;
}

export interface PriceListParams extends ListParams {
  product?: string;
  active?: boolean;
  type?: PriceType;
  currency?: CurrencyCode;
  /** At most 10. */
  lookup_keys?: string[];
  recurring?: { interval?: RecurringInterval; usage_type?: RecurringUsageType };
}

export interface CreateCouponParams {
  /** Your own id (`SUMMER25`); generated (`coupon_…`) when absent. */
  id?: string;
  name?: string;
  percent_off?: number;
  amount_off?: string;
  /** Required with `amount_off`. */
  currency?: CurrencyCode;
  /** Default `once`. */
  duration?: CouponDuration;
  /** Required for `repeating`. */
  duration_in_months?: number;
  max_redemptions?: number;
  /** Unix seconds, in the future. */
  redeem_by?: number;
  applies_to?: { products: string[] };
  metadata?: Record<string, string>;
}

export interface UpdateCouponParams {
  /** `''` clears it. */
  name?: string;
  metadata?: Record<string, string>;
}

export interface CreatePromotionCodeParams {
  coupon: string;
  /** Letters and digits; generated when absent. */
  code?: string;
  /** Only this customer (`cus_…`) may redeem it. */
  customer?: string;
  active?: boolean;
  max_redemptions?: number;
  expires_at?: number;
  restrictions?: {
    first_time_transaction?: boolean;
    minimum_amount?: string;
    minimum_amount_currency?: CurrencyCode;
  };
  metadata?: Record<string, string>;
}

export interface UpdatePromotionCodeParams {
  active?: boolean;
  metadata?: Record<string, string>;
}

export interface PromotionCodeListParams extends ListParams {
  /** Case-insensitive. */
  code?: string;
  coupon?: string;
  customer?: string;
  active?: boolean;
}

export type CouponListParams = ListParams;
