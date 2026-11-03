/**
 * The catalog's request validators (ADR 0018), shared by every body that
 * describes a price — `POST /v1/prices`, a product's `default_price_data`,
 * and the inline `price_data` a checkout line item or an invoice item will
 * name — so one shape rule is written once and every caller refuses the same
 * mistake with the same `param`.
 *
 * Amounts are base-unit STRINGS (`CONVENTIONS.md` §Money) and bounded per
 * currency by its decimals: at most {@link CATALOG_MAX_WHOLE_UNITS} whole
 * units, so a FAIR amount (8 decimals) and a EUR amount (2) are bounded at the
 * same real size rather than the same number of digits.
 */
import { z } from 'zod';
import {
  CATALOG_LIMITS,
  CURRENCY_CODES,
  type CurrencyCode,
  decimalsFor,
  isBaseUnitString,
  PRICE_BILLING_SCHEMES,
  PRICE_TAX_BEHAVIORS,
  PRICE_TIERS_MODES,
  RECURRING_INTERVALS,
  RECURRING_USAGE_TYPES,
  type RecurringInterval,
  TRANSFORM_QUANTITY_ROUNDS,
} from '@peable.to/shared-types';
import type { PriceShape } from '../../db/catalog/priceRepository';
import type { StoredPriceTier } from '../../db/schema/catalog';
import { expandParam } from '../../lib/list';
import { metadataCreateSchema } from '../../lib/metadata';
import { isKnownTaxCode } from '../tax/codes';

/** The largest amount the catalog stores, in whole units of any currency. */
export const CATALOG_MAX_WHOLE_UNITS = 1_000_000_000n;

/** The largest base-unit amount of `currency` the catalog accepts. */
export function maxBaseUnits(currency: CurrencyCode): bigint {
  return CATALOG_MAX_WHOLE_UNITS * 10n ** BigInt(decimalsFor(currency)) - 1n;
}

/** The longest a recurring interval may be: three years, in each unit. */
export const RECURRING_INTERVAL_COUNT_MAX: Readonly<Record<RecurringInterval, number>> = {
  day: 1095,
  week: 156,
  month: 36,
  year: 3,
};

export const currencySchema = z.enum(
  CURRENCY_CODES as unknown as [CurrencyCode, ...CurrencyCode[]],
);

/** A canonical base-unit integer string: `"1999"`, never `"19.99"` or `1999`. */
export const amountSchema = z
  .string()
  .refine(isBaseUnitString, 'must be a non-negative integer string in the smallest currency unit');

const safeCount = z.number().int().min(1).max(2_147_483_647);

/** `true`/`false` in a query string. */
export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/** `ids[]=a&ids[]=b` or `ids=a`. */
export function idListQuery(max: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? [value] : value),
    z.array(z.string().min(1).max(255)).min(1).max(max),
  );
}

/** `""` on an update clears the field, Stripe's rule. */
export const clearable = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.literal('')]).transform((value) => (value === '' ? null : value));

/** Report one broken rule at `path` (relative to the object being parsed). */
type Issue = (path: (string | number)[], message: string) => void;

function issuer(ctx: z.RefinementCtx): { issue: Issue; failed: () => boolean } {
  let failed = false;
  return {
    issue: (path, message) => {
      failed = true;
      ctx.addIssue({ code: 'custom', path, message });
    },
    failed: () => failed,
  };
}

function amountWithinBound(
  issue: Issue,
  amount: string | undefined,
  currency: CurrencyCode,
  path: (string | number)[],
): void {
  if (amount === undefined || !isBaseUnitString(amount)) return;
  if (BigInt(amount) > maxBaseUnits(currency)) {
    issue(
      path,
      `must be at most ${maxBaseUnits(currency)} (${CATALOG_MAX_WHOLE_UNITS} whole ${currency})`,
    );
  }
}

