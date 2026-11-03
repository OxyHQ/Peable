import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import { BILLING_SUBSCRIPTION_STATUSES } from '@peable.to/shared-types';

export const billingReference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const billingIdempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const customerRef = z
  .string()
  .regex(/^cus_[A-Za-z0-9]+$/)
  .max(128);
const priceRef = z
  .string()
  .regex(/^price_[A-Za-z0-9]+$/)
  .max(128);
const subscriptionRef = z
  .string()
  .regex(/^sub_[A-Za-z0-9]+$/)
  .max(128);
/** A configured settlement rail's name (`stripe`, `faircoin`, a further fiat
 * provider). Selecting one never configures it: an unconfigured rail is refused. */
export const billingRailId = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
/** HTTPS destinations only; the authenticated app supplies its own return page. */
export const billingReturnUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'An HTTPS return URL without credentials is required');
/** An instant on the wire: integer Unix seconds (ADR 0014 D1). */
export const unixSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ensureCustomerSchema = z
  .object({
    store_id: billingReference,
    store_name: z.string().min(1).max(200),
    rail: billingRailId.optional(),
  })
  .strict();
export const billingTaxQuoteSchema = z
  .object({
    schema_version: z.literal(2),
    source: z
      .object({
        merchant_id: billingReference,
        app_id: billingReference,
        store_id: billingReference,
        plan_id: billingReference,
        mode: z.enum(['test', 'live']),
        environment: z.enum(['development', 'staging', 'production']),
      })
      .strict(),
    quote: z
      .object({
        id: billingReference,
        currency: z.string().regex(/^[A-Z]{3}$/),
        gross_minor_units: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        net_minor_units: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        tax_minor_units: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        tax_treatment: z.enum(['inclusive', 'exclusive']),
        seller_id: billingReference,
        invoice_issuer_id: billingReference,
        tax_remitter_id: billingReference,
        tax_service_ref: billingReference,
        country: z.string().regex(/^[A-Z]{2}$/),
        coverage_evidence_id: billingReference,
        tax_rate_evidence_id: billingReference,
        customer_location_evidence_id: billingReference,
        quoted_at: unixSeconds,
        expires_at: unixSeconds,
      })
      .strict(),
    signature: z
      .object({
        algorithm: z.literal('Ed25519'),
        key_id: billingReference,
        value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      })
      .strict(),
  })
  .strict();
export const checkoutSchema = z
  .object({
    rail: billingRailId.optional(),
    provider_customer_id: customerRef,
    provider_price_id: priceRef,
    trial_days: z.number().int().min(0).max(730),
    tax_quote: billingTaxQuoteSchema.optional(),
    return_url: billingReturnUrl,
    store_id: billingReference,
    plan_id: billingReference,
  })
  .strict();
export const portalSchema = z
  .object({ provider_customer_id: customerRef, return_url: billingReturnUrl })
  .strict();
export const billingCustomerSchema = z.object({ provider_customer_id: customerRef }).strict();
export const billingHostedSessionSchema = z
  .object({ url: billingReturnUrl, expires_at: unixSeconds })
  .strict();
export const billingCheckoutSessionSchema = billingHostedSessionSchema
  .extend({
    id: z
      .string()
      .regex(/^cs_(test|live)_[A-Za-z0-9]+$/)
      .max(128),
  })
  .strict();
export const billingEmbeddedCheckoutSessionSchema = z
  .object({
    id: z
      .string()
      .regex(/^cs_(test|live)_[A-Za-z0-9]+$/)
      .max(128),
    presentation: z.literal('embedded'),
    expires_at: unixSeconds,
  })
  .strict();
