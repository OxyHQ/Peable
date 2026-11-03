import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { amount, currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { CATALOG_LIMITS, COUPON_DURATIONS } from '../../vocabulary/catalog';
import {
  baseUnitAmountParam,
  checkAmountBound,
  clearing,
  countParam,
  positiveUnixSecondsParam,
} from './shared';

/**
 * Coupons (ADR 0018) — a discount, by percentage or by a fixed amount in one
 * currency. Its `id` is the merchant's own (`SUMMER25`) or generated
 * (`coupon_…`), and names that one coupon forever: a deleted coupon's id is
 * never reused. Only `name` and `metadata` change; the terms of a discount a
 * customer already holds cannot.
 */
export const couponSchema = defineObject(
  'coupon',
  'Coupon',
  z
    .object({
      id: z.string(),
      object: z.literal('coupon'),
      livemode,
      name: z.string().nullable(),
      percent_off: z
        .number()
        .nullable()
        .describe('0 < x ≤ 100, at most two decimals. Set exactly when `amount_off` is not.'),
      amount_off: amount.nullable().describe('Base units taken off, in `currency`.'),
      currency: currency.nullable(),
      duration: z.enum(COUPON_DURATIONS),
      duration_in_months: z
        .number()
        .int()
        .nullable()
        .describe('Months a `repeating` coupon lasts; `null` otherwise.'),
      max_redemptions: z.number().int().nullable(),
      redeem_by: unixSeconds.nullable().describe('The last instant it can be redeemed.'),
      times_redeemed: z.number().int(),
      valid: z
        .boolean()
        .describe('Whether it can still be redeemed: not past `redeem_by` and not used up.'),
      applies_to: z
        .object({ products: z.array(z.string()) })
        .strict()
        .nullable()
        .describe('The products (`prod_…`) it is restricted to, or `null` for every product.'),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'SUMMER25',
        object: 'coupon',
        livemode: false,
        name: 'Summer sale',
        percent_off: 25,
        amount_off: null,
        currency: null,
        duration: 'repeating',
        duration_in_months: 3,
        max_redemptions: 100,
        redeem_by: null,
        times_redeemed: 0,
        valid: true,
        applies_to: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type Coupon = Expand<z.output<typeof couponSchema>>;

/** What `DELETE /v1/coupons/{id}` answers. Existing discounts are not affected. */
export const deletedCouponSchema = defineComponent('DeletedCoupon', deletedOf('coupon'));
export type DeletedCoupon = z.output<typeof deletedCouponSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    coupon: Coupon;
  }
}

/**
 * A percentage with at most two decimals, as basis points (12.5 → 1250). The
 * check is on the scaled value, so 33.333 is refused rather than rounded.
 */
const percentOff = z
  .number()
  .gt(0)
  .max(100)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    'percent_off has at most two decimals',
  )
  .transform((value) => Math.round(value * 100));

const couponId = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9_-]{1,${CATALOG_LIMITS.couponIdMax}}$`),
    `a coupon id is 1–${CATALOG_LIMITS.couponIdMax} letters, digits, '_' or '-'`,
  );

const name = z.string().min(1).max(CATALOG_LIMITS.couponNameMax);

export const createCouponParams = z
  .object({
    id: couponId
      .optional()
      .describe('Your own id (`SUMMER25`); generated (`coupon_…`) when absent.'),
    name: name.optional(),
    percent_off: percentOff.optional(),
    amount_off: baseUnitAmountParam.optional(),
    currency: currency.optional().describe('Required with `amount_off`.'),
    duration: z.enum(COUPON_DURATIONS).optional().describe('Default `once`.'),
    duration_in_months: z
      .number()
      .int()
      .min(1)
      .max(CATALOG_LIMITS.couponDurationInMonthsMax)
      .optional()
      .describe('Required for `repeating`.'),
    max_redemptions: countParam.optional(),
    redeem_by: positiveUnixSecondsParam.optional().describe('Unix seconds, in the future.'),
    applies_to: z
      .object({
        products: z
          .array(z.string().min(1).max(255))
          .min(1)
          .max(CATALOG_LIMITS.couponAppliesToProductsMax),
      })
      .strict()
      .optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if ((body.percent_off === undefined) === (body.amount_off === undefined)) {
      issue('percent_off', 'a coupon takes exactly one of percent_off and amount_off');
    }
    if (body.amount_off !== undefined && body.currency === undefined) {
      issue('currency', 'amount_off needs a currency');
    }
    if (body.amount_off === undefined && body.currency !== undefined) {
      issue('currency', 'currency is only for an amount_off coupon');
    }
    if (body.amount_off === '0') issue('amount_off', 'amount_off must be positive');
    checkAmountBound(ctx, body.amount_off, body.currency, ['amount_off']);
    const duration = body.duration ?? 'once';
    if (duration === 'repeating' && body.duration_in_months === undefined) {
      issue('duration_in_months', 'a repeating coupon needs duration_in_months');
    }
    if (duration !== 'repeating' && body.duration_in_months !== undefined) {
      issue('duration_in_months', 'duration_in_months is only for a repeating coupon');
    }
  });
export type CreateCouponParams = z.input<typeof createCouponParams>;

export const updateCouponParams = z
  .object({
    name: clearing(name).optional().describe('`""` clears it.'),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateCouponParams = z.input<typeof updateCouponParams>;

export const listCouponsQuery = listQuery({});
export type CouponListParams = z.input<typeof listCouponsQuery>;

export const couponRoutes = [
  defineRoute({
    operationId: 'createCoupon',
    method: 'post',
    path: '/v1/coupons',
    tag: 'Coupons',
    summary: 'Create a coupon',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createCouponParams,
    response: couponSchema,
    sdk: 'coupons.create',
    expandable: 'coupon',
  }),
  defineRoute({
    operationId: 'listCoupons',
    method: 'get',
    path: '/v1/coupons',
    tag: 'Coupons',
    summary: 'List coupons',
    auth: 'service',
    scope: 'payments:read',
    query: listCouponsQuery,
    response: listOf(couponSchema),
    sdk: 'coupons.list',
    expandable: 'coupon',
  }),
  defineRoute({
    operationId: 'retrieveCoupon',
    method: 'get',
    path: '/v1/coupons/{id}',
    tag: 'Coupons',
    summary: 'Retrieve a coupon',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The coupon (`SUMMER25`, `coupon_…`).' },
    query: expandOnlyQuery,
    response: couponSchema,
    sdk: 'coupons.retrieve',
    expandable: 'coupon',
  }),
  defineRoute({
    operationId: 'updateCoupon',
    method: 'post',
    path: '/v1/coupons/{id}',
    tag: 'Coupons',
    summary: 'Update a coupon',
    description: 'Only `name` and `metadata` change.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The coupon (`SUMMER25`, `coupon_…`).' },
    body: updateCouponParams,
    response: couponSchema,
    sdk: 'coupons.update',
    expandable: 'coupon',
  }),
  defineRoute({
    operationId: 'deleteCoupon',
    method: 'delete',
    path: '/v1/coupons/{id}',
    tag: 'Coupons',
    summary: 'Delete a coupon',
    description: 'Discounts customers already hold are not affected; the id is never reused.',
    auth: 'service',
    scope: 'payments:write',
    params: { id: 'The coupon (`SUMMER25`, `coupon_…`).' },
    response: deletedCouponSchema,
    sdk: 'coupons.del',
  }),
] as const;