const recurringInputSchema = z
  .object({
    interval: z.enum(RECURRING_INTERVALS),
    interval_count: safeCount.optional(),
    usage_type: z.enum(RECURRING_USAGE_TYPES).optional(),
    /** A metered price's meter (`mtr_…`), resolved by the service. */
    meter: z.string().min(1).max(255).optional(),
  })
  .strict();

const tierInputSchema = z
  .object({
    up_to: z.union([z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), z.literal('inf')]),
    unit_amount: amountSchema.optional(),
    flat_amount: amountSchema.optional(),
  })
  .strict();

const transformQuantitySchema = z
  .object({
    divide_by: safeCount,
    round: z.enum(TRANSFORM_QUANTITY_ROUNDS),
  })
  .strict();

/** The fields that make up a price's shape, as a request names them. */
export const priceShapeFields = {
  currency: currencySchema,
  unit_amount: amountSchema.optional(),
  billing_scheme: z.enum(PRICE_BILLING_SCHEMES).optional(),
  tiers: z.array(tierInputSchema).min(1).max(CATALOG_LIMITS.priceTiersMax).optional(),
  tiers_mode: z.enum(PRICE_TIERS_MODES).optional(),
  transform_quantity: transformQuantitySchema.optional(),
  recurring: recurringInputSchema.optional(),
  tax_behavior: z.enum(PRICE_TAX_BEHAVIORS).optional(),
};

type PriceShapeInput = {
  currency: CurrencyCode;
  unit_amount?: string | undefined;
  billing_scheme?: (typeof PRICE_BILLING_SCHEMES)[number] | undefined;
  tiers?: z.infer<typeof tierInputSchema>[] | undefined;
  tiers_mode?: (typeof PRICE_TIERS_MODES)[number] | undefined;
  transform_quantity?: z.infer<typeof transformQuantitySchema> | undefined;
  recurring?: z.infer<typeof recurringInputSchema> | undefined;
  tax_behavior?: (typeof PRICE_TAX_BEHAVIORS)[number] | undefined;
};

/**
 * Decide the stored shape of a price from its request fields, adding an issue
 * (with the field's path) for every rule it breaks. Returns `null` when any
 * rule was broken.
 */
export function priceShapeOf(input: PriceShapeInput, ctx: z.RefinementCtx): PriceShape | null {
  const { issue, failed } = issuer(ctx);
  const scheme = input.billing_scheme ?? 'per_unit';

  let tiers: StoredPriceTier[] | null = null;
  if (scheme === 'per_unit') {
    if (input.unit_amount === undefined) {
      issue(['unit_amount'], 'unit_amount is required for a per_unit price');
    }
    if (input.tiers !== undefined) issue(['tiers'], 'tiers are only for a tiered price');
    if (input.tiers_mode !== undefined) {
      issue(['tiers_mode'], 'tiers_mode is only for a tiered price');
    }
    amountWithinBound(issue, input.unit_amount, input.currency, ['unit_amount']);
  } else {
    if (input.unit_amount !== undefined) {
      issue(['unit_amount'], 'a tiered price takes its amounts from tiers, not unit_amount');
    }
    if (input.tiers_mode === undefined) issue(['tiers_mode'], 'tiers_mode is required');
    if (input.transform_quantity !== undefined) {
      issue(['transform_quantity'], 'transform_quantity is only for a per_unit price');
    }
    if (input.tiers === undefined) issue(['tiers'], 'tiers are required for a tiered price');
    else tiers = tiersOf(input.tiers, input.currency, issue);
  }

  let recurring: PriceShape['recurring'] = null;
  if (input.recurring) {
    const count = input.recurring.interval_count ?? 1;
    const max = RECURRING_INTERVAL_COUNT_MAX[input.recurring.interval];
    if (count > max) {
      issue(
        ['recurring', 'interval_count'],
        `an interval is at most three years (${max} ${input.recurring.interval}s)`,
      );
    }
    const usageType = input.recurring.usage_type ?? 'licensed';
    const meter = 'meter' in input.recurring ? input.recurring.meter : undefined;
    if (usageType === 'metered' && meter === undefined) {
      issue(['recurring', 'meter'], 'a metered price names the meter (mtr_…) it bills');
    }
    if (usageType === 'licensed' && meter !== undefined) {
      issue(['recurring', 'meter'], 'only a metered price has a meter');
    }
    recurring = {
      interval: input.recurring.interval,
      intervalCount: count,
      usageType,
      ...(meter !== undefined ? { meterPublicId: meter } : {}),
    };
  }

  if (failed()) return null;
  return {
    currency: input.currency,
    unitAmount: scheme === 'per_unit' ? (input.unit_amount ?? null) : null,
    billingScheme: scheme,
    tiers,
    tiersMode: scheme === 'tiered' ? (input.tiers_mode ?? null) : null,
    transformQuantity: input.transform_quantity
      ? { divideBy: input.transform_quantity.divide_by, round: input.transform_quantity.round }
      : null,
    recurring,
    taxBehavior: input.tax_behavior ?? 'unspecified',
  };
}

