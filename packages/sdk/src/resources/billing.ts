import type { BillingCustomer, BillingHostedSession, BillingSubscription, CreateBillingCheckoutParams, CreateBillingPortalParams, EnsureBillingCustomerParams } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
export interface BillingRequestOptions { idempotencyKey: string; }
/** Recurring billing is separate from one-off checkout and marketplace transfers. */
export class BillingResource {
  constructor(private readonly client: RestClient) {}
  ensureCustomer(params: EnsureBillingCustomerParams, options: BillingRequestOptions): Promise<BillingCustomer> {
    return this.client.request('POST', '/v1/billing/customers', { body: params, idempotencyKey: options.idempotencyKey });
  }
  createCheckoutSession(params: CreateBillingCheckoutParams, options: BillingRequestOptions): Promise<BillingHostedSession> {
    return this.client.request('POST', '/v1/billing/checkout_sessions', { body: params, idempotencyKey: options.idempotencyKey });
  }
  createPortalSession(params: CreateBillingPortalParams, options: BillingRequestOptions): Promise<BillingHostedSession> {
    return this.client.request('POST', '/v1/billing/portal_sessions', { body: params, idempotencyKey: options.idempotencyKey });
  }
  retrieveSubscription(ref: string): Promise<BillingSubscription> {
    return this.client.request('GET', `/v1/billing/subscriptions/${encodeURIComponent(ref)}`);
  }
  cancelAtPeriodEnd(ref: string, options: BillingRequestOptions): Promise<BillingSubscription> {
    return this.client.request('POST', `/v1/billing/subscriptions/${encodeURIComponent(ref)}/cancel_at_period_end`, { body: {}, idempotencyKey: options.idempotencyKey });
  }
}
