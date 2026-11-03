import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type PgTableExtraConfigValue,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  CATALOG_LIMITS,
  type PriceTier,
  type ProductMarketingFeature,
} from '@peable.to/shared-types';
import { customers } from './customers';
import { merchants } from './merchants';
import { billingMeters } from './meters';
import {
  BASE_UNIT_STRING_PATTERN,
  COUPON_DURATIONS,
  CURRENCY_CODES,
  PRICE_BILLING_SCHEMES,
  PRICE_TAX_BEHAVIORS,
  PRICE_TIERS_MODES,
  PRICE_TYPES,
  RECURRING_INTERVALS,
  RECURRING_USAGE_TYPES,
  TRANSFORM_QUANTITY_ROUNDS,
} from './valueSets';

/**
 * The catalog (ADR 0016, ADR 0018): what a merchant sells and on what terms.
 * Four tables, every one a Peable row with a Peable public id, and NO provider
 * binding — a catalog object is Orbit's decision, not a provider's, and the
 * provider sees only the amounts an invoice or a payment derives from it.
 *
 * Decisions a reader would otherwise undo are in `CONVENTIONS.md` §Catalog.
 */

/** A stored tier, exactly as the wire renders it (`up_to: null` is the last tier). */
export type StoredPriceTier = PriceTier;

/**
 * A product (`prod_…`).
 *
 * `default_price_id` is a reference INTO `prices`, which references back —
 * a cycle drizzle-kit resolves by emitting both foreign keys after both
 * tables. The default price is held by the composite `(default_price_id, id)
 * → prices (id, product_id)`, so a product's default price is one of its OWN
 * prices or the row does not exist; `MATCH SIMPLE` switches it off while the
 * product has none.
 */
