import { z } from 'zod';
import { deletedOf, listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  searchQuery,
} from '../../common/params';
import { livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { CATALOG_LIMITS } from '../../vocabulary/catalog';
import { isKnownTaxCode } from '../../vocabulary/tax';
import { defaultPriceDataParams } from './prices';
import { clearing, queryFlag, queryIdList } from './shared';

/**
 * Products (`prod_…`, ADR 0018) — what a merchant sells; its prices say how
 * much. A product with prices cannot be deleted: archive it with
 * `active: false`.
 */

/** A product feature shown on pricing tables and checkout (Stripe's marketing features). */
export const productMarketingFeatureSchema = defineComponent(
  'ProductMarketingFeature',
  z.object({ name: z.string() }).strict(),
);
export type ProductMarketingFeature = z.output<typeof productMarketingFeatureSchema>;

export const productSchema = defineObject(
  'product',
  'Product',
  z
    .object({
      id: z.string(),
      object: z.literal('product'),
      livemode,
      active: z.boolean(),
      name: z.string(),
      description: z.string().nullable(),
      images: z.array(z.string()).describe('Up to 8 image URLs.'),
      metadata,
      tax_code: z
        .string()
        .nullable()
        .describe("A Peable Tax code (`txcd_…`), or `null` for the merchant's default."),
      default_price: expandable(
        'price',
        "The product's default price: `price_…`, or the Price with `expand[]=default_price`.",
      ).nullable(),
      unit_label: z
        .string()
        .nullable()
        .describe('The unit a quantity counts (`seat`), shown on receipts and invoices.'),
      url: z.string().nullable(),
      statement_descriptor: z
        .string()
        .nullable()
        .describe('What appears on a card statement; at most 22 characters.'),
      marketing_features: z.array(productMarketingFeatureSchema),
      created: unixSeconds,
      updated: unixSeconds,
    })
    .strict(),
  {
    description:
      'What a merchant sells. Its prices say how much. A product with prices cannot be deleted; set `active: false` to archive it.',
    examples: [
      {
        id: 'prod_0193b8f2c1a87d3e9f4a',
        object: 'product',
        livemode: false,
        active: true,
        name: 'Mention Plus',
        description: 'Everything in Mention, plus the Plus features.',
        images: [],
        metadata: {},
        tax_code: 'txcd_10103000',
        default_price: 'price_0193b8f2c1a87d3e9f4b',
        unit_label: null,
        url: null,
        statement_descriptor: null,
        marketing_features: [{ name: 'Longer posts' }],
        created: 1793750400,
        updated: 1793750400,
      },
    ],
  },
);
export type Product = Expand<z.output<typeof productSchema>>;

/** What `DELETE /v1/products/{id}` answers. */
export const deletedProductSchema = defineComponent('DeletedProduct', deletedOf('product'));
export type DeletedProduct = z.output<typeof deletedProductSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    product: Product;
  }
}

const url = z
  .string()
  .max(CATALOG_LIMITS.urlMax)
  .regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');

const fields = {
  name: z.string().min(1).max(CATALOG_LIMITS.productNameMax),
  description: z.string().min(1).max(CATALOG_LIMITS.productDescriptionMax),
  images: z.array(url).max(CATALOG_LIMITS.productImagesMax),
  tax_code: z
    .string()
    .refine(isKnownTaxCode, 'is not a Peable Tax code (GET /v1/tax/codes lists them)'),
  unit_label: z.string().min(1).max(CATALOG_LIMITS.unitLabelMax),
  url,
  // Card networks print at most 22 characters, need one letter, and refuse
  // `< > \ ' " *`.
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

export const createProductParams = z
  .object({
    name: fields.name,
    active: z.boolean().optional(),
    description: fields.description.optional(),
    images: fields.images.optional(),
    metadata: metadataCreateParam.optional(),
    tax_code: fields.tax_code.optional(),
    default_price_data: defaultPriceDataParams
      .optional()
      .describe("Create the product's default price with it."),
    unit_label: fields.unit_label.optional(),
    url: fields.url.optional(),
    statement_descriptor: fields.statement_descriptor.optional(),
    marketing_features: fields.marketing_features.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateProductParams = z.input<typeof createProductParams>;

/** `""` clears an optional text field; `metadata` is a patch. */
export const updateProductParams = z
  .object({
    name: fields.name.optional(),
    active: z.boolean().optional(),
    description: clearing(fields.description).optional(),
    images: fields.images.optional(),
    metadata: metadataUpdateParam.optional(),
    tax_code: clearing(fields.tax_code).optional(),
    default_price: clearing(z.string().min(1).max(255))
      .optional()
      .describe('One of this product\'s active prices; `""` clears it.'),
    unit_label: clearing(fields.unit_label).optional(),
    url: clearing(fields.url).optional(),
    statement_descriptor: clearing(fields.statement_descriptor).optional(),
    marketing_features: fields.marketing_features.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateProductParams = z.input<typeof updateProductParams>;

export const listProductsQuery = listQuery({
  active: queryFlag.optional(),
  ids: queryIdList(CATALOG_LIMITS.idsFilterMax)
    .optional()
    .describe('Only these products (at most 100).'),
});
export type ProductListParams = z.input<typeof listProductsQuery>;

export const productRoutes = [
  defineRoute({
    operationId: 'createProduct',
    method: 'post',
    path: '/v1/products',
    tag: 'Products',
    summary: 'Create a product',
    description: '`default_price_data` creates its default price in the same request.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createProductParams,
    response: productSchema,
    sdk: 'products.create',
    expandable: 'product',
  }),
  defineRoute({
    operationId: 'listProducts',
    method: 'get',
    path: '/v1/products',
    tag: 'Products',
    summary: 'List products',
    auth: 'service',
    scope: 'payments:read',
    query: listProductsQuery,
    response: listOf(productSchema),
    sdk: 'products.list',
    expandable: 'product',
  }),
  defineRoute({
    operationId: 'retrieveProduct',
    method: 'get',
    path: '/v1/products/{id}',
    tag: 'Products',
    summary: 'Retrieve a product',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The product (`prod_…`).' },
    query: expandOnlyQuery,
    response: productSchema,
    sdk: 'products.retrieve',
    expandable: 'product',
  }),
  defineRoute({
    operationId: 'updateProduct',
    method: 'post',
    path: '/v1/products/{id}',
    tag: 'Products',
    summary: 'Update a product',
    description: 'A field sent as `""` is cleared; `metadata` is a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The product (`prod_…`).' },
    body: updateProductParams,
    response: productSchema,
    sdk: 'products.update',
    expandable: 'product',
  }),
  defineRoute({
    operationId: 'deleteProduct',
    method: 'delete',
    path: '/v1/products/{id}',
    tag: 'Products',
    summary: 'Delete a product',
    description: 'Only a product nothing names; one with prices is archived with `active: false`.',
    auth: 'service',
    scope: 'payments:write',
    params: { id: 'The product (`prod_…`).' },
    response: deletedProductSchema,
    sdk: 'products.del',
  }),
  defineRoute({
    operationId: 'searchProducts',
    method: 'get',
    path: '/v1/products/search',
    tag: 'Products',
    summary: 'Search products',
    description:
      "Stripe's query language over `active`, `name`, `description`, `url`, `created` and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(productSchema),
    sdk: 'products.search',
    expandable: 'product',
  }),
] as const;
