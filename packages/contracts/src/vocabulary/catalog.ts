// The catalog's and the billing engine platform's closed value sets (ADR 0016,
// ADR 0018): what a price, a coupon, a test clock, a meter and the billing
// settings can say, and the bounds the gateway enforces — restated so a form
// can say them first. Zod-free: the wallet bundles this.
import { type CurrencyCode, decimalsFor } from './money';

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

/**
 * The largest amount the catalog stores, in whole units of any currency, so a
 * FAIR amount (8 decimals) and a EUR amount (2) are bounded at the same real
 * size rather than the same number of digits.
 */
export const CATALOG_MAX_WHOLE_UNITS = 1_000_000_000n;

/** The largest base-unit amount of `currency` the catalog accepts. */
export function maxBaseUnits(currency: CurrencyCode): bigint {
  return CATALOG_MAX_WHOLE_UNITS * 10n ** BigInt(decimalsFor(currency)) - 1n;
}

/** The longest a recurring interval may be: three years, in each unit. */
export const RECURRING_INTERVAL_COUNT_MAX: Readonly<Record<RecurringInterval, number>> =
  Object.freeze({
    day: 1095,
    week: 156,
    month: 36,
    year: 3,
  });

// ---- Test clocks -------------------------------------------------------------

export const TEST_CLOCK_STATUSES = ['ready', 'advancing', 'internal_failure'] as const;
export type TestClockStatus = (typeof TEST_CLOCK_STATUSES)[number];

// ---- Billing settings --------------------------------------------------------

/** What dunning does to a subscription once the last retry has failed. */
export const DUNNING_FINAL_ACTIONS = ['cancel', 'unpaid', 'past_due'] as const;
export type DunningFinalAction = (typeof DUNNING_FINAL_ACTIONS)[number];

/** What happens to the invoice itself once the last retry has failed. */
export const DUNNING_INVOICE_ACTIONS = ['leave_open', 'mark_uncollectible'] as const;
export type DunningInvoiceAction = (typeof DUNNING_INVOICE_ACTIONS)[number];

/** The bounds the gateway enforces on billing settings. */
export const BILLING_SETTINGS_LIMITS = Object.freeze({
  retriesMax: 8,
  retryDaysMax: 60,
  daysUntilDueMax: 365,
  invoicePrefixPattern: '^[A-Z0-9]{3,12}$',
});

// ---- Meters ------------------------------------------------------------------

/** How a meter combines a period's events into the quantity billed. */
export const METER_AGGREGATIONS = ['sum', 'count', 'last'] as const;
export type MeterAggregation = (typeof METER_AGGREGATIONS)[number];

export const METER_STATUSES = ['active', 'inactive'] as const;
export type MeterStatus = (typeof METER_STATUSES)[number];

// ---- Recurring billing transport (`/v1/billing/*`) ---------------------------

/** A provider subscription's status, as the recurring transport observes it. */
export const BILLING_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];

/** `fiat` (Stripe and any further provider) or `faircoin` (native, to the merchant's watch-only wallet). */
export const BILLING_RAIL_SETTLEMENTS = ['fiat', 'faircoin'] as const;
export type BillingRailSettlement = (typeof BILLING_RAIL_SETTLEMENTS)[number];

/** `automatic`: the provider charges each period. `payer_initiated`: each period is an explicit payment. */
export const BILLING_RAIL_RENEWALS = ['automatic', 'payer_initiated'] as const;
export type BillingRailRenewal = (typeof BILLING_RAIL_RENEWALS)[number];

// ---- Product tax codes (Peable Tax, ADR 0011) ---------------------------------

/**
 * The product tax codes Peable accepts, starting with digital services and
 * SaaS — what every Oxy application sells. Ids are Stripe Tax's tax codes, so
 * a code means the same thing to Peable and to the provider calculating it.
 * Adding a category is adding a row here; classifying a product is the
 * seller's decision. `GET /v1/tax/codes` lists them.
 */
export const TAX_CODES = Object.freeze([
  {
    id: 'txcd_00000000',
    name: 'Nontaxable',
    description: 'A product that is not subject to tax anywhere. No tax is calculated.',
  },
  {
    id: 'txcd_10000000',
    name: 'General - Electronically Supplied Services',
    description:
      'A service delivered electronically over the internet with minimal human involvement.',
  },
  {
    id: 'txcd_10103000',
    name: 'Software as a service (SaaS) - personal use',
    description: 'Hosted software accessed online, sold to consumers for personal use.',
  },
  {
    id: 'txcd_10103001',
    name: 'Software as a service (SaaS) - business use',
    description: 'Hosted software accessed online, sold to businesses for business use.',
  },
  {
    id: 'txcd_10202000',
    name: 'Downloadable Software - personal use',
    description: 'Software downloaded to the customer’s device, for personal use.',
  },
  {
    id: 'txcd_10202003',
    name: 'Downloadable Software - business use',
    description: 'Software downloaded to the customer’s device, for business use.',
  },
  {
    id: 'txcd_10701100',
    name: 'Website Hosting',
    description: 'Hosting of a website or web application on the seller’s servers.',
  },
] as const);

/** The code of a product no tax is calculated for, anywhere. */
export const NONTAXABLE_TAX_CODE = 'txcd_00000000';

const KNOWN_TAX_CODES: ReadonlySet<string> = new Set(TAX_CODES.map((code) => code.id));

/** Whether `id` is one of {@link TAX_CODES}. */
export const isKnownTaxCode = (id: string): boolean => KNOWN_TAX_CODES.has(id);
