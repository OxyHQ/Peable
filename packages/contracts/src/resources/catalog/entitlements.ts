import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { queryFlag } from './shared';

/**
 * Entitlements (ADR 0018 §8): features (`feat_…`) a product grants, and what a
 * customer may access NOW. `lookup_key` is what an app checks access by.
 */

/** A feature (`feat_…`) a product grants — `lookup_key` is what an app checks. */
export const entitlementFeatureSchema = defineObject(
  'entitlements.feature',
  'EntitlementFeature',
  z
    .object({
      id: z.string(),
      object: z.literal('entitlements.feature'),
      livemode,
      lookup_key: z.string().describe('What an app checks access by; unique per merchant.'),
      name: z.string(),
      active: z
        .boolean()
        .describe('`false`: archived, and withdrawn from every customer that held it.'),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'feat_0193b8f2c1a87d3e9f4f',
        object: 'entitlements.feature',
        livemode: false,
        lookup_key: 'mention_plus',
        name: 'Mention Plus',
        active: true,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type EntitlementFeature = Expand<z.output<typeof entitlementFeatureSchema>>;

/** A feature attached to a product (`prodft_…`). */
export const productFeatureSchema = defineObject(
  'product_feature',
  'ProductFeature',
  z
    .object({
      id: z.string(),
      object: z.literal('product_feature'),
      livemode,
      product: z.string().describe('The product (`prod_…`) that grants it.'),
      entitlement_feature: entitlementFeatureSchema,
    })
    .strict(),
  {
    examples: [
      {
        id: 'prodft_0193b8f2c1a87d3e9f50',
        object: 'product_feature',
        livemode: false,
        product: 'prod_0193b8f2c1a87d3e9f4a',
        entitlement_feature: {
          id: 'feat_0193b8f2c1a87d3e9f4f',
          object: 'entitlements.feature',
          livemode: false,
          lookup_key: 'mention_plus',
          name: 'Mention Plus',
          active: true,
          metadata: {},
          created: 1793750400,
        },
      },
    ],
  },
);
export type ProductFeature = Expand<z.output<typeof productFeatureSchema>>;

/** What `DELETE /v1/products/{id}/features/{feature}` answers. */
export const deletedProductFeatureSchema = defineComponent(
  'DeletedProductFeature',
  deletedOf('product_feature'),
);
export type DeletedProductFeature = z.output<typeof deletedProductFeatureSchema>;

/**
 * One feature a customer is entitled to right now: some product granting it is
 * on a `trialing`, `active` or `past_due` subscription of theirs. Several
 * products granting the same feature give ONE entitlement — Mention Plus
 * through the Plus product or through Oxy One is the same access.
 */
export const activeEntitlementSchema = defineObject(
  'entitlements.active_entitlement',
  'ActiveEntitlement',
  z
    .object({
      id: z.string().describe('Stable per customer and feature.'),
      object: z.literal('entitlements.active_entitlement'),
      livemode,
      feature: z.string().describe('The feature (`feat_…`).'),
      lookup_key: z.string(),
    })
    .strict(),
  {
    examples: [
      {
        id: 'ent_5f1c0a9e2b7d4c3a8e6f1b2d',
        object: 'entitlements.active_entitlement',
        livemode: false,
        feature: 'feat_0193b8f2c1a87d3e9f4f',
        lookup_key: 'mention_plus',
      },
    ],
  },
);
export type ActiveEntitlement = Expand<z.output<typeof activeEntitlementSchema>>;

/** What `entitlements.active_entitlement_summary.updated` carries: a customer's complete set. */
export const activeEntitlementSummarySchema = defineObject(
  'entitlements.active_entitlement_summary',
  'ActiveEntitlementSummary',
  z
    .object({
      object: z.literal('entitlements.active_entitlement_summary'),
      livemode,
      customer: z.string().describe('The customer (`cus_…`).'),
      entitlements: z
        .object({
          object: z.literal('list'),
          data: z.array(activeEntitlementSchema),
          has_more: z.literal(false),
          url: z.string(),
        })
        .strict()
        .describe('The complete set: never paged.'),
    })
    .strict(),
);
export type ActiveEntitlementSummary = Expand<z.output<typeof activeEntitlementSummarySchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'entitlements.feature': EntitlementFeature;
    product_feature: ProductFeature;
    'entitlements.active_entitlement': ActiveEntitlement;
    'entitlements.active_entitlement_summary': ActiveEntitlementSummary;
  }
}

const name = z.string().min(1).max(80);

export const createEntitlementFeatureParams = z
  .object({
    lookup_key: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
    name,
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateEntitlementFeatureParams = z.input<typeof createEntitlementFeatureParams>;

export const updateEntitlementFeatureParams = z
  .object({
    name: name.optional(),
    active: z
      .boolean()
      .optional()
      .describe('`false` archives it and withdraws it from every customer that held it.'),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateEntitlementFeatureParams = z.input<typeof updateEntitlementFeatureParams>;

export const listEntitlementFeaturesQuery = listQuery({
  lookup_key: z.string().min(1).max(80).optional(),
  archived: queryFlag.optional(),
});
export type EntitlementFeatureListParams = z.input<typeof listEntitlementFeaturesQuery>;

export const attachProductFeatureParams = z
  .object({ entitlement_feature: idParam.describe('The feature (`feat_…`) to grant.') })
  .strict();
export type AttachProductFeatureParams = z.input<typeof attachProductFeatureParams>;

export const listProductFeaturesQuery = listQuery({});
export type ProductFeatureListParams = z.input<typeof listProductFeaturesQuery>;

export const listActiveEntitlementsQuery = listQuery({
  customer: idParam.describe('The customer (`cus_…`).'),
});
export type ActiveEntitlementListParams = z.input<typeof listActiveEntitlementsQuery>;

const featureId = { id: 'The feature (`feat_…`).' };

export const entitlementRoutes = [
  defineRoute({
    operationId: 'createEntitlementFeature',
    method: 'post',
    path: '/v1/entitlements/features',
    tag: 'Entitlements',
    summary: 'Create a feature',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createEntitlementFeatureParams,
    response: entitlementFeatureSchema,
    sdk: 'entitlements.features.create',
  }),
  defineRoute({
    operationId: 'listEntitlementFeatures',
    method: 'get',
    path: '/v1/entitlements/features',
    tag: 'Entitlements',
    summary: 'List features',
    auth: 'service',
    scope: 'payments:read',
    query: listEntitlementFeaturesQuery,
    response: listOf(entitlementFeatureSchema),
    sdk: 'entitlements.features.list',
    expandable: 'entitlements.feature',
  }),
  defineRoute({
    operationId: 'retrieveEntitlementFeature',
    method: 'get',
    path: '/v1/entitlements/features/{id}',
    tag: 'Entitlements',
    summary: 'Retrieve a feature',
    auth: 'service',
    scope: 'payments:read',
    params: featureId,
    query: expandOnlyQuery,
    response: entitlementFeatureSchema,
    sdk: 'entitlements.features.retrieve',
  }),
  defineRoute({
    operationId: 'updateEntitlementFeature',
    method: 'post',
    path: '/v1/entitlements/features/{id}',
    tag: 'Entitlements',
    summary: 'Update a feature',
    description: '`active: false` archives it and withdraws it from every customer that held it.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: featureId,
    body: updateEntitlementFeatureParams,
    response: entitlementFeatureSchema,
    sdk: 'entitlements.features.update',
  }),
  defineRoute({
    operationId: 'attachProductFeature',
    method: 'post',
    path: '/v1/products/{id}/features',
    tag: 'Entitlements',
    summary: 'Attach a feature to a product',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The product (`prod_…`).' },
    body: attachProductFeatureParams,
    response: productFeatureSchema,
    sdk: 'entitlements.productFeatures.attach',
  }),
  defineRoute({
    operationId: 'listProductFeatures',
    method: 'get',
    path: '/v1/products/{id}/features',
    tag: 'Entitlements',
    summary: "List a product's features",
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The product (`prod_…`).' },
    query: listProductFeaturesQuery,
    response: listOf(productFeatureSchema),
    sdk: 'entitlements.productFeatures.list',
    expandable: 'product_feature',
  }),
  defineRoute({
    operationId: 'detachProductFeature',
    method: 'delete',
    path: '/v1/products/{id}/features/{feature}',
    tag: 'Entitlements',
    summary: 'Detach a feature from a product',
    auth: 'service',
    scope: 'payments:write',
    params: {
      id: 'The product (`prod_…`).',
      feature: 'The attachment (`prodft_…`).',
    },
    response: deletedProductFeatureSchema,
    sdk: 'entitlements.productFeatures.detach',
  }),
  defineRoute({
    operationId: 'listActiveEntitlements',
    method: 'get',
    path: '/v1/entitlements/active_entitlements',
    tag: 'Entitlements',
    summary: "List a customer's active entitlements",
    description:
      'What the customer may access NOW: one entitlement per feature, however many products grant it. A complete set, never paged (`has_more` is always `false`).',
    auth: 'service',
    scope: 'payments:read',
    query: listActiveEntitlementsQuery,
    response: listOf(activeEntitlementSchema),
    sdk: 'entitlements.activeEntitlements.list',
  }),
] as const;
