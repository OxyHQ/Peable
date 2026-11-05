import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject } from '../../common/objects';
import { expandOnlyQuery, listQuery, queryBoolean } from '../../common/params';
import { currency, livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  PAYMENT_METHOD_UNAVAILABLE_REASONS,
  type PaymentMethodConfigurationType,
} from '../../vocabulary/paymentMethodConfigurations';

/**
 * Payment method breadth — which methods a merchant's payers are offered
 * (`pmc_…`), and the web domains wallets may run on (`pmd_…`). FairCoin is an
 * entry of every configuration and is locked on (ADR 0021 D2); the card-rail
 * methods are the merchant's choice. Both are Orbit's objects; the provider's
 * configuration and domain are bindings behind them (ADR 0016). Card data and
 * bank credentials are entered in the provider's hosted fields and never reach
 * Peable (PCI SAQ-A).
 */

/** The merchant's choice (`none`: Orbit's default) and what is in effect. */
export const paymentMethodDisplayPreferenceSchema = z
  .object({
    preference: z.enum(['on', 'off', 'none']),
    value: z.enum(['on', 'off']),
  })
  .strict();
export type PaymentMethodDisplayPreference = z.output<typeof paymentMethodDisplayPreferenceSchema>;

export const paymentMethodConfigurationEntrySchema = defineComponent(
  'PaymentMethodConfigurationEntry',
  z
    .object({
      available: z
        .boolean()
        .describe('Whether payers can be offered this method: it is on and nothing prevents it.'),
      display_preference: paymentMethodDisplayPreferenceSchema,
      locked: z
        .boolean()
        .describe(
          'Whether the merchant can change it. Only `faircoin` is locked: it is always on, because every payer can always pay with FairCoin (ADR 0021), and setting it `off` is refused with `payment_method_locked`.',
        ),
      unavailable_reason: z
        .enum(PAYMENT_METHOD_UNAVAILABLE_REASONS)
        .nullable()
        .describe('Why it cannot be offered whatever the merchant chooses; `null` when it can.'),
      currencies: z.array(currency).describe('The payment currencies it is offered on.'),
    })
    .strict(),
);
export type PaymentMethodConfigurationEntry = z.output<
  typeof paymentMethodConfigurationEntrySchema
>;

/** One entry of the configuration's documented example (abbreviated currency lists). */
function exampleEntry(
  preference: 'on' | 'off' | 'none',
  value: 'on' | 'off',
  overrides: Partial<PaymentMethodConfigurationEntry> = {},
): PaymentMethodConfigurationEntry {
  const unavailable_reason = overrides.unavailable_reason ?? null;
  return {
    available: value === 'on' && unavailable_reason === null,
    display_preference: { preference, value },
    locked: false,
    unavailable_reason,
    currencies: ['EUR', 'USD', 'GBP'],
    ...overrides,
  };
}

const entryFields = Object.fromEntries(
  PAYMENT_METHOD_CONFIGURATION_TYPES.map((type) => [type, paymentMethodConfigurationEntrySchema]),
) as Record<PaymentMethodConfigurationType, typeof paymentMethodConfigurationEntrySchema>;

export const paymentMethodConfigurationSchema = defineObject(
  'payment_method_configuration',
  'PaymentMethodConfiguration',
  z
    .object({
      id: z.string(),
      object: z.literal('payment_method_configuration'),
      livemode,
      name: z.string(),
      active: z
        .boolean()
        .describe(
          'An inactive configuration cannot be named on a new PaymentIntent. The default is always active.',
        ),
      is_default: z
        .boolean()
        .describe('The configuration a PaymentIntent uses when it names none. One per merchant.'),
      created: unixSeconds,
      updated_at: unixSeconds,
      ...entryFields,
    })
    .strict(),
  {
    examples: [
      {
        id: 'pmc_0193b8f2c1a87d3e9f4b',
        object: 'payment_method_configuration',
        livemode: false,
        name: 'Default',
        active: true,
        is_default: true,
        created: 1793750400,
        updated_at: 1793750400,
        faircoin: exampleEntry('on', 'on', { locked: true, currencies: ['FAIR', 'EUR', 'USD'] }),
        card: exampleEntry('none', 'on'),
        apple_pay: exampleEntry('none', 'on'),
        google_pay: exampleEntry('none', 'on'),
        sepa_debit: exampleEntry('on', 'on', { currencies: ['EUR'] }),
        ideal: exampleEntry('none', 'off', { currencies: ['EUR'] }),
        bancontact: exampleEntry('none', 'off', { currencies: ['EUR'] }),
        eps: exampleEntry('none', 'off', { currencies: ['EUR'] }),
        bizum: exampleEntry('none', 'off', {
          currencies: ['EUR'],
          unavailable_reason: 'provider_unsupported',
        }),
      },
    ],
  },
);
export type PaymentMethodConfiguration = z.output<typeof paymentMethodConfigurationSchema>;

