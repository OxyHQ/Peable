// The one place the server SDK adds behaviour to generated methods: the two
// billing documents Peable SIGNS (a tax quote, a final invoice authority) are
// verified against pinned Ed25519 keys before the caller sees them. A route
// contract describes the shape; only the caller's own keys can say the document
// is Peable's. Every other method is exactly the generated one.

import { createPublicKey, verify } from 'node:crypto';
import {
  type BillingFinalInvoiceAuthority,
  type BillingTaxQuote,
  canonicalBillingAuthority,
  canonicalBillingTaxQuote,
  isBaseUnitString,
} from '@peable.to/shared-types';
import type { BillingResource } from '../generated/resources';

/** Pinned Ed25519 public keys (PEM), by key id — from trusted deployment configuration. */
export interface BillingAuthorityKeys {
  readonly invoiceAuthorityKeys?: Readonly<Record<string, string>>;
  readonly taxQuoteAuthorityKeys?: Readonly<Record<string, string>>;
}

/** Signed instants are integer Unix seconds (ADR 0014 D1). */
function isUnixSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Signed amounts are base-unit integer strings (ADR 0014 D1, schema version 3). */
function isAmount(value: unknown): value is string {
  return typeof value === 'string' && isBaseUnitString(value);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function configured(
  keys: Readonly<Record<string, string>> | undefined,
): keys is Readonly<Record<string, string>> {
  return keys !== undefined && Object.keys(keys).length > 0;
}

function verifiesWith(pem: string, message: string, signature: string): boolean {
  const key = createPublicKey(pem);
  return (
    key.asymmetricKeyType === 'ed25519' &&
    verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'))
  );
}

function assertTaxQuote(
  result: BillingTaxQuote,
  params: { store_id: string; plan_id: string; customer_location_evidence_id: string },
  keys: Readonly<Record<string, string>>,
): void {
  const pinned = keys[result.signature.key_id];
  if (
    !pinned ||
    result.schema_version !== 3 ||
    result.signature.algorithm !== 'Ed25519' ||
    !/^[A-Za-z0-9_-]{86}$/.test(result.signature.value) ||
    result.source.store_id !== params.store_id ||
    result.source.plan_id !== params.plan_id ||
    result.quote.customer_location_evidence_id !== params.customer_location_evidence_id ||
    !isAmount(result.quote.gross_minor_units) ||
    !isAmount(result.quote.net_minor_units) ||
    !isAmount(result.quote.tax_minor_units) ||
    BigInt(result.quote.net_minor_units) + BigInt(result.quote.tax_minor_units) !==
      BigInt(result.quote.gross_minor_units) ||
    !isUnixSeconds(result.quote.quoted_at) ||
    result.quote.quoted_at > nowSeconds() ||
    !isUnixSeconds(result.quote.expires_at) ||
    result.quote.expires_at <= nowSeconds()
  )
    throw new Error('Invalid quote');
  if (!verifiesWith(pinned, canonicalBillingTaxQuote(result), result.signature.value))
    throw new Error('Invalid signature');
}

function assertAuthority(
  authority: BillingFinalInvoiceAuthority,
  subscriptionRef: string,
  invoiceRef: string,
  withTaxLines: boolean,
  keys: Readonly<Record<string, string>>,
): void {
  const pinnedKey = keys[authority.signature.key_id];
  if (
    authority.schema_version !== 3 ||
    !pinnedKey ||
    authority.signature.algorithm !== 'Ed25519' ||
    !/^[A-Za-z0-9_-]{86}$/.test(authority.signature.value) ||
    authority.source.invoice_id !== invoiceRef ||
    authority.source.subscription_id !== subscriptionRef ||
    authority.invoice.context.provider_subscription_id !== subscriptionRef ||
    !['card', 'faircoin'].includes(authority.method) ||
    !isUnixSeconds(authority.invoice.issued_at) ||
    authority.invoice.issued_at > nowSeconds() ||
    !isUnixSeconds(authority.invoice.expires_at) ||
    authority.invoice.expires_at <= nowSeconds() ||
    // Amounts are base-unit strings (schema version 3): net and tax add up to
    // the gross, exactly.
    !isAmount(authority.invoice.gross_minor_units) ||
    !isAmount(authority.invoice.net_minor_units) ||
    !isAmount(authority.invoice.tax_minor_units) ||
    BigInt(authority.invoice.net_minor_units) + BigInt(authority.invoice.tax_minor_units) !==
      BigInt(authority.invoice.gross_minor_units) ||
    // Lines are present exactly when asked for, and add up to the tax.
    withTaxLines !== Array.isArray(authority.invoice.tax_lines) ||
    (authority.invoice.tax_lines !== undefined &&
      (!authority.invoice.tax_lines.every((line) => isAmount(line.tax_minor_units)) ||
        authority.invoice.tax_lines.reduce(
          (sum, line) => sum + BigInt(line.tax_minor_units),
          0n,
        ) !== BigInt(authority.invoice.tax_minor_units)))
  )
    throw new Error('Invalid authority');
  if (authority.method === 'faircoin') {
    const quote = authority.invoice.faircoin_quote;
    if (
      !quote ||
      !/^[1-9][0-9]*$/.test(quote.amount_base_units) ||
      !isUnixSeconds(quote.quoted_at) ||
      quote.quoted_at > nowSeconds() ||
      !isUnixSeconds(quote.expires_at) ||
      quote.expires_at <= quote.quoted_at ||
      quote.expires_at > authority.invoice.expires_at
    )
      throw new Error('Invalid quote');
  }
  if (!verifiesWith(pinnedKey, canonicalBillingAuthority(authority), authority.signature.value))
    throw new Error('Invalid signature');
}

/**
 * Replace `billing.createTaxQuote` and `billing.retrieveFinalInvoiceAuthority`
 * with verifying versions of the same signature. Without pinned keys each
 * refuses to answer at all ("unconfigured"); a document that fails any check
 * is thrown away with one opaque error, never returned half-trusted.
 */
export function withBillingAuthority(
  billing: BillingResource,
  keys: BillingAuthorityKeys,
): BillingResource {
  const createTaxQuote = billing.createTaxQuote.bind(billing);
  const retrieveFinalInvoiceAuthority = billing.retrieveFinalInvoiceAuthority.bind(billing);
  const retrievePaidInvoice = billing.retrievePaidInvoice.bind(billing);

  billing.createTaxQuote = async (params, options) => {
    const pinned = keys.taxQuoteAuthorityKeys;
    if (!configured(pinned)) {
      throw new Error('Peable: tax quote authority verification is unconfigured');
    }
    const result = await createTaxQuote(params, options);
    try {
      assertTaxQuote(result as BillingTaxQuote, params, pinned);
    } catch {
      throw new Error('Peable: tax quote authority verification failed');
    }
    return result;
  };

  billing.retrieveFinalInvoiceAuthority = async (subscriptionRef, invoiceRef, params, options) => {
    const pinned = keys.invoiceAuthorityKeys;
    if (!configured(pinned)) {
      throw new Error('Peable: invoice authority verification is unconfigured');
    }
    const withTaxLines = params?.include === 'tax_lines';
    const authority = await retrieveFinalInvoiceAuthority(
      subscriptionRef,
      invoiceRef,
      params,
      options,
    );
    try {
      const signed = authority as BillingFinalInvoiceAuthority;
      assertAuthority(signed, subscriptionRef, invoiceRef, withTaxLines, pinned);
      // The FX quote bounds the payment, not delivery of its observation: a
      // delayed webhook stays recoverable after the original quote expires.
      if (signed.method === 'faircoin') {
        const paid = await retrievePaidInvoice(subscriptionRef, invoiceRef, options);
        const quote = signed.invoice.faircoin_quote;
        const paidAt = paid.paid_at;
        if (
          quote === undefined ||
          quote === null ||
          paid.invoice_id !== invoiceRef ||
          paid.provider_subscription_id !== subscriptionRef ||
          paid.payment_intent_id !== signed.source.payment_intent_id ||
          paid.provider_customer_id !== signed.source.customer_id ||
          paid.provider_price_id !== signed.source.price_id ||
          paid.store_id !== signed.invoice.context.payer_account_id ||
          !isUnixSeconds(paidAt) ||
          paidAt > nowSeconds() ||
          paidAt < quote.quoted_at ||
          paidAt >= quote.expires_at
        )
          throw new Error('Payment outside signed quote');
      }
    } catch {
      throw new Error('Peable: invoice authority verification failed');
    }
    return authority;
  };

  return billing;
}
