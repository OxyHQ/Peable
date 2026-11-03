import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { amount, currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { CATALOG_LIMITS } from '../../vocabulary/catalog';
import {
  baseUnitAmountParam,
  checkAmountBound,
  countParam,
  positiveUnixSecondsParam,
  queryFlag,
} from './shared';

/**
 * Promotion codes (`promo_…`, ADR 0018) — a customer-facing `code` that
 * redeems a coupon, with its own limits. Codes are case-insensitive and unique
 * among a merchant's ACTIVE codes.
 */

export const promotionCodeRestrictionsSchema = defineComponent(
  'PromotionCodeRestrictions',
  z
    .object({
      first_time_transaction: z
        .boolean()
        .describe("Only a customer's first transaction may redeem it."),
      minimum_amount: amount
        .nullable()
        .describe('The smallest order total it applies to, in `minimum_amount_currency`.'),
      minimum_amount_currency: currency.nullable(),
    })
    .strict(),
);
export type PromotionCodeRestrictions = z.output<typeof promotionCodeRestrictionsSchema>;

export const promotionCodeSchema = defineObject(
  'promotion_code',
  'PromotionCode',
  z
    .object({
      id: z.string(),
      object: z.literal('promotion_code'),
      livemode,
      code: z.string(),
      coupon: expandable(
        'coupon',
        'The coupon it redeems: its id, or the Coupon with `expand[]=coupon`.',
      ),
      customer: expandable(
        'customer',
        'The one customer who may redeem it (`cus_…`, or the Customer with `expand[]=customer`); `null` for anyone.',
      ).nullable(),
      active: z.boolean(),
      max_redemptions: z.number().int().nullable(),
      expires_at: unixSeconds.nullable().describe("Never after the coupon's `redeem_by`."),
      times_redeemed: z.number().int(),
      restrictions: promotionCodeRestrictionsSchema,
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'promo_0193b8f2c1a87d3e9f4c',
        object: 'promotion_code',
        livemode: false,
        code: 'SUMMER25',
        coupon: 'SUMMER25',
        customer: null,
        active: true,
        max_redemptions: null,
        expires_at: null,
        times_redeemed: 0,
        restrictions: {
          first_time_transaction: true,
          minimum_amount: null,
          minimum_amount_currency: null,
        },
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type PromotionCode = Expand<z.output<typeof promotionCodeSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    promotion_code: PromotionCode;
  }
}

const code = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9]{1,${CATALOG_LIMITS.promotionCodeMax}}$`),
    `a code is 1–${CATALOG_LIMITS.promotionCodeMax} letters and digits`,
  );

export const createPromotionCodeParams = z
  .object({
    coupon: idParam,
    code: code.optional().describe('Letters and digits; generated when absent.'),
    customer: idParam.optional().describe('Only this customer (`cus_…`) may redeem it.'),
    active: z.boolean().optional(),
    max_redemptions: countParam.optional(),
    expires_at: positiveUnixSecondsParam.optional(),
    restrictions: z
      .object({
        first_time_transaction: z.boolean().optional(),
        minimum_amount: baseUnitAmountParam.optional(),
        minimum_amount_currency: currency.optional(),
      })
      .strict()
      .superRefine((restrictions, ctx) => {
        if (
          (restrictions.minimum_amount === undefined) !==
          (restrictions.minimum_amount_currency === undefined)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['minimum_amount_currency'],
            message: 'minimum_amount and minimum_amount_currency go together',
          });
        }
        checkAmountBound(ctx, restrictions.minimum_amount, restrictions.minimum_amount_currency, [
          'minimum_amount',
        ]);
      })
      .optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreatePromotionCodeParams = z.input<typeof createPromotionCodeParams>;

export const updatePromotionCodeParams = z
  .object({
    active: z.boolean().optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdatePromotionCodeParams = z.input<typeof updatePromotionCodeParams>;

export const listPromotionCodesQuery = listQuery({
  code: z.string().min(1).max(255).optional().describe('Case-insensitive.'),
  coupon: idParam.optional(),
  customer: idParam.optional(),
  active: queryFlag.optional(),
});
export type PromotionCodeListParams = z.input<typeof listPromotionCodesQuery>;

export const promotionCodeRoutes = [
  defineRoute({
    operationId: 'createPromotionCode',
    method: 'post',
    path: '/v1/promotion_codes',
    tag: 'Promotion codes',
    summary: 'Create a promotion code',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createPromotionCodeParams,
    response: promotionCodeSchema,
    sdk: 'promotionCodes.create',
    expandable: 'promotion_code',
  }),
  defineRoute({
    operationId: 'listPromotionCodes',
    method: 'get',
    path: '/v1/promotion_codes',
    tag: 'Promotion codes',
    summary: 'List promotion codes',
    auth: 'service',
    scope: 'payments:read',
    query: listPromotionCodesQuery,
    response: listOf(promotionCodeSchema),
    sdk: 'promotionCodes.list',
    expandable: 'promotion_code',
  }),
  defineRoute({
    operationId: 'retrievePromotionCode',
    method: 'get',
    path: '/v1/promotion_codes/{id}',
    tag: 'Promotion codes',
    summary: 'Retrieve a promotion code',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The promotion code (`promo_…`).' },
    query: expandOnlyQuery,
    response: promotionCodeSchema,
    sdk: 'promotionCodes.retrieve',
    expandable: 'promotion_code',
  }),
  defineRoute({
    operationId: 'updatePromotionCode',
    method: 'post',
    path: '/v1/promotion_codes/{id}',
    tag: 'Promotion codes',
    summary: 'Update a promotion code',
    description: 'Only `active` and `metadata` change.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The promotion code (`promo_…`).' },
    body: updatePromotionCodeParams,
    response: promotionCodeSchema,
    sdk: 'promotionCodes.update',
    expandable: 'promotion_code',
  }),
] as const;