/** A wallet's standing on one domain. */
export const paymentMethodDomainWalletStatusSchema = defineComponent(
  'PaymentMethodDomainWalletStatus',
  z
    .object({
      status: z
        .enum(['active', 'inactive'])
        .describe('`active`: the wallet can run on pages served from this domain.'),
      status_details: z
        .object({ error_message: z.string() })
        .strict()
        .nullable()
        .describe("Present while `inactive`: what the wallet's verification said."),
    })
    .strict(),
);
export type PaymentMethodDomainWalletStatus = z.output<
  typeof paymentMethodDomainWalletStatusSchema
>;

/**
 * A web domain the merchant serves payment pages from (`pmd_…`), registered so
 * Apple Pay and Google Pay run there. Peable's own hosted checkout needs none.
 */
export const paymentMethodDomainSchema = defineObject(
  'payment_method_domain',
  'PaymentMethodDomain',
  z
    .object({
      id: z.string(),
      object: z.literal('payment_method_domain'),
      livemode,
      domain_name: z.string().describe('Lowercase hostname, no scheme, port or path.'),
      enabled: z.boolean().describe('Whether wallets may run on it at all.'),
      apple_pay: paymentMethodDomainWalletStatusSchema,
      google_pay: paymentMethodDomainWalletStatusSchema,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'pmd_0193b8f2c1a87d3e9f4a',
        object: 'payment_method_domain',
        livemode: false,
        domain_name: 'shop.example.com',
        enabled: true,
        apple_pay: { status: 'active', status_details: null },
        google_pay: { status: 'active', status_details: null },
        created: 1793750400,
      },
    ],
  },
);
export type PaymentMethodDomain = z.output<typeof paymentMethodDomainSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    payment_method_configuration: PaymentMethodConfiguration;
    payment_method_domain: PaymentMethodDomain;
  }
}

/**
 * One method's setting in a create or update. `none` returns it to Orbit's
 * default. For `faircoin` only `on` and `none` are accepted, and neither stores
 * anything: it is always on, and `off` is refused with `payment_method_locked`.
 */
export const paymentMethodConfigurationEntryParams = z
  .object({
    display_preference: z.object({ preference: z.enum(['on', 'off', 'none']) }).strict(),
  })
  .strict();
export type PaymentMethodConfigurationEntryParams = z.input<
  typeof paymentMethodConfigurationEntryParams
>;

const methodParams = Object.fromEntries(
  PAYMENT_METHOD_CONFIGURATION_TYPES.map((type) => [
    type,
    paymentMethodConfigurationEntryParams.optional(),
  ]),
) as Record<
  PaymentMethodConfigurationType,
  z.ZodOptional<typeof paymentMethodConfigurationEntryParams>
>;

/** `POST /v1/payment_method_configurations` — an additional, non-default configuration. */
export const createPaymentMethodConfigurationParams = z
  .object({ name: z.string().min(1).max(100).optional(), ...methodParams })
  .strict();
export type CreatePaymentMethodConfigurationParams = z.input<
  typeof createPaymentMethodConfigurationParams
>;

/** `POST /v1/payment_method_configurations/{id}` — methods (merged), name, active. */
export const updatePaymentMethodConfigurationParams = z
  .object({
    name: z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
    ...methodParams,
  })
  .strict();
export type UpdatePaymentMethodConfigurationParams = z.input<
  typeof updatePaymentMethodConfigurationParams
>;

export const listPaymentMethodConfigurationsQuery = listQuery({});

export const createPaymentMethodDomainParams = z
  .object({ domain_name: z.string().min(1).max(300), enabled: z.boolean().optional() })
  .strict();
export type CreatePaymentMethodDomainParams = z.input<typeof createPaymentMethodDomainParams>;

export const updatePaymentMethodDomainParams = z
  .object({ enabled: z.boolean().optional() })
  .strict();
export type UpdatePaymentMethodDomainParams = z.input<typeof updatePaymentMethodDomainParams>;

/** The validate body: nothing. */
export const validatePaymentMethodDomainParams = z.object({}).strict();

export const listPaymentMethodDomainsQuery = listQuery({
  domain_name: z.string().min(1).max(253).optional().describe('Exact match, any case.'),
  enabled: queryBoolean.optional(),
});
export type ListPaymentMethodDomainsParams = Pick<
  z.input<typeof listPaymentMethodDomainsQuery>,
  'domain_name' | 'enabled'
