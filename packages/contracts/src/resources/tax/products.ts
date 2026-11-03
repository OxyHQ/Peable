import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { taxReferenceParam } from './shared';

/**
 * A product's tax code: what a calculation line naming `product_ref` is taxed
 * as when the line does not say. Classifying a product is the seller's call.
 */
export const taxProductCodeSchema = defineObject(
  'tax.product',
  'TaxProductCode',
  z
    .object({
      object: z.literal('tax.product'),
      product_ref: z
        .string()
        .describe("The merchant's product or plan reference (a billing `planId`)."),
      tax_code: z.string().describe('`txcd_…`.'),
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.product',
        product_ref: 'plan_pro_monthly',
        tax_code: 'txcd_10103001',
        updated_at: 1793750400,
      },
    ],
  },
);
export type TaxProductCode = Expand<z.output<typeof taxProductCodeSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.product': TaxProductCode;
  }
}

/** `{productRef}` of `PUT /v1/tax/products/{productRef}`. */
export const taxProductRefParam = taxReferenceParam;

export const setTaxProductCodeParams = z
  .object({ tax_code: z.string().describe('A `txcd_…` from `GET /v1/tax/codes`.') })
  .strict();
export type SetTaxProductCodeParams = z.input<typeof setTaxProductCodeParams>;

export const taxProductRoutes = [
  defineRoute({
    operationId: 'listTaxProducts',
    method: 'get',
    path: '/v1/tax/products',
    tag: 'Tax',
    summary: 'List product tax codes',
    description:
      'Every classified product, by `product_ref`: a complete list, `has_more` is `false`.',
    auth: 'service',
    scope: 'payments:read',
    response: listOf(taxProductCodeSchema),
    sdk: 'tax.products.list',
  }),
  defineRoute({
    operationId: 'setTaxProductCode',
    method: 'put',
    path: '/v1/tax/products/{productRef}',
    tag: 'Tax',
    summary: "Set a product's tax code",
    description: 'Creates the classification or replaces it.',
    auth: 'service',
    scope: 'payments:write',
    params: {
      productRef: "The merchant's product or plan reference: 1–128 of `A-Z a-z 0-9 _ . : -`.",
    },
    body: setTaxProductCodeParams,
    response: taxProductCodeSchema,
    sdk: 'tax.products.setTaxCode',
  }),
] as const;
