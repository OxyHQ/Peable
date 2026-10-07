import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalBillingTaxQuote, type BillingTaxQuote } from '@peable.to/shared-types';
import { BillingResource } from '../../src/resources/billing';
import type { RestClient, RestClientRequestOptions } from '../../src/core/client';

function fixture() {
  const keys = generateKeyPairSync('ed25519'); const now = new Date();
  const request = { storeId: 'payer_fixture', planId: 'plan_fixture', customerLocationEvidenceId: 'location_fixture' };
  const result: BillingTaxQuote = { schemaVersion: 1, source: { merchantId: 'merch_fixture', appId: 'app_fixture', storeId: request.storeId,
    planId: request.planId, mode: 'test', environment: 'development' }, quote: { id: 'quote_fixture', currency: 'USD',
    grossMinorUnits: 2999, netMinorUnits: 2500, taxMinorUnits: 499, taxTreatment: 'inclusive', sellerId: 'seller_fixture',
    invoiceIssuerId: 'issuer_fixture', taxRemitterId: 'remitter_fixture', taxServiceRef: 'calculator_fixture', country: 'RO',
    coverageEvidenceId: 'coverage_fixture', taxRateEvidenceId: 'rate_fixture', customerLocationEvidenceId: request.customerLocationEvidenceId,
    quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }, signature: { algorithm: 'Ed25519', keyId: 'fixture', value: '' } };
  const resign = () => { result.signature.value = sign(null, Buffer.from(canonicalBillingTaxQuote(result)), keys.privateKey).toString('base64url'); };
  resign();
  const paths: string[] = [];
  const client: RestClient = { async request<T>(_method: string, path: string, options?: RestClientRequestOptions): Promise<T> {
    expect(options?.body).toEqual(request); paths.push(path); return result as T;
  } };
  const pinned = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  return { result, request, paths, client, pinned, resign };
}
describe('pinned SDK tax quote authority', () => {
  it('remains closed without configured issuer keys and uses only the Peable SDK route', async () => {
    const value = fixture();
    await expect(new BillingResource(value.client).createTaxQuote(value.request)).rejects.toThrow('unconfigured');
    expect(value.paths).toHaveLength(0);
    expect(await new BillingResource(value.client, undefined, value.pinned).createTaxQuote(value.request)).toEqual(value.result);
    expect(value.paths).toEqual(['/v1/billing/tax_quotes']);
  });
  it('rejects pinned-signature tampering, foreign evidence and expired signed quotations', async () => {
    const value = fixture(); const resource = new BillingResource(value.client, undefined, value.pinned);
    value.result.quote.invoiceIssuerId = 'tampered_issuer';
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
    value.resign(); value.result.quote.customerLocationEvidenceId = 'another_location'; value.resign();
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
    value.result.quote.customerLocationEvidenceId = value.request.customerLocationEvidenceId;
    value.result.quote.expiresAt = new Date(Date.now() - 1).toISOString(); value.resign();
    await expect(resource.createTaxQuote(value.request)).rejects.toThrow('verification failed');
  });
});