>;

const pmcId = { id: 'The configuration (`pmc_…`).' } as const;
const pmdId = { id: 'The domain (`pmd_…`).' } as const;

export const paymentMethodConfigurationRoutes = [
  defineRoute({
    operationId: 'listPaymentMethodConfigurations',
    method: 'get',
    path: '/v1/payment_method_configurations',
    tag: 'Payment method configurations',
    summary: 'List payment method configurations',
    description: 'The default configuration is created on first read.',
    auth: 'service',
    scope: 'payments:read',
    query: listPaymentMethodConfigurationsQuery,
    response: listOf(paymentMethodConfigurationSchema),
    sdk: 'paymentMethodConfigurations.list',
    expandable: 'payment_method_configuration',
  }),
  defineRoute({
    operationId: 'createPaymentMethodConfiguration',
    method: 'post',
    path: '/v1/payment_method_configurations',
    tag: 'Payment method configurations',
    summary: 'Create a payment method configuration',
    description:
      'An additional, non-default configuration. Turning `on` a method the processing provider does not offer is refused, and so is turning `faircoin` `off` (`payment_method_locked`): FairCoin is always offered.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createPaymentMethodConfigurationParams,
    response: paymentMethodConfigurationSchema,
    sdk: 'paymentMethodConfigurations.create',
  }),
  defineRoute({
    operationId: 'retrievePaymentMethodConfiguration',
    method: 'get',
    path: '/v1/payment_method_configurations/{id}',
    tag: 'Payment method configurations',
    summary: 'Retrieve a payment method configuration',
    auth: 'service',
    scope: 'payments:read',
    params: pmcId,
    query: expandOnlyQuery,
    response: paymentMethodConfigurationSchema,
    sdk: 'paymentMethodConfigurations.retrieve',
    expandable: 'payment_method_configuration',
  }),
  defineRoute({
    operationId: 'updatePaymentMethodConfiguration',
    method: 'post',
    path: '/v1/payment_method_configurations/{id}',
    tag: 'Payment method configurations',
    summary: 'Update a payment method configuration',
    description:
      'Method settings are merged; the default configuration is always active. `faircoin` is locked on: setting it `off` is refused with `payment_method_locked`.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: pmcId,
    body: updatePaymentMethodConfigurationParams,
    response: paymentMethodConfigurationSchema,
    sdk: 'paymentMethodConfigurations.update',
  }),
  defineRoute({
    operationId: 'listPaymentMethodDomains',
    method: 'get',
    path: '/v1/payment_method_domains',
    tag: 'Payment method domains',
    summary: 'List payment method domains',
    auth: 'service',
    scope: 'payments:read',
    query: listPaymentMethodDomainsQuery,
    response: listOf(paymentMethodDomainSchema),
    sdk: 'paymentMethodDomains.list',
    expandable: 'payment_method_domain',
  }),
  defineRoute({
    operationId: 'createPaymentMethodDomain',
    method: 'post',
    path: '/v1/payment_method_domains',
    tag: 'Payment method domains',
    summary: 'Register a payment method domain',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createPaymentMethodDomainParams,
    response: paymentMethodDomainSchema,
    sdk: 'paymentMethodDomains.create',
  }),
  defineRoute({
    operationId: 'retrievePaymentMethodDomain',
    method: 'get',
    path: '/v1/payment_method_domains/{id}',
    tag: 'Payment method domains',
    summary: 'Retrieve a payment method domain',
    auth: 'service',
    scope: 'payments:read',
    params: pmdId,
    query: expandOnlyQuery,
    response: paymentMethodDomainSchema,
    sdk: 'paymentMethodDomains.retrieve',
    expandable: 'payment_method_domain',
  }),
  defineRoute({
    operationId: 'updatePaymentMethodDomain',
    method: 'post',
    path: '/v1/payment_method_domains/{id}',
    tag: 'Payment method domains',
    summary: 'Update a payment method domain',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: pmdId,
    body: updatePaymentMethodDomainParams,
    response: paymentMethodDomainSchema,
    sdk: 'paymentMethodDomains.update',
  }),
  defineRoute({
    operationId: 'validatePaymentMethodDomain',
    method: 'post',
    path: '/v1/payment_method_domains/{id}/validate',
    tag: 'Payment method domains',
    summary: 'Validate a payment method domain',
    description: "Re-runs the wallets' verification of the domain.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: pmdId,
    body: validatePaymentMethodDomainParams,
    response: paymentMethodDomainSchema,
    sdk: 'paymentMethodDomains.validate',
  }),
] as const;
