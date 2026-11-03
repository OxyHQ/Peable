import { z } from 'zod';
import { listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  searchQuery,
} from '../../common/params';
import { amount, currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  CATALOG_LIMITS,
  PRICE_BILLING_SCHEMES,
  PRICE_TAX_BEHAVIORS,
  PRICE_TIERS_MODES,
  PRICE_TYPES,
  type PriceBillingScheme,
  type PriceTaxBehavior,
  type PriceTiersMode,
  RECURRING_INTERVAL_COUNT_MAX,
  RECURRING_INTERVALS,
  RECURRING_USAGE_TYPES,
  type RecurringInterval,
  type RecurringUsageType,
  TRANSFORM_QUANTITY_ROUNDS,
  type TransformQuantityRound,
} from '../../vocabulary/catalog';
import type { CurrencyCode } from '../../vocabulary/money';
import {
  amountWithinBound,
  baseUnitAmountParam,
  clearing,
  countParam,
  type Issue,
  issuer,
  queryFlag,
  queryIdList,
} from './shared';

/**
 * Prices (`price_…`, ADR 0018) — how much a product costs, in one currency,
 * once or per interval. A price is never deleted and its amount never
 * changes: archive it (`active: false`) and create another.
 */

/**
 * One tier of a tiered price. `up_to` is the last quantity the tier covers
 * (inclusive), and `null` on the last tier, which covers everything above —
 * sent as `'inf'`. Each amount is a base-unit string; at least one is set.
 */
export const priceTierSchema = defineComponent(
  'PriceTier',
  z
    .object({
      up_to: z
        .number()
        .int()
        .nullable()
        .describe('The last quantity this tier covers; `null` on the last tier.'),
      unit_amount: amount.nullable(),
      flat_amount: amount.nullable(),
    })
    .strict(),
);
export type PriceTier = z.output<typeof priceTierSchema>;

/**
 * Divide the quantity before pricing it: `divide_by: 10, round: 'up'` bills
 * 11 units as 2 packs of ten. Per-unit prices only.
 */
export const priceTransformQuantitySchema = defineComponent(
  'PriceTransformQuantity',
  z
    .object({
      divide_by: z.number().int(),
      round: z.enum(TRANSFORM_QUANTITY_ROUNDS),
    })
    .strict(),
);
export type PriceTransformQuantity = z.output<typeof priceTransformQuantitySchema>;

export const priceRecurringSchema = defineComponent(
  'PriceRecurring',
  z
    .object({
      interval: z.enum(RECURRING_INTERVALS),
      interval_count: z
        .number()
        .int()
        .describe(
          "Intervals between billings: `interval: 'month', interval_count: 3` is quarterly. At most three years.",
        ),
      usage_type: z.enum(RECURRING_USAGE_TYPES),
      meter: z
        .string()
        .nullable()
        .describe('The meter (`mtr_…`) a `metered` price bills; `null` when `licensed`.'),
    })
    .strict(),
);
export type PriceRecurring = z.output<typeof priceRecurringSchema>;

