import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  queryBoolean,
} from '../../common/params';
import { livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  PORTAL_CANCEL_MODES,
  PORTAL_CANCEL_PRORATION_BEHAVIORS,
  PORTAL_CUSTOMER_UPDATES,
  PORTAL_SUBSCRIPTION_UPDATES,
} from '../../vocabulary/billingPortal';
import { PRORATION_BEHAVIORS } from '../../vocabulary/subscriptions';
import { httpUrlParam, shortText } from './params';

/**
 * The customer portal's merchant side (ADR 0018 §9): configurations (`bpc_…`)
 * say what the Orbit-hosted portal lets a customer do; a session (`bps_…`) is
 * a short-lived URL for ONE customer.
 */

/** What the hosted portal lets a customer do. */
export const billingPortalFeaturesSchema = defineComponent(
  'BillingPortalFeatures',
  z
    .object({
      customer_update: z
        .object({
          enabled: z.boolean(),
          allowed_updates: z.array(z.enum(PORTAL_CUSTOMER_UPDATES)),
        })
        .strict(),
      invoice_history: z.object({ enabled: z.boolean() }).strict(),
      payment_method_update: z.object({ enabled: z.boolean() }).strict(),
      subscription_cancel: z
        .object({
          enabled: z.boolean(),
          mode: z.enum(PORTAL_CANCEL_MODES),
          proration_behavior: z.enum(PORTAL_CANCEL_PRORATION_BEHAVIORS),
        })
        .strict(),
      subscription_update: z
        .object({
          enabled: z.boolean(),
          default_allowed_updates: z.array(z.enum(PORTAL_SUBSCRIPTION_UPDATES)),
          proration_behavior: z.enum(PRORATION_BEHAVIORS),
          products: z
            .array(z.object({ product: z.string(), prices: z.array(z.string()) }).strict())
            .describe('The plans a customer may switch between: per product, its allowed prices.'),
        })
        .strict(),
    })
    .strict(),
);
export type BillingPortalFeatures = z.output<typeof billingPortalFeaturesSchema>;

/** The business the portal presents. */
export const billingPortalBusinessProfileSchema = defineComponent(
  'BillingPortalBusinessProfile',
  z
    .object({
      headline: z.string().nullable(),
      privacy_policy_url: z.string().nullable(),
      terms_of_service_url: z.string().nullable(),
    })
    .strict(),
);
export type BillingPortalBusinessProfile = z.output<typeof billingPortalBusinessProfileSchema>;

export const billingPortalConfigurationSchema = defineObject(
  'billing_portal.configuration',
  'BillingPortalConfiguration',
  z
    .object({
      id: z.string(),
      object: z.literal('billing_portal.configuration'),
      livemode,
      active: z.boolean(),
      is_default: z
        .boolean()
        .describe('The configuration a session uses when it names none (created on first use).'),
      business_profile: billingPortalBusinessProfileSchema,
      default_return_url: z.string().nullable(),
      features: billingPortalFeaturesSchema,
      metadata,
      created: unixSeconds,
      updated: unixSeconds,
    })
    .strict(),
);
export type BillingPortalConfiguration = Expand<z.output<typeof billingPortalConfigurationSchema>>;

/**
 * A portal session: a short-lived URL for ONE customer. The URL is a bearer
 * credential — hand it to that customer only, right away. It is answered once
 * and never stored.
 */
export const billingPortalSessionSchema = defineObject(
  'billing_portal.session',
  'BillingPortalSession',
  z
    .object({
      id: z.string(),
      object: z.literal('billing_portal.session'),
      livemode,
      customer: z.string().describe('The customer (`cus_…`) the portal is for.'),
      configuration: z.string().describe('The configuration (`bpc_…`) it applies.'),
      return_url: z.string().nullable(),
      url: z.string().describe('The portal, for this customer only. A bearer credential.'),
      expires_at: unixSeconds.describe('The URL stops working after this instant.'),
      created: unixSeconds,
    })
    .strict(),
);
export type BillingPortalSession = Expand<z.output<typeof billingPortalSessionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'billing_portal.configuration': BillingPortalConfiguration;
    'billing_portal.session': BillingPortalSession;
  }
}

// ---- Requests ------------------------------------------------------------------------

const businessProfileParams = z
  .object({
    headline: shortText(60).optional(),
    privacy_policy_url: httpUrlParam.optional(),
    terms_of_service_url: httpUrlParam.optional(),
  })
  .strict();

