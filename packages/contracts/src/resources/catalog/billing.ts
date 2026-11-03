import { z } from 'zod';
import { defineComponent } from '../../common/objects';
import { defineRoute } from '../../route';
import {
  BILLING_RAIL_RENEWALS,
  BILLING_RAIL_SETTLEMENTS,
  BILLING_SUBSCRIPTION_STATUSES,
} from '../../vocabulary/catalog';

/**
 * The recurring billing transport (`/v1/billing/*`): an Oxy app's own
 * subscription checkout — Oxy One, Mention Plus — over a configured settlement
 * rail (a fiat provider such as Stripe, or FairCoin). Store and plan references
 * belong to the authenticated app; they do not identify an Oxy payer or convey
 * entitlements. Payment success and access require the authoritative backend
 * outcome read here — never a closed sheet or a browser callback.
 *
 * Every write takes an `Idempotency-Key` header, which the route REQUIRES
 * (a missing or malformed key is a 400): the key is the operation's identity
 * at the provider, not a replay convenience.
 */

// ---- Shared pieces ---------------------------------------------------------------

/** An opaque app or provider reference: 1–128 of `A–Z a–z 0–9 _ . : -`. */
export const billingReference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

/** The `Idempotency-Key` of a billing write: 1–200 of `A–Z a–z 0–9 _ . : -`. */
export const billingIdempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);

/**
 * A configured settlement rail's name (`stripe`, `faircoin`, a further fiat
 * provider). Selecting one never configures it: an unconfigured rail is
 * refused.
 */
export const billingRailId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/)
  .describe('A settlement rail: `stripe`, `faircoin`, or a further fiat provider.');

/** HTTPS destinations only; the authenticated app supplies its own return page. */
export const billingReturnUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'An HTTPS return URL without credentials is required');

/** An instant in signed billing evidence: integer Unix seconds that stay a safe integer. */
export const billingInstant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A whole number of minor units (cents) in signed billing evidence. */
const minorUnits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A billing customer reference (`cus_…`). */
export const billingCustomerRef = z
  .string()
  .regex(/^cus_[A-Za-z0-9]+$/)
  .max(128);
/** A billing price reference (`price_…`). */
export const billingPriceRef = z
  .string()
  .regex(/^price_[A-Za-z0-9]+$/)
  .max(128);

