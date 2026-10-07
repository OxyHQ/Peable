import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalBillingTaxQuote, type BillingTaxQuote } from '@peable.to/shared-types';
import { createVerifiedBillingTaxQuote, type BillingTaxQuoteCalculator } from '../tax-quote';

function fixture() {
  const keys = generateKeyPairSync('ed25519'); const now = new Date('2026-10-07T12:00:00.000Z');
  const owner = { merchantId: 'internal_merchant', oxyAppId: 'app_fixture', environment: 'development' as const };
  const request = { storeId: 'payer_fixture', planId: 'plan_fixture', customerLocationEvidenceId: 'location_fixture' };
  const product = { configurationApproved: true as const, planId: request.planId, currency: 'USD', grossMinorUnits: 2999,
    taxTreatment: 'inclusive' as const, sellerId: 'seller_fixture', invoiceIssuerId: 'issuer_fixture', taxRemitterId: 'remitter_fixture',
    taxServiceRef: 'calculator_fixture', allowedCountries: ['RO'], coverageEvidenceId: 'coverage_fixture' };
  const location = { id: request.customerLocationEvidenceId, storeId: request.storeId, appId: owner.oxyAppId, country: 'RO',
    mode: 'test' as const, environment: owner.environment, observedAt: now.toISOString(), expiresAt: '2026-10-07T12:05:00.000Z' };
  let calls = 0;
  let tamper = (result: BillingTaxQuote) => result;
  const calculator: BillingTaxQuoteCalculator = {
    verificationKeys: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    async resolveProduct() { return product; }, async readCustomerLocation() { return location; },
    async calculate({ source }) {
      calls++;
      const result: BillingTaxQuote = tamper({ schemaVersion: 1, source,
        quote: { id: 'quote_fixture', currency: product.currency, grossMinorUnits: product.grossMinorUnits, netMinorUnits: 2500,
          taxMinorUnits: 499, taxTreatment: product.taxTreatment, sellerId: product.sellerId, invoiceIssuerId: product.invoiceIssuerId,
          taxRemitterId: product.taxRemitterId, taxServiceRef: product.taxServiceRef, country: location.country,
          coverageEvidenceId: product.coverageEvidenceId, taxRateEvidenceId: 'rate_fixture', customerLocationEvidenceId: location.id,
          quotedAt: now.toISOString(), expiresAt: '2026-10-07T12:01:00.000Z' }, signature: { algorithm: 'Ed25519', keyId: 'fixture', value: '' } });
      result.signature.value = sign(null, Buffer.from(canonicalBillingTaxQuote(result)), keys.privateKey).toString('base64url');
      return result;
    },
  };
  return { owner, request, product, location, calculator, now, calls: () => calls, setTamper: (fn: typeof tamper) => { tamper = fn; } };
}
describe('provider-neutral Peable tax quote gate', () => {
  it('quotes only reviewed products and exact trusted customer location/coverage', async () => {
    const value = fixture();
    expect(await createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).toMatchObject({
      source: { merchantId: 'merch_fixture', storeId: 'payer_fixture' }, quote: { grossMinorUnits: 2999, taxMinorUnits: 499, country: 'RO' } });
    expect(value.calls()).toBe(1);
  });
  it('rejects missing coverage, wildcard global coverage and foreign/expired location before invoking a supplier', async () => {
    const value = fixture(); value.product.allowedCountries = [];
    await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow();
    value.product.allowedCountries = ['*'];
    await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow();
    value.product.allowedCountries = ['US'];
    await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow('not_found');
    value.product.allowedCountries = ['RO']; value.location.storeId = 'another_payer';
    await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow('not_found');
    value.location.storeId = value.request.storeId; value.location.expiresAt = value.now.toISOString();
    await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow('not_found');
    expect(value.calls()).toBe(0);
  });
  it('rejects supplier authority differing in fiscal actor, amounts, country, clocks or pinned signature', async () => {
    for (const mutation of [
      (result: BillingTaxQuote) => { result.quote.invoiceIssuerId = 'another_issuer'; return result; },
      (result: BillingTaxQuote) => { result.quote.taxRemitterId = 'another_remitter'; return result; },
      (result: BillingTaxQuote) => { result.quote.netMinorUnits++; return result; },
      (result: BillingTaxQuote) => { result.quote.country = 'US'; return result; },
      (result: BillingTaxQuote) => { result.quote.expiresAt = result.quote.quotedAt; return result; },
      (result: BillingTaxQuote) => { result.source.appId = 'another_app'; return result; },
    ]) {
      const value = fixture(); value.setTamper(mutation);
      await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow('invalid_provider_response');
    }
    const value = fixture(); value.calculator.verificationKeys = {};
    await expect(createVerifiedBillingTaxQuote(value.calculator, value.owner, 'merch_fixture', value.request, () => value.now)).rejects.toThrow('invalid_provider_response');
  });
});