function tiersOf(
  input: z.infer<typeof tierInputSchema>[],
  currency: CurrencyCode,
  issue: Issue,
): StoredPriceTier[] {
  let previous = 0;
  return input.map((tier, index) => {
    const last = index === input.length - 1;
    const path = ['tiers', index];
    if (last && tier.up_to !== 'inf') {
      issue([...path, 'up_to'], "the last tier's up_to must be 'inf'");
    } else if (!last && tier.up_to === 'inf') {
      issue([...path, 'up_to'], "only the last tier's up_to may be 'inf'");
    } else if (tier.up_to !== 'inf') {
      if (tier.up_to <= previous) {
        issue([...path, 'up_to'], 'tier up_to values must ascend');
      }
      previous = tier.up_to;
    }
    if (tier.unit_amount === undefined && tier.flat_amount === undefined) {
      issue(path, 'a tier needs a unit_amount, a flat_amount or both');
    }
    amountWithinBound(issue, tier.unit_amount, currency, [...path, 'unit_amount']);
    amountWithinBound(issue, tier.flat_amount, currency, [...path, 'flat_amount']);
    return {
      up_to: tier.up_to === 'inf' ? null : tier.up_to,
      unit_amount: tier.unit_amount ?? null,
      flat_amount: tier.flat_amount ?? null,
    };
  });
}

const lookupKeySchema = z.string().min(1).max(CATALOG_LIMITS.lookupKeyMax);
const nicknameSchema = z.string().min(1).max(CATALOG_LIMITS.priceNicknameMax);

/**
 * Inline `price_data` (Stripe's): a one-off per-unit price for a checkout
 * line item or an invoice item that names no stored price. Never stored as a
 * `price_…` by itself; the caller prices it with `pricing.ts`.
 */
const inlinePriceFields = {
  currency: currencySchema,
  unit_amount: amountSchema,
  recurring: recurringInputSchema.omit({ usage_type: true, meter: true }).optional(),
  tax_behavior: z.enum(PRICE_TAX_BEHAVIORS).optional(),
};

/** `price_data` — inline price of an existing product (`product: 'prod_…'`). */
export const priceDataSchema = z
  .object({ ...inlinePriceFields, product: z.string().min(1).max(255) })
  .strict()
  .transform((input, ctx) => {
    const shape = priceShapeOf(input, ctx);
    return shape === null ? z.NEVER : { product: input.product, shape };
  });

/** `default_price_data` on a product create — `price_data` for the product being made. */
export const defaultPriceDataSchema = z
  .object(inlinePriceFields)
  .strict()
  .transform((input, ctx) => priceShapeOf(input, ctx) ?? z.NEVER);