export const products = pgTable(
  'products',
  {
    id: generatedId(),
    /** The public `prod_…`. */
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    active: boolean().notNull().default(true),
    name: text().notNull(),
    description: text(),
    images: text().array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** A Peable Tax code (`txcd_…`); `null` means the merchant's default. */
    taxCode: text(),
    defaultPriceId: text(),
    unitLabel: text(),
    url: text(),
    statementDescriptor: text(),
    marketingFeatures: jsonb()
      .$type<ProductMarketingFeature[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('products_public_id_key').on(table.publicId),
    /** The target of every same-merchant reference into this table. */
    unique('products_id_merchant_id_key').on(table.id, table.merchantId),
    /** `GET /v1/products`: one merchant's products, walked by primary key. */
    index('products_merchant_id_id_idx').on(table.merchantId, table.id),
    foreignKey({
      name: 'products_default_price_fkey',
      columns: [table.defaultPriceId, table.id],
      foreignColumns: [prices.id, prices.productId],
    }).onDelete('restrict'),
    check(
      'products_name_check',
      sql.raw(`char_length(name) between 1 and ${CATALOG_LIMITS.productNameMax}`),
    ),
    check(
      'products_description_check',
      sql.raw(
        `description is null or char_length(description) between 1 and ${CATALOG_LIMITS.productDescriptionMax}`,
      ),
    ),
    check(
      'products_images_check',
      sql.raw(`cardinality(images) <= ${CATALOG_LIMITS.productImagesMax}`),
    ),
    check('products_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    check('products_tax_code_check', sql.raw(`tax_code is null or tax_code ~ '^txcd_[0-9]{8}$'`)),
    check(
      'products_unit_label_check',
      sql.raw(
        `unit_label is null or char_length(unit_label) between 1 and ${CATALOG_LIMITS.unitLabelMax}`,
      ),
    ),
    check(
      'products_url_check',
      sql.raw(
        `url is null or (url ~ '^https?://' and char_length(url) <= ${CATALOG_LIMITS.urlMax})`,
      ),
    ),
    check(
      'products_statement_descriptor_check',
      sql.raw(
        `statement_descriptor is null or char_length(statement_descriptor) between 1 and ${CATALOG_LIMITS.statementDescriptorMax}`,
      ),
    ),
    check(
      'products_marketing_features_check',
      sql.raw(
        `jsonb_typeof(marketing_features) = 'array' and jsonb_array_length(marketing_features) <= ${CATALOG_LIMITS.marketingFeaturesMax}`,
      ),
    ),
  ],
);

/**
 * A price (`price_…`).
 *
 * Immutable except `active`, `nickname`, `metadata`, `lookup_key` and a
 * `tax_behavior` still `unspecified` — `priceRepository.updatePrice` is the
 * one writer that changes a stored price and names only those columns.
 *
 * The shape rules are CHECKs, each one fact a writer could otherwise split:
 * a per-unit price has an amount and no tiers, a tiered one the reverse; a
 * recurring price has its interval, count and usage type and a one-time price
 * none of them; a quantity transform has both halves and only on per-unit.
 */
export const prices = pgTable(
  'prices',
  {
    id: generatedId(),
    /** The public `price_…`. */
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    productId: text()
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'restrict' }),
    active: boolean().notNull().default(true),
    currency: text().notNull(),
    /** Base units per unit; `null` exactly when tiered. */
    unitAmount: text(),
    billingScheme: text().notNull(),
    tiers: jsonb().$type<StoredPriceTier[]>(),
    tiersMode: text(),
    transformQuantityDivideBy: integer(),
    transformQuantityRound: text(),
    type: text().notNull(),
    recurringInterval: text(),
    recurringIntervalCount: integer(),
    recurringUsageType: text(),
    /** The meter a `metered` price bills (ADR 0018 §7). */
    meterId: text(),
    taxBehavior: text().notNull().default('unspecified'),
    lookupKey: text(),
    nickname: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('prices_public_id_key').on(table.publicId),
    /** The target of `products_default_price_fkey`: a default price is the product's own. */
    unique('prices_id_product_id_key').on(table.id, table.productId),
    /** The target of the line-item references: a line names its own merchant's price. */
    unique('prices_id_merchant_id_key').on(table.id, table.merchantId),
    foreignKey({
      name: 'prices_meter_fkey',
      columns: [table.meterId, table.merchantId],
      foreignColumns: [billingMeters.id, billingMeters.merchantId],
    }).onDelete('restrict'),
    /** A price and its product belong to one merchant. */
    foreignKey({
      name: 'prices_product_merchant_fkey',
      columns: [table.productId, table.merchantId],
      foreignColumns: [products.id, products.merchantId],
    }).onDelete('restrict'),
    /**
     * A lookup key names ONE price of the merchant (per mode, since a merchant
     * is one mode). Partial: most prices have none.
     */
    uniqueIndex('prices_merchant_lookup_key_key')
      .on(table.merchantId, table.lookupKey)
      .where(sql`${table.lookupKey} is not null`),
    index('prices_merchant_id_id_idx').on(table.merchantId, table.id),
    index('prices_product_id_id_idx').on(table.productId, table.id),
    check('prices_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'prices_unit_amount_check',
      sql.raw(`unit_amount is null or unit_amount ~ '${BASE_UNIT_STRING_PATTERN}'`),
    ),
    check(
      'prices_billing_scheme_check',
      sql.raw(`billing_scheme in (${inList(PRICE_BILLING_SCHEMES)})`),
    ),
    check(
      'prices_tiers_mode_check',
      sql.raw(`tiers_mode is null or tiers_mode in (${inList(PRICE_TIERS_MODES)})`),
    ),
    check('prices_type_check', sql.raw(`type in (${inList(PRICE_TYPES)})`)),
    check('prices_tax_behavior_check', sql.raw(`tax_behavior in (${inList(PRICE_TAX_BEHAVIORS)})`)),
    /** Per-unit ⇔ an amount; tiered ⇔ tiers and their mode. */
    check(
      'prices_billing_scheme_shape_check',
      sql.raw(
        `(billing_scheme = 'per_unit') = (unit_amount is not null) and (billing_scheme = 'tiered') = (tiers is not null) and (tiers is null) = (tiers_mode is null)`,
      ),
    ),
    check(
      'prices_tiers_check',
      sql.raw(
        `tiers is null or (jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) between 1 and ${CATALOG_LIMITS.priceTiersMax})`,
      ),
    ),
    check(
      'prices_transform_quantity_check',
      sql.raw(
        `(transform_quantity_divide_by is null) = (transform_quantity_round is null) and (transform_quantity_divide_by is null or (transform_quantity_divide_by >= 1 and billing_scheme = 'per_unit')) and (transform_quantity_round is null or transform_quantity_round in (${inList(TRANSFORM_QUANTITY_ROUNDS)}))`,
      ),
    ),
    /** Recurring ⇔ an interval, a count and a usage type; at most three years apart; metered ⇔ a meter. */
    check(
      'prices_recurring_check',
      sql.raw(
        `(type = 'recurring') = (recurring_interval is not null) and (recurring_interval is null) = (recurring_interval_count is null) and (recurring_interval is null) = (recurring_usage_type is null) and (recurring_interval is null or recurring_interval in (${inList(RECURRING_INTERVALS)})) and (recurring_usage_type is null or recurring_usage_type in (${inList(RECURRING_USAGE_TYPES)})) and (recurring_interval_count is null or recurring_interval_count between 1 and case recurring_interval when 'day' then 1095 when 'week' then 156 when 'month' then 36 else 3 end) and (recurring_usage_type = 'metered') = (meter_id is not null)`,
      ),
    ),
    check(
      'prices_lookup_key_check',
      sql.raw(
        `lookup_key is null or char_length(lookup_key) between 1 and ${CATALOG_LIMITS.lookupKeyMax}`,
      ),
    ),
    check(
      'prices_nickname_check',
      sql.raw(
        `nickname is null or char_length(nickname) between 1 and ${CATALOG_LIMITS.priceNicknameMax}`,
      ),
    ),
    check('prices_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/**
 * A coupon. Its public id is the MERCHANT's (`SUMMER25`) or generated
 * (`coupon_…`), so it is unique per merchant, not globally — and unique over
 * deleted coupons too: a delete is `deleted_at`, and the id is never handed to
 * a second coupon, so a promotion code or a future discount that names it
 * cannot be re-pointed at different terms.
 *
 * `percent_off` is stored as basis points (hundredths of a percent): the
 * discount is computed in integers, never in floating point.
 */
export const coupons = pgTable(
  'coupons',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    name: text(),
    percentOffBps: integer(),
    amountOff: text(),
    currency: text(),
    duration: text().notNull(),
    durationInMonths: integer(),
    maxRedemptions: integer(),
    redeemBy: timestamptz(),
    timesRedeemed: integer().notNull().default(0),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    deletedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('coupons_merchant_public_id_key').on(table.merchantId, table.publicId),
    unique('coupons_id_merchant_id_key').on(table.id, table.merchantId),
    index('coupons_merchant_id_id_idx').on(table.merchantId, table.id),
    check(
      'coupons_public_id_check',
      sql.raw(`public_id ~ '^[A-Za-z0-9_-]{1,${CATALOG_LIMITS.couponIdMax}}$'`),
    ),
    check(
      'coupons_name_check',
      sql.raw(`name is null or char_length(name) between 1 and ${CATALOG_LIMITS.couponNameMax}`),
    ),
    /** Exactly one kind of discount; a fixed amount carries its currency, a percentage none. */
    check(
      'coupons_discount_check',
      sql.raw(
        `(percent_off_bps is null) <> (amount_off is null) and (amount_off is null) = (currency is null) and (percent_off_bps is null or percent_off_bps between 1 and 10000) and (amount_off is null or (amount_off ~ '${BASE_UNIT_STRING_PATTERN}' and amount_off <> '0')) and (currency is null or currency in (${inList(CURRENCY_CODES)}))`,
      ),
    ),
    check(
      'coupons_duration_check',
      sql.raw(
        `duration in (${inList(COUPON_DURATIONS)}) and (duration = 'repeating') = (duration_in_months is not null) and (duration_in_months is null or duration_in_months between 1 and ${CATALOG_LIMITS.couponDurationInMonthsMax})`,
      ),
    ),
    check(
      'coupons_redemptions_check',
      sql`(${table.maxRedemptions} is null or ${table.maxRedemptions} >= 1) and ${table.timesRedeemed} >= 0 and (${table.maxRedemptions} is null or ${table.timesRedeemed} <= ${table.maxRedemptions})`,
    ),
    check('coupons_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/**
 * `coupon.applies_to.products` — the products a coupon is restricted to. No
 * row for a coupon means it applies to every product.
 *
 * Rows, not an array, so each product is a real reference. `restrict` both
 * ways, deliberately: a product named here cannot be deleted (archive it), and
 * a cascade that removed the LAST row would turn a restricted coupon into one
 * that applies to everything — a widening nobody decided.
 */
export const couponProducts = pgTable(
  'coupon_products',
  {
    couponId: text().notNull(),
    productId: text().notNull(),
    merchantId: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.couponId, table.productId] }),
    foreignKey({
      name: 'coupon_products_coupon_fkey',
      columns: [table.couponId, table.merchantId],
      foreignColumns: [coupons.id, coupons.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'coupon_products_product_fkey',
      columns: [table.productId, table.merchantId],
      foreignColumns: [products.id, products.merchantId],
    }).onDelete('restrict'),
    /** "Which coupons name this product" — the product delete's refusal. */
    index('coupon_products_product_id_idx').on(table.productId),
  ],
);

/**
 * A promotion code (`promo_…`). `customer_id` names the one customer who may
 * redeem it, through a composite reference so it is always THIS merchant's
 * customer (and nothing at all when NULL). `code` keeps the merchant's spelling and is
 * compared case-insensitively; it is unique among the merchant's ACTIVE codes
 * (Stripe's rule), so a code retired last year can be issued again and a
 * redemption never has two candidates.
 */
export const promotionCodes = pgTable(
  'promotion_codes',
  {
    id: generatedId(),
    /** The public `promo_…`. */
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    couponId: text().notNull(),
    /** When set, only this customer may redeem the code. */
    customerId: text(),
    code: text().notNull(),
    active: boolean().notNull().default(true),
    maxRedemptions: integer(),
    expiresAt: timestamptz(),
    timesRedeemed: integer().notNull().default(0),
    firstTimeTransaction: boolean().notNull().default(false),
    minimumAmount: text(),
    minimumAmountCurrency: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('promotion_codes_public_id_key').on(table.publicId),
    /** The target of `checkout_sessions_promotion_code_fkey`. */
    unique('promotion_codes_id_merchant_id_key').on(table.id, table.merchantId),
    foreignKey({
      name: 'promotion_codes_coupon_fkey',
      columns: [table.couponId, table.merchantId],
      foreignColumns: [coupons.id, coupons.merchantId],
    }).onDelete('restrict'),
    /** `MATCH SIMPLE`: vacuous for a code any customer may redeem. */
    foreignKey({
      name: 'promotion_codes_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    uniqueIndex('promotion_codes_merchant_active_code_key')
      .on(table.merchantId, sql`lower(${table.code})`)
      .where(sql`${table.active}`),
    index('promotion_codes_merchant_id_id_idx').on(table.merchantId, table.id),
    index('promotion_codes_coupon_id_idx').on(table.couponId),
    check(
      'promotion_codes_code_check',
      sql.raw(`code ~ '^[A-Za-z0-9]{1,${CATALOG_LIMITS.promotionCodeMax}}$'`),
    ),
    check(
      'promotion_codes_redemptions_check',
      sql`(${table.maxRedemptions} is null or ${table.maxRedemptions} >= 1) and ${table.timesRedeemed} >= 0 and (${table.maxRedemptions} is null or ${table.timesRedeemed} <= ${table.maxRedemptions})`,
    ),
    check(
      'promotion_codes_minimum_amount_check',
      sql.raw(
        `(minimum_amount is null) = (minimum_amount_currency is null) and (minimum_amount is null or minimum_amount ~ '${BASE_UNIT_STRING_PATTERN}') and (minimum_amount_currency is null or minimum_amount_currency in (${inList(CURRENCY_CODES)}))`,
      ),
    ),
    check('promotion_codes_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);