/** Each named feature field replaces that field; the others keep their value (or default). */
const featuresParams = z
  .object({
    customer_update: z
      .object({
        enabled: z.boolean().optional(),
        allowed_updates: z.array(z.enum(PORTAL_CUSTOMER_UPDATES)).max(4).optional(),
      })
      .strict()
      .optional(),
    invoice_history: z.object({ enabled: z.boolean() }).strict().optional(),
    payment_method_update: z.object({ enabled: z.boolean() }).strict().optional(),
    subscription_cancel: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(PORTAL_CANCEL_MODES).optional(),
        proration_behavior: z.enum(PORTAL_CANCEL_PRORATION_BEHAVIORS).optional(),
      })
      .strict()
      .optional(),
    subscription_update: z
      .object({
        enabled: z.boolean().optional(),
        default_allowed_updates: z.array(z.enum(PORTAL_SUBSCRIPTION_UPDATES)).max(2).optional(),
        proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
        products: z
          .array(z.object({ product: idParam, prices: z.array(idParam).min(1).max(10) }).strict())
          .max(10)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const createBillingPortalConfigurationParams = z
  .object({
    business_profile: businessProfileParams.optional(),
    default_return_url: httpUrlParam.optional(),
    features: featuresParams,
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateBillingPortalConfigurationParams = z.input<
  typeof createBillingPortalConfigurationParams
>;

/** A field sent as `""` is cleared; `metadata` is a patch. */
export const updateBillingPortalConfigurationParams = z
  .object({
    active: z.boolean().optional().describe('The default configuration cannot be deactivated.'),
    business_profile: businessProfileParams.optional(),
    default_return_url: z.union([httpUrlParam, z.literal('')]).optional(),
    features: featuresParams.optional(),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateBillingPortalConfigurationParams = z.input<
  typeof updateBillingPortalConfigurationParams
>;

export const listBillingPortalConfigurationsQuery = listQuery({
  active: queryBoolean.optional(),
  is_default: queryBoolean.optional(),
});
export type BillingPortalConfigurationListParams = z.input<
  typeof listBillingPortalConfigurationsQuery
>;

export const createBillingPortalSessionParams = z
  .object({
    customer: idParam,
    configuration: idParam
      .optional()
      .describe("Default: the merchant's default configuration (created on first use)."),
    return_url: httpUrlParam.optional(),
  })
  .strict();
export type CreateBillingPortalSessionParams = z.input<typeof createBillingPortalSessionParams>;

// ---- Routes --------------------------------------------------------------------------

const configurationId = { id: 'The portal configuration (`bpc_…`).' } as const;

export const billingPortalRoutes = [
  defineRoute({
    operationId: 'createBillingPortalConfiguration',
    method: 'post',
    path: '/v1/billing_portal/configurations',
    tag: 'Customer portal',
    summary: 'Create a portal configuration',
    description:
      "Features not named take the safe defaults. The merchant's first configuration becomes the default.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createBillingPortalConfigurationParams,
    response: billingPortalConfigurationSchema,
    sdk: 'billingPortal.configurations.create',
  }),
  defineRoute({
    operationId: 'listBillingPortalConfigurations',
    method: 'get',
    path: '/v1/billing_portal/configurations',
    tag: 'Customer portal',
    summary: 'List portal configurations',
    auth: 'service',
    scope: 'payments:read',
    query: listBillingPortalConfigurationsQuery,
    response: listOf(billingPortalConfigurationSchema),
    sdk: 'billingPortal.configurations.list',
    expandable: 'billing_portal.configuration',
  }),
  defineRoute({
    operationId: 'retrieveBillingPortalConfiguration',
    method: 'get',
    path: '/v1/billing_portal/configurations/{id}',
    tag: 'Customer portal',
    summary: 'Retrieve a portal configuration',
    auth: 'service',
    scope: 'payments:read',
    params: configurationId,
    query: expandOnlyQuery,
    response: billingPortalConfigurationSchema,
    sdk: 'billingPortal.configurations.retrieve',
    expandable: 'billing_portal.configuration',
  }),
  defineRoute({
    operationId: 'updateBillingPortalConfiguration',
    method: 'post',
    path: '/v1/billing_portal/configurations/{id}',
    tag: 'Customer portal',
    summary: 'Update a portal configuration',
    description: 'Each named feature field replaces that field; the others are kept.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: configurationId,
    body: updateBillingPortalConfigurationParams,
    response: billingPortalConfigurationSchema,
    sdk: 'billingPortal.configurations.update',
  }),
  defineRoute({
    operationId: 'createBillingPortalSession',
    method: 'post',
    path: '/v1/billing_portal/sessions',
    tag: 'Customer portal',
    summary: 'Create a portal session',
    description:
      'A one-hour URL of the Orbit-hosted portal for one customer. The URL is a bearer credential: hand it to that customer only, right away.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createBillingPortalSessionParams,
    response: billingPortalSessionSchema,
    sdk: 'billingPortal.sessions.create',
  }),
] as const;