export const priceSchema = defineObject(
  'price',
  'Price',
  z
    .object({
      id: z.string(),
      object: z.literal('price'),
      livemode,
      active: z.boolean(),
      product: expandable(
        'product',
        'The product it prices: `prod_…`, or the Product with `expand[]=product`.',
      ),
      currency,
      unit_amount: amount.nullable().describe('Base units per unit; `null` on a tiered price.'),
      billing_scheme: z.enum(PRICE_BILLING_SCHEMES),
      tiers: z
        .array(priceTierSchema)
        .nullable()
        .describe('`null` unless `billing_scheme` is `tiered`.'),
      tiers_mode: z.enum(PRICE_TIERS_MODES).nullable(),
      transform_quantity: priceTransformQuantitySchema.nullable(),
      type: z.enum(PRICE_TYPES),
      recurring: priceRecurringSchema
        .nullable()
        .describe('`null` exactly when `type` is `one_time`.'),
      tax_behavior: z
        .enum(PRICE_TAX_BEHAVIORS)
        .describe(
          'Whether the price includes tax (Peable Tax). `unspecified` defers to the merchant default; once `inclusive` or `exclusive` it never changes.',
        ),
      lookup_key: z
        .string()
        .nullable()
        .describe(
          "The merchant's own stable name for this price, unique among its prices (per mode): retrieve the current price of a plan with `lookup_keys[]`.",
        ),
      nickname: z.string().nullable(),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    description:
      'How much a product costs, in one currency, once or per interval. Immutable once created except for `active`, `nickname`, `metadata`, `lookup_key` and — while `unspecified` — `tax_behavior`.',
    examples: [
      {
        id: 'price_0193b8f2c1a87d3e9f4b',
        object: 'price',
        livemode: false,
        active: true,
        product: 'prod_0193b8f2c1a87d3e9f4a',
        currency: 'EUR',
        unit_amount: '999',
        billing_scheme: 'per_unit',
        tiers: null,
        tiers_mode: null,
        transform_quantity: null,
        type: 'recurring',
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
        tax_behavior: 'inclusive',
        lookup_key: 'plus_monthly',
        nickname: 'Plus, monthly',
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type Price = Expand<z.output<typeof priceSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    price: Price;
  }
}

// ---- The price shape, as a request names it --------------------------------------

const recurringParams = z
  .object({
    interval: z.enum(RECURRING_INTERVALS),
    interval_count: countParam.optional().describe('Default 1.'),
    usage_type: z.enum(RECURRING_USAGE_TYPES).optional().describe('Default `licensed`.'),
    meter: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Required with `usage_type: 'metered'`: the meter (`mtr_…`) it bills."),
  })
  .strict();
export type RecurringParams = z.input<typeof recurringParams>;

const tierParams = z
  .object({
    up_to: z
      .union([z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), z.literal('inf')])
      .describe("A positive integer, ascending; the last tier is `'inf'`."),
    unit_amount: baseUnitAmountParam.optional(),
    flat_amount: baseUnitAmountParam.optional(),
  })
  .strict();
export type PriceTierParams = z.input<typeof tierParams>;

const transformQuantityParams = z
  .object({
    divide_by: countParam,
    round: z.enum(TRANSFORM_QUANTITY_ROUNDS),
  })
  .strict();

/** The fields that make up a price's shape, as a request names them. */
const priceShapeFields = {
  currency,
  unit_amount: baseUnitAmountParam
    .optional()
    .describe('Required for `per_unit`; absent for `tiered`.'),
  billing_scheme: z.enum(PRICE_BILLING_SCHEMES).optional().describe('Default `per_unit`.'),
  tiers: z.array(tierParams).min(1).max(CATALOG_LIMITS.priceTiersMax).optional(),
  tiers_mode: z.enum(PRICE_TIERS_MODES).optional(),
  transform_quantity: transformQuantityParams.optional(),
  recurring: recurringParams.optional().describe('Present: a recurring price. Absent: one-time.'),
  tax_behavior: z.enum(PRICE_TAX_BEHAVIORS).optional().describe('Default `unspecified`.'),
};

/** A tier as a parsed request stores it. */
export interface ParsedPriceTier {
  up_to: number | null;
  unit_amount: string | null;
  flat_amount: string | null;
}

/** A price's shape as a parsed request decides it (the backend stores this). */
export interface ParsedPriceShape {
  readonly currency: CurrencyCode;
  readonly unitAmount: string | null;
  readonly billingScheme: PriceBillingScheme;
  readonly tiers: readonly ParsedPriceTier[] | null;
  readonly tiersMode: PriceTiersMode | null;
  readonly transformQuantity: { divideBy: number; round: TransformQuantityRound } | null;
  readonly recurring: {
    interval: RecurringInterval;
    intervalCount: number;
    usageType: RecurringUsageType;
    /** The `mtr_…` a request named, before the gateway resolves it. */
    meterPublicId?: string;
  } | null;
  readonly taxBehavior: PriceTaxBehavior;
}

interface PriceShapeInput {
  currency: CurrencyCode;
  unit_amount?: string | undefined;
  billing_scheme?: PriceBillingScheme | undefined;
  tiers?: z.output<typeof tierParams>[] | undefined;
  tiers_mode?: PriceTiersMode | undefined;
  transform_quantity?: z.output<typeof transformQuantityParams> | undefined;
  recurring?:
    | (Partial<z.output<typeof recurringParams>> &
        Pick<z.output<typeof recurringParams>, 'interval'>)
    | undefined;
  tax_behavior?: PriceTaxBehavior | undefined;
}

function tiersOf(
  input: z.output<typeof tierParams>[],
  currency: CurrencyCode,
  issue: Issue,
): ParsedPriceTier[] {
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

/**
 * Decide the stored shape of a price from its request fields, adding an issue
 * (with the field's path) for every rule it breaks. Returns `null` when any
 * rule was broken. Amounts are bounded per currency by its decimals
 * (`maxBaseUnits`).
 */
export function priceShapeOf(
  input: PriceShapeInput,
  ctx: z.RefinementCtx,
): ParsedPriceShape | null {
  const { issue, failed } = issuer(ctx);
  const scheme = input.billing_scheme ?? 'per_unit';

  let tiers: ParsedPriceTier[] | null = null;
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

  let recurring: ParsedPriceShape['recurring'] = null;
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
    const meter = input.recurring.meter;
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

/**
 * Inline `price_data` (Stripe's): a one-off per-unit price for a checkout
 * line item or an invoice item that names no stored price. Never stored as a
 * `price_…` by itself.
 */
const inlinePriceFields = {
  currency,
  unit_amount: baseUnitAmountParam,
  recurring: recurringParams.omit({ usage_type: true, meter: true }).optional(),
  tax_behavior: z.enum(PRICE_TAX_BEHAVIORS).optional(),
};

/** `price_data` — an inline price of an existing product (`product: 'prod_…'`). */
export const priceDataParams = z
  .object({
    ...inlinePriceFields,
    product: z.string().min(1).max(255).describe('The `prod_…` it prices.'),
  })
  .strict()
  .transform((input, ctx) => {
    const shape = priceShapeOf(input, ctx);
    return shape === null ? z.NEVER : { product: input.product, shape };
  });
export type PriceDataParams = z.input<typeof priceDataParams>;

/** `default_price_data` on a product create — `price_data` for the product being made. */
export const defaultPriceDataParams = z
  .object(inlinePriceFields)
  .strict()
  .transform((input, ctx) => priceShapeOf(input, ctx) ?? z.NEVER);
export type DefaultPriceDataParams = z.input<typeof defaultPriceDataParams>;

const lookupKey = z.string().min(1).max(CATALOG_LIMITS.lookupKeyMax);
const nickname = z.string().min(1).max(CATALOG_LIMITS.priceNicknameMax);

export const createPriceParams = z
  .object({
    ...priceShapeFields,
    product: z.string().min(1).max(255),
    lookup_key: lookupKey.optional(),
    transfer_lookup_key: z
      .boolean()
      .optional()
      .describe('Move `lookup_key` here from the price that holds it.'),
    nickname: nickname.optional(),
    active: z.boolean().optional(),
    metadata: metadataCreateParam.optional(),
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
export type CreatePriceParams = z.input<typeof createPriceParams>;

/** The only mutable fields. `""` clears `nickname` and `lookup_key`. */
export const updatePriceParams = z
  .object({
    active: z.boolean().optional(),
    nickname: clearing(nickname).optional(),
    lookup_key: clearing(lookupKey).optional(),
    transfer_lookup_key: z.boolean().optional(),
    tax_behavior: z
      .enum(PRICE_TAX_BEHAVIORS)
      .optional()
      .describe("Only while the price's is `unspecified`."),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.transfer_lookup_key && (body.lookup_key === undefined || body.lookup_key === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['transfer_lookup_key'],
        message: 'transfer_lookup_key needs a lookup_key',
      });
    }
  });
export type UpdatePriceParams = z.input<typeof updatePriceParams>;

export const listPricesQuery = listQuery({
  product: idParam.optional(),
  active: queryFlag.optional(),
  type: z.enum(PRICE_TYPES).optional(),
  currency: currency.optional(),
  lookup_keys: queryIdList(CATALOG_LIMITS.lookupKeysFilterMax).optional().describe('At most 10.'),
  recurring: z
    .object({
      interval: z.enum(RECURRING_INTERVALS).optional(),
      usage_type: z.enum(RECURRING_USAGE_TYPES).optional(),
    })
    .strict()
    .optional(),
});
export type PriceListParams = z.input<typeof listPricesQuery>;

export const priceRoutes = [
  defineRoute({
    operationId: 'createPrice',
    method: 'post',
    path: '/v1/prices',
    tag: 'Prices',
    summary: 'Create a price',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createPriceParams,
    response: priceSchema,
    sdk: 'prices.create',
    expandable: 'price',
  }),
  defineRoute({
    operationId: 'listPrices',
    method: 'get',
    path: '/v1/prices',
    tag: 'Prices',
    summary: 'List prices',
    description: '`lookup_keys` (at most 10) finds the current price of a plan by its stable name.',
    auth: 'service',
    scope: 'payments:read',
    query: listPricesQuery,
    response: listOf(priceSchema),
    sdk: 'prices.list',
    expandable: 'price',
  }),
  defineRoute({
    operationId: 'retrievePrice',
    method: 'get',
    path: '/v1/prices/{id}',
    tag: 'Prices',
    summary: 'Retrieve a price',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The price (`price_…`).' },
    query: expandOnlyQuery,
    response: priceSchema,
    sdk: 'prices.retrieve',
    expandable: 'price',
  }),
  defineRoute({
    operationId: 'updatePrice',
    method: 'post',
    path: '/v1/prices/{id}',
    tag: 'Prices',
    summary: 'Update a price',
    description:
      'Only `active`, `nickname`, `metadata`, `lookup_key` and — while it is `unspecified` — `tax_behavior` change. To change an amount, create a new price and archive this one.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The price (`price_…`).' },
    body: updatePriceParams,
    response: priceSchema,
    sdk: 'prices.update',
    expandable: 'price',
  }),
  defineRoute({
    operationId: 'searchPrices',
    method: 'get',
    path: '/v1/prices/search',
    tag: 'Prices',
    summary: 'Search prices',
    description:
      "Stripe's query language over `active`, `currency`, `product`, `type`, `lookup_key`, `created` and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(priceSchema),
    sdk: 'prices.search',
    expandable: 'price',
  }),
] as const;