/** `POST /v1/prices`. */
export const createPriceBodySchema = z
  .object({
    ...priceShapeFields,
    product: z.string().min(1).max(255),
    lookup_key: lookupKeySchema.optional(),
    transfer_lookup_key: z.boolean().optional(),
    nickname: nicknameSchema.optional(),
    active: z.boolean().optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict()
  .transform((input, ctx) => {
    if (input.transfer_lookup_key && input.lookup_key === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['transfer_lookup_key'],
        message: 'transfer_lookup_key needs a lookup_key',
      });
    }
    const shape = priceShapeOf(input, ctx);
    return shape === null ? z.NEVER : { ...input, shape };
  });

/** `POST /v1/prices/:id` — the only mutable fields. */
export const updatePriceFields = {
  active: z.boolean().optional(),
  nickname: clearable(nicknameSchema).optional(),
  lookup_key: clearable(lookupKeySchema).optional(),
  transfer_lookup_key: z.boolean().optional(),
  tax_behavior: z.enum(PRICE_TAX_BEHAVIORS).optional(),
};

// ---- Products ----------------------------------------------------------------

const urlSchema = z
  .string()
  .max(CATALOG_LIMITS.urlMax)
  .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');

export const productFields = {
  name: z.string().min(1).max(CATALOG_LIMITS.productNameMax),
  description: z.string().min(1).max(CATALOG_LIMITS.productDescriptionMax),
  images: z.array(urlSchema).max(CATALOG_LIMITS.productImagesMax),
  tax_code: z
    .string()
    .refine(isKnownTaxCode, 'is not a Peable Tax code (GET /v1/tax/codes lists them)'),
  unit_label: z.string().min(1).max(CATALOG_LIMITS.unitLabelMax),
  url: urlSchema,
  /**
   * Card networks print at most 22 characters, need one letter, and refuse
   * `< > \ ' " *`.
   */
  statement_descriptor: z
    .string()
    .min(1)
    .max(CATALOG_LIMITS.statementDescriptorMax)
    .regex(/[A-Za-z]/, 'must contain at least one letter')
    .refine((value) => !/[<>\\'"*]/.test(value), 'cannot contain < > \\ \' " or *'),
  marketing_features: z
    .array(
      z.object({ name: z.string().min(1).max(CATALOG_LIMITS.marketingFeatureNameMax) }).strict(),
    )
    .max(CATALOG_LIMITS.marketingFeaturesMax),
};

// ---- Coupons and promotion codes ---------------------------------------------

/**
 * A percentage with at most two decimals, as basis points (12.5 → 1250). The
 * check is on the scaled value, so 33.333 is refused rather than rounded.
 */
export const percentOffSchema = z
  .number()
  .gt(0)
  .max(100)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    'percent_off has at most two decimals',
  )
  .transform((value) => Math.round(value * 100));

export const couponIdSchema = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9_-]{1,${CATALOG_LIMITS.couponIdMax}}$`),
    `a coupon id is 1–${CATALOG_LIMITS.couponIdMax} letters, digits, '_' or '-'`,
  );

export const promotionCodeSchema = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9]{1,${CATALOG_LIMITS.promotionCodeMax}}$`),
    `a code is 1–${CATALOG_LIMITS.promotionCodeMax} letters and digits`,
  );

export const unixSecondsSchema = z.number().int().positive().max(253_402_300_799);
export const redemptionsSchema = safeCount;

/** Add a bound issue for a coupon or promotion amount in `currency`. */
export function checkAmountBound(
  ctx: z.RefinementCtx,
  amount: string | undefined,
  currency: CurrencyCode | undefined,
  path: (string | number)[],
): void {
  if (currency !== undefined) amountWithinBound(issuer(ctx).issue, amount, currency, path);
}

const GENERATED_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A generated promotion code: eight characters from an alphabet without the
 * look-alikes (0/O, 1/I), so a customer can read it off a poster.
 */
export function generatePromotionCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const byte of bytes) code += GENERATED_CODE_ALPHABET[byte % GENERATED_CODE_ALPHABET.length];
  return code;
}
