import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import {
  billingCheckoutSessionSchema as wireCheckoutSession,
  billingCustomerRef,
  billingCustomerSchema as wireCustomer,
  billingEmbeddedCheckoutSessionSchema as wireEmbeddedCheckoutSession,
  billingHostedSessionSchema as wireHostedSession,
  billingInstant,
  billingPriceRef,
  billingReference,
  billingReturnUrl,
  billingSubscriptionSchema as wireSubscription,
} from '@peable.to/contracts';

/**
 * The recurring billing transport's INTERNAL validators. The wire — every
 * request schema and the object each route answers — is the contract's
 * (`@peable.to/contracts`, `billingRoutes`). What is here is stricter: a
 * provider's answer (or a stored result being replayed) must carry the
 * provider's id spellings before it is trusted or answered.
 */

/** An instant on the wire: integer Unix seconds (ADR 0014 D1). */
export const unixSeconds = billingInstant;

/**
 * A provider's integer amount (Stripe's SDK counts in JS numbers), as the
 * base-unit string the wire carries. Anything that is not an exact
 * non-negative integer is refused, never rounded.
 */
export const providerAmount = z.number().int().nonnegative().safe().transform(String);

/** A provider amount that must be exactly `expected`, compared as base-unit strings. */
export const providerAmountOf = (expected: string) => providerAmount.pipe(z.literal(expected));

const subscriptionRef = z
  .string()
  .regex(/^sub_[A-Za-z0-9]+$/)
  .max(128);
const checkoutRef = z
  .string()
  .regex(/^cs_(test|live)_[A-Za-z0-9]+$/)
  .max(128);
export const billingCustomerSchema = wireCustomer
  .extend({ provider_customer_id: billingCustomerRef })
  .strict();
export const billingHostedSessionSchema = wireHostedSession
  .extend({ url: billingReturnUrl, expires_at: unixSeconds })
  .strict();
export const billingCheckoutSessionSchema = wireCheckoutSession
  .extend({ id: checkoutRef, url: billingReturnUrl, expires_at: unixSeconds })
  .strict();
export const billingEmbeddedCheckoutSessionSchema = wireEmbeddedCheckoutSession
  .extend({ id: checkoutRef, expires_at: unixSeconds })
  .strict();
export const billingAnyCheckoutSessionSchema = z.union([
  billingCheckoutSessionSchema,
  billingEmbeddedCheckoutSessionSchema,
]);
export const billingSubscriptionSchema = wireSubscription
  .extend({
    provider_subscription_id: subscriptionRef,
    latest_invoice_id: z
      .string()
      .regex(/^in_[A-Za-z0-9]+$/)
      .nullable()
      .optional(),
    provider_customer_id: billingCustomerRef,
    provider_price_id: billingPriceRef,
    store_id: billingReference,
    plan_id: billingReference,
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
