/** Recurring billing transport. Store/plan references belong to the authenticated app;
 * they do not identify an Oxy payer or convey entitlements. */
export const BILLING_SUBSCRIPTION_STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'] as const;
export type BillingSubscriptionStatus = (typeof BILLING_SUBSCRIPTION_STATUSES)[number];
export interface BillingCustomer { providerCustomerId: string; }
export interface EnsureBillingCustomerParams { storeId: string; storeName: string; }
export interface CreateBillingCheckoutParams {
  providerCustomerId: string;
  providerPriceId: string;
  trialDays: number;
  returnUrl: string;
  storeId: string;
  planId: string;
}
export interface CreateBillingPortalParams { providerCustomerId: string; returnUrl: string; }
/** Sensitive owner-only URL. The gateway refuses replay after expiresAt. */
export interface BillingHostedSession { url: string; expiresAt: string; }
/** Provider observations only. Consumers own plan/status/entitlement interpretation. */
export interface BillingSubscription {
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerPriceId: string;
  storeId: string;
  planId: string;
  livemode: boolean;
  status: BillingSubscriptionStatus;
  interval: 'month' | 'year';
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  cancelAt: string | null;
  cancelledAt: string | null;
}
