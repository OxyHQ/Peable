import { createPublicKey, verify } from 'node:crypto';
import { canonicalBillingAuthority, canonicalBillingTaxQuote } from '@peable.to/shared-types';
import type {
  BillingTaxQuote,
  RetrieveBillingCheckoutOperationParams,
  BillingCheckoutOperationRecovery,
  CreateBillingTaxQuoteParams,
  BillingFinalInvoiceAuthority,
  BillingCustomer,
  BillingRailList,
  BillingHostedSession,
  BillingCheckoutSession,
  BillingCheckoutObservation,
  BillingPaidInvoice,
  BillingInvoiceState,
  BillingSubscription,
  CreateBillingCheckoutParams,
  CreateBillingPortalParams,
  EnsureBillingCustomerParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
export interface BillingRequestOptions {
  idempotencyKey: string;
}
export interface RetrieveFinalInvoiceAuthorityOptions {
  /** `tax_lines`: include the frozen Peable Tax lines, covered by the signature
   * (FairCoin and other Peable-signed rails). Omitted: the authority is exactly
   * the 0.3.x shape. */
  include?: readonly 'tax_lines'[];
}
/** Recurring billing is separate from one-off checkout and marketplace transfers. */
export class BillingResource {
  constructor(
    private readonly client: RestClient,
    private readonly invoiceAuthorityKeys?: Readonly<Record<string, string>>,
    private readonly taxQuoteAuthorityKeys?: Readonly<Record<string, string>>,
  ) {}
  /** The rails this merchant's payers can choose between (card and other fiat
   * providers, FairCoin), default first, with each rail's offers. Pass the
   * payer's choice as `rail` to `ensureCustomer`; the customer's rail then
   * carries its checkouts, subscriptions and invoices. */
  listRails(): Promise<BillingRailList> {
    return this.client.request('GET', '/v1/billing/rails');
  }
  ensureCustomer(
    params: EnsureBillingCustomerParams,
    options: BillingRequestOptions,
  ): Promise<BillingCustomer> {
    return this.client.request('POST', '/v1/billing/customers', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }
  /** Pass the complete signed taxQuote to opt into fiscal checkout. Peable validates
   * its pinned authority and retains immutable evidence before creating a session.
   * Existing callers without a quote remain on their explicitly enabled legacy path. */
  createCheckoutSession(
    params: CreateBillingCheckoutParams,
    options: BillingRequestOptions,
  ): Promise<BillingCheckoutSession> {
    return this.client.request('POST', '/v1/billing/checkout_sessions', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }
  /** Opens a new expiring FAIR payment for one monthly period. Never auto-debits. */
  renewSubscription(
    ref: string,
    params: CreateBillingCheckoutParams,
    options: BillingRequestOptions,
  ): Promise<BillingCheckoutSession> {
    return this.client.request(
      'POST',
      `/v1/billing/subscriptions/${encodeURIComponent(ref)}/renew`,
      {
        body: params,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }
  createPortalSession(
    params: CreateBillingPortalParams,
    options: BillingRequestOptions,
  ): Promise<BillingHostedSession> {
    return this.client.request('POST', '/v1/billing/portal_sessions', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }
  retrieveCheckout(ref: string): Promise<BillingCheckoutObservation> {
    return this.client.request('GET', `/v1/billing/checkout_sessions/${encodeURIComponent(ref)}`);
  }
  /** Reads existing operation state only, even after quote/session expiry.
   * Missing/pending/indeterminate never authorizes another create or cancellation. */
  retrieveCheckoutOperation(
    params: RetrieveBillingCheckoutOperationParams,
  ): Promise<BillingCheckoutOperationRecovery> {
    const { idempotency_key: idempotencyKey, ...query } = params;
    return this.client.request(
      'GET',
      `/v1/billing/checkout_operations/${encodeURIComponent(idempotencyKey)}`,
      { query },
    );
  }
  async createTaxQuote(params: CreateBillingTaxQuoteParams): Promise<BillingTaxQuote> {
    if (!this.taxQuoteAuthorityKeys || Object.keys(this.taxQuoteAuthorityKeys).length === 0)
      throw new Error('Peable: tax quote authority verification is unconfigured');
    const result = await this.client.request<BillingTaxQuote>('POST', '/v1/billing/tax_quotes', {
      body: params,
    });
    try {
      const pinned = this.taxQuoteAuthorityKeys[result.signature.key_id];
      if (
        !pinned ||
        result.schema_version !== 1 ||
        result.signature.algorithm !== 'Ed25519' ||
        !/^[A-Za-z0-9_-]{86}$/.test(result.signature.value) ||
        result.source.store_id !== params.store_id ||
        result.source.plan_id !== params.plan_id ||
        result.quote.customer_location_evidence_id !== params.customer_location_evidence_id ||
        !Number.isFinite(Date.parse(result.quote.quoted_at)) ||
        Date.parse(result.quote.quoted_at) > Date.now() ||
        !Number.isFinite(Date.parse(result.quote.expires_at)) ||
        Date.parse(result.quote.expires_at) <= Date.now()
      )
        throw new Error('Invalid quote');
      const key = createPublicKey(pinned);
      if (
        key.asymmetricKeyType !== 'ed25519' ||
        !verify(
          null,
          Buffer.from(canonicalBillingTaxQuote(result)),
          key,
          Buffer.from(result.signature.value, 'base64url'),
        )
      )
        throw new Error('Invalid signature');
    } catch {
      throw new Error('Peable: tax quote authority verification failed');
    }
    return result;
  }
  async retrieveFinalInvoiceAuthority(
    subscriptionRef: string,
    invoiceRef: string,
    options: RetrieveFinalInvoiceAuthorityOptions = {},
  ): Promise<BillingFinalInvoiceAuthority> {
    if (!this.invoiceAuthorityKeys || Object.keys(this.invoiceAuthorityKeys).length === 0)
      throw new Error('Peable: invoice authority verification is unconfigured');
    const withTaxLines = options.include?.includes('tax_lines') === true;
    const authority = await this.client.request<BillingFinalInvoiceAuthority>(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/invoice_authorities/${encodeURIComponent(invoiceRef)}`,
      withTaxLines ? { query: { include: 'tax_lines' } } : undefined,
    );
    try {
      const pinnedKey = this.invoiceAuthorityKeys[authority.signature.key_id];
      if (
        authority.schema_version !== 1 ||
        !pinnedKey ||
        authority.signature.algorithm !== 'Ed25519' ||
        !/^[A-Za-z0-9_-]{86}$/.test(authority.signature.value) ||
        authority.source.invoice_id !== invoiceRef ||
        authority.source.subscription_id !== subscriptionRef ||
        authority.invoice.context.provider_subscription_id !== subscriptionRef ||
        !['card', 'faircoin'].includes(authority.method) ||
        !Number.isFinite(Date.parse(authority.invoice.issued_at)) ||
        Date.parse(authority.invoice.issued_at) > Date.now() ||
        !Number.isFinite(Date.parse(authority.invoice.expires_at)) ||
        Date.parse(authority.invoice.expires_at) <= Date.now() ||
        // Lines are present exactly when asked for, and add up to the tax.
        withTaxLines !== Array.isArray(authority.invoice.tax_lines) ||
        (authority.invoice.tax_lines !== undefined &&
          authority.invoice.tax_lines.reduce((sum, line) => sum + line.tax_minor_units, 0) !==
            authority.invoice.tax_minor_units)
      )
        throw new Error('Invalid authority');
      if (authority.method === 'faircoin') {
        const quote = authority.invoice.faircoin_quote;
        if (
          !quote ||
          !/^[1-9][0-9]*$/.test(quote.amount_base_units) ||
          !Number.isFinite(Date.parse(quote.quoted_at)) ||
          Date.parse(quote.quoted_at) > Date.now() ||
          !Number.isFinite(Date.parse(quote.expires_at)) ||
          Date.parse(quote.expires_at) <= Date.parse(quote.quoted_at) ||
          Date.parse(quote.expires_at) > Date.parse(authority.invoice.expires_at)
        )
          throw new Error('Invalid quote');
      }
      const key = createPublicKey(pinnedKey);
      if (
        key.asymmetricKeyType !== 'ed25519' ||
        !verify(
          null,
          Buffer.from(canonicalBillingAuthority(authority), 'utf8'),
          key,
          Buffer.from(authority.signature.value, 'base64url'),
        )
      )
        throw new Error('Invalid signature');
      // The FX quote bounds the payment, not delivery of its observation. A
      // delayed webhook must remain recoverable after the original quote expires.
      if (authority.method === 'faircoin') {
        const paid = await this.retrievePaidInvoice(subscriptionRef, invoiceRef);
        // biome-ignore lint/style/noNonNullAssertion: FairCoin quote presence and bounds were verified above before signature verification.
        const quote = authority.invoice.faircoin_quote!;
        const paidAt = Date.parse(paid.paid_at);
        if (
          paid.invoice_id !== invoiceRef ||
          paid.provider_subscription_id !== subscriptionRef ||
          paid.payment_intent_id !== authority.source.payment_intent_id ||
          paid.provider_customer_id !== authority.source.customer_id ||
          paid.provider_price_id !== authority.source.price_id ||
          paid.store_id !== authority.invoice.context.payer_account_id ||
          !Number.isFinite(paidAt) ||
          paidAt > Date.now() ||
          paidAt < Date.parse(quote.quoted_at) ||
          paidAt >= Date.parse(quote.expires_at)
        )
          throw new Error('Payment outside signed quote');
      }
    } catch {
      throw new Error('Peable: invoice authority verification failed');
    }
    return authority;
  }
  retrievePaidInvoice(subscriptionRef: string, invoiceRef: string): Promise<BillingPaidInvoice> {
    return this.client.request(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/paid_invoices/${encodeURIComponent(invoiceRef)}`,
    );
  }
  retrieveInvoiceState(subscriptionRef: string, invoiceRef: string): Promise<BillingInvoiceState> {
    return this.client.request(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/invoice_states/${encodeURIComponent(invoiceRef)}`,
    );
  }
  retrieveSubscription(ref: string): Promise<BillingSubscription> {
    return this.client.request('GET', `/v1/billing/subscriptions/${encodeURIComponent(ref)}`);
  }
  cancelAtPeriodEnd(ref: string, options: BillingRequestOptions): Promise<BillingSubscription> {
    return this.client.request(
      'POST',
      `/v1/billing/subscriptions/${encodeURIComponent(ref)}/cancel_at_period_end`,
      { body: {}, idempotencyKey: options.idempotencyKey },
    );
  }
}
