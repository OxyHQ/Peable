import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import { BILLING_SUBSCRIPTION_STATUSES } from '@peable.to/shared-types';

export const billingReference = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const billingIdempotencyKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const customerRef = z.string().regex(/^cus_[A-Za-z0-9]+$/).max(128);
const priceRef = z.string().regex(/^price_[A-Za-z0-9]+$/).max(128);
const subscriptionRef = z.string().regex(/^sub_[A-Za-z0-9]+$/).max(128);
/** HTTPS destinations only; the authenticated app supplies its own return page. */
export const billingReturnUrl = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'An HTTPS return URL without credentials is required');
export const ensureCustomerSchema = z.object({ storeId: billingReference, storeName: z.string().min(1).max(200) }).strict();
export const checkoutSchema = z.object({ providerCustomerId: customerRef, providerPriceId: priceRef,
  trialDays: z.number().int().min(0).max(730), returnUrl: billingReturnUrl,
  storeId: billingReference, planId: billingReference }).strict();
export const portalSchema = z.object({ providerCustomerId: customerRef, returnUrl: billingReturnUrl }).strict();
export const billingCustomerSchema = z.object({ providerCustomerId: customerRef }).strict();
export const billingHostedSessionSchema = z.object({ url: billingReturnUrl, expiresAt: z.string().datetime() }).strict();
export const billingCheckoutSessionSchema=billingHostedSessionSchema.extend({id:z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/).max(128)}).strict();
export const billingSubscriptionSchema = z.object({
  providerSubscriptionId: subscriptionRef, latestInvoiceId:z.string().regex(/^in_[A-Za-z0-9]+$/).nullable().optional(), providerCustomerId: customerRef, providerPriceId: priceRef,
  storeId: billingReference, planId: billingReference, livemode: z.boolean(),
  status: z.enum(BILLING_SUBSCRIPTION_STATUSES), interval: z.enum(['month', 'year']), cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.string().datetime(), currentPeriodEnd: z.string().datetime(),
  trialEndsAt: z.string().datetime().nullable(), cancelAt: z.string().datetime().nullable(), cancelledAt: z.string().datetime().nullable(),
}).strict().refine((value) => Date.parse(value.currentPeriodEnd) > Date.parse(value.currentPeriodStart), 'Invalid subscription period');

/** Internal deployment configuration, never read from a request or provider metadata. */
export const billingDeploymentSchema = z.object({ provider: z.literal('stripe'),
  platformAccountId: z.string().regex(/^acct_[A-Za-z0-9]+$/).max(128), livemode: z.boolean() }).strict();
export type BillingDeployment = z.infer<typeof billingDeploymentSchema>;
export const billingOwnerSchema = z.object({ merchantId: billingReference, oxyAppId: billingReference,
  environment: z.enum(OXY_SERVICE_ENVIRONMENTS) }).strict();
export type BillingOwner = z.infer<typeof billingOwnerSchema>;
export const BILLING_BINDING_KINDS = ['customer', 'price', 'subscription'] as const;
export const BILLING_OPERATIONS = ['ensure_customer', 'checkout', 'portal', 'cancel_at_period_end'] as const;
export const BILLING_OPERATION_STATES = ['pending', 'succeeded', 'indeterminate'] as const;
export type BillingOperationKind = (typeof BILLING_OPERATIONS)[number];
export type BillingOperationResult = z.infer<typeof billingCustomerSchema> | z.infer<typeof billingHostedSessionSchema> | z.infer<typeof billingSubscriptionSchema>;
export function parseBillingResult(operation: BillingOperationKind, result: unknown): BillingOperationResult {
  if (operation === 'checkout') return billingHostedSessionSchema.extend({id:z.string().optional()}).strict().parse(result);
  if (operation === 'ensure_customer') return billingCustomerSchema.parse(result);
  if (operation === 'cancel_at_period_end') return billingSubscriptionSchema.parse(result);
  return billingHostedSessionSchema.parse(result);
}
export class BillingError extends Error {
  constructor(readonly code: 'not_found' | 'identity_conflict' | 'idempotency_conflict' | 'in_progress' | 'reconciliation_required' | 'result_expired' | 'provider_unavailable' | 'invalid_provider_response', readonly status = 409) {
    super(code); this.name = 'BillingError';
  }
}
