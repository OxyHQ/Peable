import { createPublicKey, verify } from 'node:crypto';
import { canonicalBillingAuthority } from '@peable.to/shared-types';
import type { BillingFinalInvoiceAuthority, BillingCustomer, BillingHostedSession, BillingCheckoutSession, BillingCheckoutObservation, BillingPaidInvoice, BillingInvoiceState, BillingSubscription, CreateBillingCheckoutParams, CreateBillingPortalParams, EnsureBillingCustomerParams } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
export interface BillingRequestOptions { idempotencyKey: string; }
/** Recurring billing is separate from one-off checkout and marketplace transfers. */
export class BillingResource {
  constructor(private readonly client: RestClient, private readonly invoiceAuthorityKeys?: Readonly<Record<string, string>>) {}
  ensureCustomer(params: EnsureBillingCustomerParams, options: BillingRequestOptions): Promise<BillingCustomer> {
    return this.client.request('POST', '/v1/billing/customers', { body: params, idempotencyKey: options.idempotencyKey });
  }
  createCheckoutSession(params: CreateBillingCheckoutParams, options: BillingRequestOptions): Promise<BillingCheckoutSession> {
    return this.client.request('POST', '/v1/billing/checkout_sessions', { body: params, idempotencyKey: options.idempotencyKey });
  }
  createPortalSession(params: CreateBillingPortalParams, options: BillingRequestOptions): Promise<BillingHostedSession> {
    return this.client.request('POST', '/v1/billing/portal_sessions', { body: params, idempotencyKey: options.idempotencyKey });
  }
  retrieveCheckout(ref:string):Promise<BillingCheckoutObservation>{return this.client.request('GET',`/v1/billing/checkout_sessions/${encodeURIComponent(ref)}`);}
  async retrieveFinalInvoiceAuthority(subscriptionRef: string, invoiceRef: string): Promise<BillingFinalInvoiceAuthority> {
    if (!this.invoiceAuthorityKeys || Object.keys(this.invoiceAuthorityKeys).length === 0) throw new Error('Peable: invoice authority verification is unconfigured');
    const authority = await this.client.request<BillingFinalInvoiceAuthority>('GET', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/invoice_authorities/${encodeURIComponent(invoiceRef)}`);
    try {
      const pinnedKey = this.invoiceAuthorityKeys[authority.signature.keyId];
      if (authority.schemaVersion !== 1 || !pinnedKey || authority.signature.algorithm !== 'Ed25519' || !/^[A-Za-z0-9_-]{86}$/.test(authority.signature.value)
        || authority.source.invoiceId !== invoiceRef || authority.source.subscriptionId !== subscriptionRef
        || authority.invoice.context.providerSubscriptionId !== subscriptionRef
        || !['card', 'faircoin'].includes(authority.method)
        || !Number.isFinite(Date.parse(authority.invoice.issuedAt)) || Date.parse(authority.invoice.issuedAt) > Date.now()
        || !Number.isFinite(Date.parse(authority.invoice.expiresAt)) || Date.parse(authority.invoice.expiresAt) <= Date.now()) throw new Error('Invalid authority');
      if (authority.method === 'faircoin') {
        const quote = authority.invoice.faircoinQuote;
        if (!quote || !/^[1-9][0-9]*$/.test(quote.amountBaseUnits) || !Number.isFinite(Date.parse(quote.quotedAt))
          || Date.parse(quote.quotedAt) > Date.now() || !Number.isFinite(Date.parse(quote.expiresAt))
          || Date.parse(quote.expiresAt) <= Date.now() || Date.parse(quote.expiresAt) > Date.parse(authority.invoice.expiresAt)) throw new Error('Invalid quote');
      }
      const key = createPublicKey(pinnedKey);
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalBillingAuthority(authority), 'utf8'), key, Buffer.from(authority.signature.value, 'base64url'))) throw new Error('Invalid signature');
    } catch { throw new Error('Peable: invoice authority verification failed'); }
    return authority;
  }
  retrievePaidInvoice(subscriptionRef:string,invoiceRef:string):Promise<BillingPaidInvoice>{return this.client.request('GET',`/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/paid_invoices/${encodeURIComponent(invoiceRef)}`);}
  retrieveInvoiceState(subscriptionRef:string,invoiceRef:string):Promise<BillingInvoiceState>{return this.client.request('GET',`/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/invoice_states/${encodeURIComponent(invoiceRef)}`);}
  retrieveSubscription(ref: string): Promise<BillingSubscription> {
    return this.client.request('GET', `/v1/billing/subscriptions/${encodeURIComponent(ref)}`);
  }
  cancelAtPeriodEnd(ref: string, options: BillingRequestOptions): Promise<BillingSubscription> {
    return this.client.request('POST', `/v1/billing/subscriptions/${encodeURIComponent(ref)}/cancel_at_period_end`, { body: {}, idempotencyKey: options.idempotencyKey });
  }
}