export const billingAnyCheckoutSessionSchema = z.union([
  billingCheckoutSessionSchema,
  billingEmbeddedCheckoutSessionSchema,
]);
export const billingSubscriptionSchema = z
  .object({
    provider_subscription_id: subscriptionRef,
    latest_invoice_id: z
      .string()
      .regex(/^in_[A-Za-z0-9]+$/)
      .nullable()
      .optional(),
    provider_customer_id: customerRef,
    provider_price_id: priceRef,
    store_id: billingReference,
    plan_id: billingReference,
    livemode: z.boolean(),
    status: z.enum(BILLING_SUBSCRIPTION_STATUSES),
    interval: z.enum(['month', 'year']),
    cancel_at_period_end: z.boolean(),
    current_period_start: unixSeconds,
    current_period_end: unixSeconds,
    trial_ends_at: unixSeconds.nullable(),
    cancel_at: unixSeconds.nullable(),
    cancelled_at: unixSeconds.nullable(),
  })
  .strict()
  .refine(
    (value) => value.current_period_end > value.current_period_start,
    'Invalid subscription period',
  );

/** Internal deployment configuration, never read from a request or provider metadata. */
export const billingDeploymentSchema = z
  .object({
    provider: z.literal('stripe'),
    platformAccountId: z
      .string()
      .regex(/^acct_[A-Za-z0-9]+$/)
      .max(128),
    livemode: z.boolean(),
  })
  .strict();
export type BillingDeployment = z.infer<typeof billingDeploymentSchema>;
export const billingOwnerSchema = z
  .object({
    merchantId: billingReference,
    oxyAppId: billingReference,
    environment: z.enum(OXY_SERVICE_ENVIRONMENTS),
  })
  .strict();
export type BillingOwner = z.infer<typeof billingOwnerSchema>;
export const BILLING_BINDING_KINDS = ['customer', 'price', 'subscription'] as const;
export const BILLING_OPERATIONS = [
  'ensure_customer',
  'checkout',
  'portal',
  'cancel_at_period_end',
] as const;
export const BILLING_OPERATION_STATES = ['pending', 'succeeded', 'indeterminate'] as const;
export type BillingOperationKind = (typeof BILLING_OPERATIONS)[number];
export type BillingOperationResult =
  | z.infer<typeof billingCustomerSchema>
  | z.infer<typeof billingHostedSessionSchema>
  | z.infer<typeof billingEmbeddedCheckoutSessionSchema>
  | z.infer<typeof billingSubscriptionSchema>;
export function parseBillingResult(
  operation: BillingOperationKind,
  result: unknown,
): BillingOperationResult {
  if (operation === 'checkout')
    return z
      .union([
        billingHostedSessionSchema.extend({ id: z.string().optional() }).strict(),
        billingEmbeddedCheckoutSessionSchema,
      ])
      .parse(result);
  if (operation === 'ensure_customer') return billingCustomerSchema.parse(result);
  if (operation === 'cancel_at_period_end') return billingSubscriptionSchema.parse(result);
  return billingHostedSessionSchema.parse(result);
}
export type BillingErrorCode =
  | 'not_found'
  | 'rail_unavailable'
  | 'identity_conflict'
  | 'idempotency_conflict'
  | 'in_progress'
  | 'reconciliation_required'
  | 'result_expired'
  | 'provider_unavailable'
  | 'invalid_provider_response';
/** The human `message` beside each machine `code` on the wire. Deliberately
 * generic: no provider text, identifier or URL reaches a caller. */
export const BILLING_ERROR_MESSAGES: Readonly<Record<BillingErrorCode, string>> = {
  not_found: 'No such billing object for this merchant.',
  rail_unavailable: 'That billing rail is not available for this merchant.',
  identity_conflict: 'The request does not match the billing objects it names.',
  idempotency_conflict: 'This Idempotency-Key was already used for a different request.',
  in_progress: 'A request with this Idempotency-Key is still in progress.',
  reconciliation_required: 'The billing state must be reconciled before this can proceed.',
  result_expired: 'The result of this operation has expired.',
  provider_unavailable: 'The billing provider is unavailable. Try again later.',
  invalid_provider_response: 'The billing provider answered something Peable cannot accept.',
};
export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    readonly status = 409,
  ) {
    // Internally the message is the code; the wire pairs the code with
    // `BILLING_ERROR_MESSAGES` (routes/billing.ts).
    super(code);
    this.name = 'BillingError';
  }
}

export const checkoutOperationRequestSchema = z
  .object({
    idempotency_key: billingIdempotencyKey,
    provider_customer_id: billingReference,
    provider_price_id: billingReference,
    store_id: billingReference,
    plan_id: billingReference,
  })
  .strict();