const mode = z.enum(['test', 'live']);
const environment = z.enum(['development', 'staging', 'production']);
const taxTreatment = z.enum(['inclusive', 'exclusive']);
const billingInterval = z.enum(['month', 'year']);
const ed25519Signature = z
  .object({
    algorithm: z.literal('Ed25519'),
    key_id: billingReference,
    value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict()
  .describe('Ed25519 over the canonical JSON (v1) of everything beside it.');

// ---- Rails -------------------------------------------------------------------------

/**
 * One offer a rail can sell. Fiat provider rails bind their prices from the
 * app's own provider catalogue, so they list `offers: null`.
 */
export const billingRailOfferSchema = defineComponent(
  'BillingRailOffer',
  z
    .object({
      provider_price_id: z.string(),
      plan_id: z.string(),
      interval: billingInterval,
      currency: z.string(),
      gross_minor_units: z.number().int(),
      tax_treatment: taxTreatment,
    })
    .strict(),
);
export type BillingRailOffer = z.output<typeof billingRailOfferSchema>;

/**
 * A settlement rail a merchant's recurring offers can be paid through. One
 * merchant may offer several at once and the payer chooses; every rail answers
 * through the same subscription, invoice and authority contracts.
 */
export type BillingRail = 'stripe' | 'faircoin' | (string & {});

export const billingRailOptionSchema = defineComponent(
  'BillingRailOption',
  z
    .object({
      rail: z.string().describe('The rail: `stripe`, `faircoin`, or a further fiat provider.'),
      settlement: z.enum(BILLING_RAIL_SETTLEMENTS),
      default: z
        .boolean()
        .describe('The rail a request that names none is served by: the first configured.'),
      tax_quotes: z.boolean().describe('Whether `POST /v1/billing/tax_quotes` answers for it.'),
      renewal: z
        .enum(BILLING_RAIL_RENEWALS)
        .describe(
          '`automatic`: the provider charges each period. `payer_initiated`: each period is an explicit payment (`renew`).',
        ),
      offers: z.array(billingRailOfferSchema).nullable(),
    })
    .strict(),
);
export type BillingRailOption = z.output<typeof billingRailOptionSchema>;

/** Every rail this merchant's payers can choose between, default first. A complete set. */
export const billingRailListSchema = defineComponent(
  'BillingRailList',
  z.object({ object: z.literal('list'), data: z.array(billingRailOptionSchema) }).strict(),
);
export type BillingRailList = z.output<typeof billingRailListSchema>;

// ---- Customers ---------------------------------------------------------------------

export const ensureBillingCustomerParams = z
  .object({
    store_id: billingReference.describe("The app's own store / account reference."),
    store_name: z.string().min(1).max(200),
    rail: billingRailId
      .optional()
      .describe(
        "The payer's chosen rail; default: the merchant's first. A customer belongs to one rail, and its checkouts and subscriptions follow it.",
      ),
  })
  .strict();
export type EnsureBillingCustomerParams = z.input<typeof ensureBillingCustomerParams>;

export const billingCustomerSchema = defineComponent(
  'BillingCustomer',
  z.object({ provider_customer_id: z.string() }).strict(),
);
export type BillingCustomer = z.output<typeof billingCustomerSchema>;

// ---- Tax quotes ----------------------------------------------------------------------

/**
 * A merchant asks Peable to quote a registered product. Monetary and fiscal
 * configuration is resolved inside Peable, never supplied by a consumer.
 */
export const createBillingTaxQuoteParams = z
  .object({
    rail: billingRailId
      .optional()
      .describe("Default: the first of the merchant's rails that answers tax quotes."),
    store_id: billingReference,
    plan_id: billingReference,
    provider_price_id: billingReference
      .optional()
      .describe('Selects one offer when a plan is sold at several prices.'),
    customer_location_evidence_id: billingReference.describe(
      'A `tax.location_evidence` id (`taxloc_…`) recorded for this `store_id`.',
    ),
  })
  .strict();
export type CreateBillingTaxQuoteParams = z.input<typeof createBillingTaxQuoteParams>;

/** A signed, immutable, single-use Peable Tax quote (schema version 2). */
export const billingTaxQuoteSchema = defineComponent(
  'BillingTaxQuote',
  z
    .object({
      schema_version: z.literal(2),
      source: z
        .object({
          merchant_id: billingReference,
          app_id: billingReference,
          store_id: billingReference,
          plan_id: billingReference,
          mode,
          environment,
        })
        .strict(),
      quote: z
        .object({
          id: billingReference,
          currency: z.string().regex(/^[A-Z]{3}$/),
          gross_minor_units: minorUnits,
          net_minor_units: minorUnits,
          tax_minor_units: minorUnits,
          tax_treatment: taxTreatment,
          seller_id: billingReference,
          invoice_issuer_id: billingReference,
          tax_remitter_id: billingReference,
          tax_service_ref: billingReference,
          country: z.string().regex(/^[A-Z]{2}$/),
          coverage_evidence_id: billingReference,
          tax_rate_evidence_id: billingReference,
          customer_location_evidence_id: billingReference,
          quoted_at: billingInstant,
          expires_at: billingInstant,
        })
        .strict(),
      signature: ed25519Signature,
    })
    .strict(),
);
export type BillingTaxQuote = z.output<typeof billingTaxQuoteSchema>;

// ---- Checkout ------------------------------------------------------------------------

export const createBillingCheckoutParams = z
  .object({
    rail: billingRailId
      .optional()
      .describe('An assertion of the rail; it must be the rail of `provider_customer_id`.'),
    provider_customer_id: billingCustomerRef,
    provider_price_id: billingPriceRef,
    trial_days: z.number().int().min(0).max(730),
    tax_quote: billingTaxQuoteSchema
      .optional()
      .describe(
        'Opt-in fiscal checkout: the complete signed quote, immutable and single-use. Peable validates its pinned authority and retains immutable evidence before creating a session.',
      ),
    return_url: billingReturnUrl,
    store_id: billingReference,
    plan_id: billingReference,
  })
  .strict();
export type CreateBillingCheckoutParams = z.input<typeof createBillingCheckoutParams>;

/** A sensitive, owner-only URL. The gateway refuses replay after `expires_at`. */
export const billingHostedSessionSchema = defineComponent(
  'BillingHostedSession',
  z.object({ url: z.string(), expires_at: z.number().int() }).strict(),
);
export type BillingHostedSession = z.output<typeof billingHostedSessionSchema>;

/** An owned recurring checkout. Completing it is not paid evidence. */
export const billingCheckoutSessionSchema = defineComponent(
  'BillingCheckoutSession',
  z.object({ id: z.string(), url: z.string(), expires_at: z.number().int() }).strict(),
);
export type BillingCheckoutSession = z.output<typeof billingCheckoutSessionSchema>;

/** A durable embedded-session reference. Provider secrets are never in it. */
export const billingEmbeddedCheckoutSessionSchema = defineComponent(
  'BillingEmbeddedCheckoutSession',
  z
    .object({
      id: z.string(),
      presentation: z.literal('embedded'),
      expires_at: z.number().int(),
    })
    .strict(),
);
export type BillingEmbeddedCheckoutSession = z.output<typeof billingEmbeddedCheckoutSessionSchema>;

export const billingEmbeddedCheckoutScopeSchema = defineComponent(
  'BillingEmbeddedCheckoutScope',
  z
    .object({
      merchant_id: z.string(),
      app_id: z.string(),
      environment,
      mode,
    })
    .strict(),
);
export type BillingEmbeddedCheckoutScope = z.output<typeof billingEmbeddedCheckoutScopeSchema>;

export const billingEmbeddedCheckoutConfigurationSchema = defineComponent(
  'BillingEmbeddedCheckoutConfiguration',
  z
    .object({
      scope: billingEmbeddedCheckoutScopeSchema,
      publishable_key: z.string(),
      payment_methods: z.array(
        z.object({ id: z.literal('card'), available: z.boolean() }).strict(),
      ),
    })
    .strict(),
);
export type BillingEmbeddedCheckoutConfiguration = z.output<
  typeof billingEmbeddedCheckoutConfigurationSchema
>;

/** An ephemeral processor capability, released only to the authenticated owning workload. */
export const billingEmbeddedCheckoutActionSchema = defineComponent(
  'BillingEmbeddedCheckoutAction',
  z
    .object({
      kind: z.literal('checkout_session'),
      provider: z.literal('stripe'),
      session_id: z.string(),
      client_secret: z.string(),
      publishable_key: z.string(),
      amount_minor_units: z.number().int(),
      currency: z.string(),
    })
    .strict(),
);
export type BillingEmbeddedCheckoutAction = z.output<typeof billingEmbeddedCheckoutActionSchema>;

export const billingEmbeddedCheckoutBindingSchema = defineComponent(
  'BillingEmbeddedCheckoutBinding',
  z
    .object({
      status: z.enum(['open', 'complete', 'expired']),
      action: billingEmbeddedCheckoutActionSchema
        .nullable()
        .describe('`null` once the session is complete or expired.'),
      scope: billingEmbeddedCheckoutScopeSchema
        .extend({
          store_id: z.string(),
          plan_id: z.string(),
          provider_customer_id: z.string(),
          provider_price_id: z.string(),
        })
        .strict(),
      tax_quote: billingTaxQuoteSchema,
      expires_at: z.number().int(),
    })
    .strict(),
);
export type BillingEmbeddedCheckoutBinding = z.output<typeof billingEmbeddedCheckoutBindingSchema>;

// ---- Subscriptions -------------------------------------------------------------------

/** Provider observations only. Consumers own plan, status and entitlement interpretation. */
export const billingSubscriptionSchema = defineComponent(
  'BillingSubscription',
  z
    .object({
      provider_subscription_id: z.string(),
      latest_invoice_id: z
        .string()
        .nullable()
        .optional()
        .describe('Discovery only: the invoice must still be read and proven paid.'),
      provider_customer_id: z.string(),
      provider_price_id: z.string(),
      store_id: z.string(),
      plan_id: z.string(),
      livemode: z.boolean(),
      status: z.enum(BILLING_SUBSCRIPTION_STATUSES),
      interval: billingInterval,
      cancel_at_period_end: z.boolean(),
      current_period_start: z.number().int(),
      current_period_end: z.number().int(),
      trial_ends_at: z.number().int().nullable(),
      cancel_at: z.number().int().nullable(),
      cancelled_at: z.number().int().nullable(),
    })
    .strict(),
);
export type BillingSubscription = z.output<typeof billingSubscriptionSchema>;

export const billingCheckoutObservationSchema = defineComponent(
  'BillingCheckoutObservation',
  z
    .object({
      initial_invoice_id: z
        .string()
        .nullable()
        .describe(
          'The immutable `subscription_create` invoice proven for this exact checkout. Discovery only, never paid authority.',
        ),
      id: z.string(),
      status: z.enum(['open', 'complete', 'expired']),
      store_id: z.string(),
      plan_id: z.string(),
      provider_customer_id: z.string(),
      provider_price_id: z.string(),
      subscription: billingSubscriptionSchema.nullable(),
    })
    .strict(),
);
export type BillingCheckoutObservation = z.output<typeof billingCheckoutObservationSchema>;

// ---- Checkout operation recovery -----------------------------------------------------

/** The query of a recovery read; the `Idempotency-Key` is its path. */
export const retrieveBillingCheckoutOperationQuery = z
  .object({
    provider_customer_id: billingReference,
    provider_price_id: billingReference,
    store_id: billingReference,
    plan_id: billingReference,
  })
  .strict();

/** A recovery read as a caller names it: the key and the operation it keyed. */
export const billingCheckoutOperationParams = retrieveBillingCheckoutOperationQuery
  .extend({ idempotency_key: billingIdempotencyKey })
  .strict();
export type RetrieveBillingCheckoutOperationParams = z.input<typeof billingCheckoutOperationParams>;

const checkoutOperationSource = z
  .object({
    idempotency_key: z.string(),
    provider_customer_id: z.string(),
    provider_price_id: z.string(),
    store_id: z.string(),
    plan_id: z.string(),
    tax_quote_id: z.string().nullable(),
    merchant_id: z.string(),
    app_id: z.string(),
    mode,
    environment,
  })
  .strict();
export const billingCheckoutOperationSourceSchema = defineComponent(
  'BillingCheckoutOperationSource',
  checkoutOperationSource,
);
export type BillingCheckoutOperationSource = z.output<typeof billingCheckoutOperationSourceSchema>;

/**
 * Read-only recovery of one previously attempted recurring checkout. Neither
 * absence nor uncertainty permits cancellation or another financial operation.
 */
export const billingCheckoutOperationRecoverySchema = defineComponent(
  'BillingCheckoutOperationRecovery',
  z.union([
    z
      .object({
        state: z.enum(['not_found', 'pending', 'indeterminate']),
        source: billingCheckoutOperationSourceSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal('succeeded'),
        source: billingCheckoutOperationSourceSchema,
        checkout: z
          .object({ id: z.string(), expires_at: z.number().int(), url: z.string().optional() })
          .strict(),
      })
      .strict(),
  ]),
);
export type BillingCheckoutOperationRecovery = z.output<
  typeof billingCheckoutOperationRecoverySchema
>;

// ---- Portal ----------------------------------------------------------------------------

export const createBillingPortalParams = z
  .object({ provider_customer_id: billingCustomerRef, return_url: billingReturnUrl })
  .strict();
export type CreateBillingPortalParams = z.input<typeof createBillingPortalParams>;

// ---- Invoices ---------------------------------------------------------------------------

/** An authenticated authoritative read: one settled, full, non-prorated line only. */
export const billingPaidInvoiceSchema = defineComponent(
  'BillingPaidInvoice',
  z
    .object({
      invoice_id: z.string(),
      line_id: z.string(),
      payment_intent_id: z.string(),
      provider_subscription_id: z.string(),
      provider_customer_id: z.string(),
      provider_price_id: z.string(),
      store_id: z.string(),
      plan_id: z.string(),
      livemode: z.boolean(),
      currency: z.string(),
      amount_paid: z.string(),
      net_amount: z.string().nullable(),
      tax_amount: z
        .string()
        .nullable()
        .describe('A provider observation, not a tax quote or seller configuration.'),
      period_start: z.number().int(),
      period_end: z.number().int(),
      paid_at: z.number().int(),
      observed_at: z.number().int(),
    })
    .strict(),
);
export type BillingPaidInvoice = z.output<typeof billingPaidInvoiceSchema>;

export const billingInvoiceStateSchema = defineComponent(
  'BillingInvoiceState',
  billingPaidInvoiceSchema
    .extend({
      charge_id: z.string(),
      amount_refunded: z.string(),
      state: z.enum(['paid', 'fully_refunded', 'partially_refunded']),
    })
    .strict(),
);
export type BillingInvoiceState = z.output<typeof billingInvoiceStateSchema>;

/** One frozen Peable Tax line behind a signed invoice's tax amount. */
export const billingInvoiceTaxLineSchema = defineComponent(
  'BillingInvoiceTaxLine',
  z
    .object({
      calculation_id: billingReference,
      country: z.string().regex(/^[A-Z]{2}$/),
      state: z.string().nullable(),
      tax_type: z.string().nullable(),
      rate_percentage: z.string().nullable(),
      taxable_minor_units: minorUnits,
      tax_minor_units: minorUnits,
      inclusive: z.boolean(),
      taxability_reason: z.string().min(1),
    })
    .strict(),
);
export type BillingInvoiceTaxLine = z.output<typeof billingInvoiceTaxLineSchema>;

/**
 * Provider-independent fiscal evidence. Values come from the configured
 * authority, never from invoice amounts, merchant metadata, or an application
 * tax guess.
 */
export const billingInvoiceAuthoritySourceSchema = defineComponent(
  'BillingInvoiceAuthoritySource',
  z
    .object({
      invoice_id: billingReference,
      payment_intent_id: billingReference,
      customer_id: billingReference,
      subscription_id: billingReference,
      price_id: billingReference,
      plan_id: billingReference,
      merchant_id: billingReference,
      app_id: billingReference,
      mode,
      environment,
    })
    .strict(),
);
export type BillingInvoiceAuthoritySource = z.output<typeof billingInvoiceAuthoritySourceSchema>;

export const billingFinalInvoiceSchema = defineComponent(
  'BillingFinalInvoice',
  z
    .object({
      platform: z.literal('peable'),
      currency: z.string().regex(/^[A-Z]{3}$/),
      gross_minor_units: minorUnits,
      net_minor_units: minorUnits,
      tax_minor_units: minorUnits,
      merchant_fee_minor_units: minorUnits,
      tax_treatment: taxTreatment,
      seller_id: billingReference,
      invoice_issuer_id: billingReference,
      tax_quote_id: billingReference,
      customer_location_evidence_id: billingReference,
      tax_rate_evidence_id: billingReference,
      context: z
        .object({
          payer_account_id: billingReference,
          beneficiary_account_id: billingReference,
          provider_subscription_id: billingReference,
          offer_id: billingReference,
          offer_version: z.number().int().positive(),
          period_start: billingInstant,
          period_end: billingInstant,
          mode,
          environment,
        })
        .strict(),
      issued_at: billingInstant,
      expires_at: billingInstant,
      faircoin_quote: z
        .object({
          id: billingReference,
          amount_base_units: z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .max(80),
          quoted_at: billingInstant,
          expires_at: billingInstant,
          rounding_evidence_id: billingReference,
        })
        .strict()
        .optional()
        .describe('On a FairCoin invoice: the FX quote that bounds the payment.'),
      tax_lines: z
        .array(billingInvoiceTaxLineSchema)
        .max(500)
        .optional()
        .describe(
          'Present only when asked for (`include=tax_lines`): the frozen Peable Tax lines behind `tax_minor_units`, covered by the same signature.',
        ),
    })
    .strict(),
);
export type BillingFinalInvoice = z.output<typeof billingFinalInvoiceSchema>;

/** A signed final invoice authority (schema version 2). Verify it against the pinned keys. */
export const billingFinalInvoiceAuthoritySchema = defineComponent(
  'BillingFinalInvoiceAuthority',
  z
    .object({
      schema_version: z.literal(2),
      source: billingInvoiceAuthoritySourceSchema,
      invoice: billingFinalInvoiceSchema,
      method: z.enum(['card', 'faircoin']),
      signature: ed25519Signature,
    })
    .strict(),
);
export type BillingFinalInvoiceAuthority = z.output<typeof billingFinalInvoiceAuthoritySchema>;

export const retrieveBillingInvoiceAuthorityQuery = z.object({
  include: z
    .literal('tax_lines')
    .optional()
    .describe('`tax_lines`: include the frozen Peable Tax lines, inside the signature.'),
});

// ---- FairCoin renewal authority -------------------------------------------------------

const positiveBaseUnits = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(80);

/**
 * An automatic FairCoin renewal authorization: an explicit, bounded
 * instruction. Transporting it creates no mandate and authorizes no custody of
 * payer keys.
 */
export const billingFaircoinRenewalConsentSchema = defineComponent(
  'BillingFaircoinRenewalConsent',
  z
    .object({
      authorization_id: billingReference,
      payer_account_id: billingReference,
      merchant_id: billingReference,
      app_id: billingReference,
      subscription_id: billingReference,
      plan_id: billingReference,
      mode,
      environment,
      explicit_consent: z.literal(true),
      consent_evidence_id: billingReference,
      maximum_amount_base_units: positiveBaseUnits,
      interval: z.literal('month'),
      interval_count: z.literal(1),
      starts_at: billingInstant,
      expires_at: billingInstant,
      accepted_at: billingInstant,
    })
    .strict()
    .refine(
      (value) =>
        value.expires_at > value.starts_at &&
        value.accepted_at <= value.starts_at &&
        (value.mode === 'live') === (value.environment === 'production'),
      'Invalid consent period or environment',
    ),
);
export type BillingFaircoinRenewalConsent = z.output<typeof billingFaircoinRenewalConsentSchema>;

export const billingFaircoinRenewalRevocationSchema = defineComponent(
  'BillingFaircoinRenewalRevocation',
  z
    .object({
      authorization_id: billingReference,
      revoked_at: billingInstant,
      revocation_evidence_id: billingReference,
    })
    .strict(),
);
export type BillingFaircoinRenewalRevocation = z.output<
  typeof billingFaircoinRenewalRevocationSchema
>;

export const billingFaircoinRenewalChoiceSchema = defineComponent(
  'BillingFaircoinRenewalChoice',
  z.union([
    z.object({ method: z.literal('faircoin'), renewal: z.literal('manual_monthly') }).strict(),
    z
      .object({
        method: z.literal('faircoin'),
        renewal: z.literal('automatic'),
        consent: billingFaircoinRenewalConsentSchema,
      })
      .strict(),
  ]),
);
export type BillingFaircoinRenewalChoice = z.output<typeof billingFaircoinRenewalChoiceSchema>;

/** A FAIR/USD quote: the FAIR a USD amount costs, ceiled to a base unit, for a bounded time. */
export const billingFaircoinFxQuoteSchema = defineComponent(
  'BillingFaircoinFxQuote',
  z
    .object({
      id: z.string(),
      currency: z.literal('USD'),
      gross_minor_units: z.number().int(),
      amount_base_units: z.string(),
      usd_per_fair: z.string(),
      source: z.string(),
      observed_at: z.number().int(),
      quoted_at: z.number().int(),
      expires_at: z.number().int(),
      rounding: z.literal('ceil_to_base_unit'),
    })
    .strict(),
);
export type BillingFaircoinFxQuote = z.output<typeof billingFaircoinFxQuoteSchema>;

// ---- Routes ----------------------------------------------------------------------------

/** The body of `cancel_at_period_end`: nothing. */
export const cancelBillingSubscriptionParams = z.object({}).strict();

const requiresKey =
  'Requires an `Idempotency-Key` header: it is the operation’s identity at the provider.';
const subscription = { id: 'The provider subscription (`provider_subscription_id`).' };
const invoice = {
  ...subscription,
  invoiceId: 'The invoice of that subscription.',
};

export const billingRoutes = [
  defineRoute({
    operationId: 'listBillingRails',
    method: 'get',
    path: '/v1/billing/rails',
    tag: 'Recurring billing',
    summary: 'List the settlement rails',
    description:
      "The rails this merchant's payers can choose between (card and other fiat providers, FairCoin), default first, with each rail's offers. Pass the payer's choice as `rail` to `ensureCustomer`.",
    auth: 'service',
    scope: 'payments:read',
    response: billingRailListSchema,
    sdk: 'billing.listRails',
  }),
  defineRoute({
    operationId: 'createBillingTaxQuote',
    method: 'post',
    path: '/v1/billing/tax_quotes',
    tag: 'Recurring billing',
    summary: 'Quote the tax of a plan',
    description:
      'A signed Peable Tax quote for one plan and one customer location. Verify its signature against the pinned keys before passing it to a checkout.',
    auth: 'service',
    scope: 'payments:read',
    body: createBillingTaxQuoteParams,
    response: billingTaxQuoteSchema,
    sdk: 'billing.createTaxQuote',
  }),
  defineRoute({
    operationId: 'ensureBillingCustomer',
    method: 'post',
    path: '/v1/billing/customers',
    tag: 'Recurring billing',
    summary: 'Ensure the billing customer of a store',
    description: `The same store always answers the same customer. ${requiresKey}`,
    auth: 'service',
    scope: 'payments:write',
    body: ensureBillingCustomerParams,
    response: billingCustomerSchema,
    sdk: 'billing.ensureCustomer',
  }),
  defineRoute({
    operationId: 'createBillingCheckoutSession',
    method: 'post',
    path: '/v1/billing/checkout_sessions',
    tag: 'Recurring billing',
    summary: 'Create a subscription checkout',
    description: `A hosted checkout for one plan. Completing it is not paid evidence: read the subscription and its paid invoice. ${requiresKey}`,
    auth: 'service',
    scope: 'payments:write',
    body: createBillingCheckoutParams,
    response: billingCheckoutSessionSchema,
    sdk: 'billing.createCheckoutSession',
  }),
  defineRoute({
    operationId: 'retrieveBillingEmbeddedCheckoutConfiguration',
    method: 'get',
    path: '/v1/billing/embedded_checkout_configuration',
    tag: 'Recurring billing',
    summary: 'Retrieve the embedded checkout configuration',
    auth: 'service',
    scope: 'payments:read',
    response: billingEmbeddedCheckoutConfigurationSchema,
    sdk: 'billing.embeddedCheckoutConfiguration',
  }),
  defineRoute({
    operationId: 'createBillingEmbeddedCheckoutSession',
    method: 'post',
    path: '/v1/billing/embedded_checkout_sessions',
    tag: 'Recurring billing',
    summary: 'Create an embedded subscription checkout',
    description: `Fiscal checkout only: \`tax_quote\` is required. ${requiresKey}`,
    auth: 'service',
    scope: 'payments:write',
    body: createBillingCheckoutParams,
    response: billingEmbeddedCheckoutSessionSchema,
    sdk: 'billing.createEmbeddedCheckoutSession',
  }),
  defineRoute({
    operationId: 'retrieveBillingEmbeddedCheckoutAction',
    method: 'get',
    path: '/v1/billing/embedded_checkout_sessions/{id}/client_action',
    tag: 'Recurring billing',
    summary: 'Retrieve an embedded checkout’s client action',
    description:
      'The ephemeral processor capability to mount the embedded checkout, released only to the owning workload; `action` is `null` once the session is complete or expired.',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The embedded checkout session (`cs_…`).' },
    response: billingEmbeddedCheckoutBindingSchema,
    sdk: 'billing.retrieveEmbeddedCheckoutAction',
  }),
  defineRoute({
    operationId: 'createRecurringBillingPortalSession',
    method: 'post',
    path: '/v1/billing/portal_sessions',
    tag: 'Recurring billing',
    summary: "Open the provider's billing portal",
    description: `A short-lived, owner-only URL. ${requiresKey}`,
    auth: 'service',
    scope: 'payments:write',
    body: createBillingPortalParams,
    response: billingHostedSessionSchema,
    sdk: 'billing.createPortalSession',
  }),
  defineRoute({
    operationId: 'retrieveBillingCheckoutOperation',
    method: 'get',
    path: '/v1/billing/checkout_operations/{key}',
    tag: 'Recurring billing',
    summary: 'Recover a checkout operation',
    description:
      'Reads the state of a checkout attempted under this `Idempotency-Key`, even after its quote or session expired. Missing, pending or indeterminate never authorizes another create or a cancellation.',
    auth: 'service',
    scope: 'payments:read',
    params: { key: 'The `Idempotency-Key` the checkout was created with.' },
    query: retrieveBillingCheckoutOperationQuery,
    response: billingCheckoutOperationRecoverySchema,
    sdk: 'billing.retrieveCheckoutOperation',
  }),
  defineRoute({
    operationId: 'retrieveBillingCheckoutSession',
    method: 'get',
    path: '/v1/billing/checkout_sessions/{id}',
    tag: 'Recurring billing',
    summary: 'Retrieve a subscription checkout',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The checkout session (`cs_…`).' },
    response: billingCheckoutObservationSchema,
    sdk: 'billing.retrieveCheckout',
  }),
  defineRoute({
    operationId: 'retrieveBillingInvoiceAuthority',
    method: 'get',
    path: '/v1/billing/subscriptions/{id}/invoice_authorities/{invoiceId}',
    tag: 'Recurring billing',
    summary: 'Retrieve the signed final invoice authority',
    description:
      'Signed fiscal evidence of one paid invoice. Verify the signature against the pinned keys (`PEABLE_BILLING_AUTHORITY_KEYS`).',
    auth: 'service',
    scope: 'payments:read',
    params: invoice,
    query: retrieveBillingInvoiceAuthorityQuery,
    response: billingFinalInvoiceAuthoritySchema,
    sdk: 'billing.retrieveFinalInvoiceAuthority',
  }),
  defineRoute({
    operationId: 'retrieveBillingInvoiceState',
    method: 'get',
    path: '/v1/billing/subscriptions/{id}/invoice_states/{invoiceId}',
    tag: 'Recurring billing',
    summary: 'Retrieve the refund state of a paid invoice',
    auth: 'service',
    scope: 'payments:read',
    params: invoice,
    response: billingInvoiceStateSchema,
    sdk: 'billing.retrieveInvoiceState',
  }),
  defineRoute({
    operationId: 'retrieveBillingPaidInvoice',
    method: 'get',
    path: '/v1/billing/subscriptions/{id}/paid_invoices/{invoiceId}',
    tag: 'Recurring billing',
    summary: 'Retrieve a paid invoice',
    description: 'Paid-period evidence: answers only for a settled, full, non-prorated invoice.',
    auth: 'service',
    scope: 'payments:read',
    params: invoice,
    response: billingPaidInvoiceSchema,
    sdk: 'billing.retrievePaidInvoice',
  }),
  defineRoute({
    operationId: 'retrieveBillingSubscription',
    method: 'get',
    path: '/v1/billing/subscriptions/{id}',
    tag: 'Recurring billing',
    summary: 'Retrieve a subscription',
    auth: 'service',
    scope: 'payments:read',
    params: subscription,
    response: billingSubscriptionSchema,
    sdk: 'billing.retrieveSubscription',
  }),
  defineRoute({
    operationId: 'renewBillingSubscription',
    method: 'post',
    path: '/v1/billing/subscriptions/{id}/renew',
    tag: 'Recurring billing',
    summary: 'Renew a payer-initiated subscription',
    description: `Opens a new expiring FAIR payment for one monthly period. Never auto-debits. ${requiresKey}`,
    auth: 'service',
    scope: 'payments:write',
    params: subscription,
    body: createBillingCheckoutParams,
    response: billingCheckoutSessionSchema,
    sdk: 'billing.renewSubscription',
  }),
  defineRoute({
    operationId: 'cancelBillingSubscriptionAtPeriodEnd',
    method: 'post',
    path: '/v1/billing/subscriptions/{id}/cancel_at_period_end',
    tag: 'Recurring billing',
    summary: 'Cancel a subscription at period end',
    description: `Access continues to the end of the paid period. ${requiresKey}`,
    auth: 'service',
    scope: 'payments:write',
    params: subscription,
    body: cancelBillingSubscriptionParams,
    response: billingSubscriptionSchema,
    sdk: 'billing.cancelAtPeriodEnd',
  }),
] as const;
