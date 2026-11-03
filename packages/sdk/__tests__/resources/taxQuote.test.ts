import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalBillingTaxQuote, type BillingTaxQuote } from '@peable.to/shared-types';
import type { GatewayClient, RestClient, RestClientRequestOptions } from '../../src/core/client';
import { withBillingAuthority } from '../../src/overlays/billingAuthority';
import { resources } from '../support/testGateway';

/** `peable.billing` over `client`, verifying with `taxQuoteAuthorityKeys`. */
function QuoteBilling(
  client: RestClient,
  taxQuoteAuthorityKeys?: Readonly<Record<string, string>>,
) {
  return withBillingAuthority(resources(client as GatewayClient).billing, {
    ...(taxQuoteAuthorityKeys === undefined ? {} : { taxQuoteAuthorityKeys }),
  });
}

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const now = new Date();
  const request = {
    store_id: 'payer_fixture',
    plan_id: 'plan_fixture',
    customer_location_evidence_id: 'location_fixture',
  };
  const result: BillingTaxQuote = {
    schema_version: 2,
    source: {
      merchant_id: 'merch_fixture',
      app_id: 'app_fixture',
      store_id: request.store_id,
      plan_id: request.plan_id,
      mode: 'test',
      environment: 'development',
    },
    quote: {
      id: 'quote_fixture',
      currency: 'USD',
      gross_minor_units: 2999,
      net_minor_units: 2500,
      tax_minor_units: 499,
      tax_treatment: 'inclusive',
      seller_id: 'seller_fixture',
      invoice_issuer_id: 'issuer_fixture',
      tax_remitter_id: 'remitter_fixture',
      tax_service_ref: 'calculator_fixture',
      country: 'RO',
      coverage_evidence_id: 'coverage_fixture',
      tax_rate_evidence_id: 'rate_fixture',
      customer_location_evidence_id: request.customer_location_evidence_id,
      quoted_at: Math.floor(+now / 1000),
      expires_at: Math.floor(+now / 1000) + 60,
    },
    signature: { algorithm: 'Ed25519', key_id: 'fixture', value: '' },
  };
  const resign = () => {
    result.signature.value = sign(
      null,
      Buffer.from(canonicalBillingTaxQuote(result)),
      keys.privateKey,
    ).toString('base64url');
  };
  resign();
  const paths: string[] = [];
  const client: RestClient = {
    async request<T>(
      _method: string,
      path: string,
      options?: RestClientRequestOptions,
    ): Promise<T> {
      expect(options?.body).toEqual(request);
      paths.push(path);
      return result as T;
    },
  };
  const pinned = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  return { result, request, paths, client, pinned, resign };
}
describe('pinned SDK tax quote authority', () => {
  it('remains closed without configured issuer keys and uses only the Peable SDK route', async () => {
    const value = fixture();
    await expect(QuoteBilling(value.client).createTaxQuote(value.request)).rejects.toThrow(
      'unconfigured',
    );
    expect(value.paths).toHaveLength(0);
    expect(await QuoteBilling(value.client, value.pinned).createTaxQuote(value.request)).toEqual(
      value.result,
    );
    expect(value.paths).toEqual(['/v1/billing/tax_quotes']);
  });
  it('rejects pinned-signature tampering, foreign evidence and expired signed quotations', async () => {
    const value = fixture();
    const resource = QuoteBilling(value.client, value.pinned);
    value.result.quote.invoice_issuer_id = 'tampered_issuer';
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
    value.resign();
    value.result.quote.customer_location_evidence_id = 'another_location';
    value.resign();
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
    value.result.quote.customer_location_evidence_id = value.request.customer_location_evidence_id;
    value.result.quote.expires_at = Math.floor(Date.now() / 1000) - 1;
    value.resign();
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
    // Only schema version 2 (Unix-second instants) is accepted, even when signed.
    value.result.quote.expires_at = Math.floor(Date.now() / 1000) + 60;
    value.resign();
    expect(await resource.createTaxQuote(value.request)).toEqual(value.result);
    (value.result as { schema_version: number }).schema_version = 1;
    value.resign();
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
  });
});
