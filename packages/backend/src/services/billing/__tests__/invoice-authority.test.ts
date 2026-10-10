import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
  type BillingPaidInvoice,
} from '@peable.to/shared-types';
import { verifyFinalInvoiceAuthority } from '../invoice-authority';

const keys = generateKeyPairSync('ed25519');
const pinned = { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
function fixture() {
  const now = new Date();
  const owner = {
    merchantId: 'internal_merchant',
    oxyAppId: 'app_fixture',
    environment: 'development' as const,
  };
  const paid: BillingPaidInvoice = {
    invoiceId: 'in_fixture',
    lineId: 'il_fixture',
    paymentIntentId: 'pi_fixture',
    providerSubscriptionId: 'sub_fixture',
    providerCustomerId: 'cus_fixture',
    providerPriceId: 'price_fixture',
    storeId: 'payer_fixture',
    planId: 'plan_fixture',
    livemode: false,
    currency: 'USD',
    amountPaid: '2999',
    netAmount: '2499',
    taxAmount: '500',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    paidAt: now.toISOString(),
    observedAt: now.toISOString(),
  };
  const authority: BillingFinalInvoiceAuthority = {
    schemaVersion: 1,
    source: {
      invoiceId: paid.invoiceId,
      paymentIntentId: paid.paymentIntentId,
      customerId: paid.providerCustomerId,
      subscriptionId: paid.providerSubscriptionId,
      priceId: paid.providerPriceId,
      planId: paid.planId,
      merchantId: 'merch_fixture',
      appId: owner.oxyAppId,
      mode: 'test',
      environment: owner.environment,
    },
    invoice: {
      platform: 'peable',
      currency: 'USD',
      grossMinorUnits: 2999,
      netMinorUnits: 2499,
      taxMinorUnits: 500,
      merchantFeeMinorUnits: 0,
      taxTreatment: 'inclusive',
      sellerId: 'seller_fixture',
      invoiceIssuerId: 'issuer_fixture',
      taxQuoteId: 'tax_quote_fixture',
      customerLocationEvidenceId: 'location_fixture',
      taxRateEvidenceId: 'rate_fixture',
      context: {
        payerAccountId: paid.storeId,
        beneficiaryAccountId: paid.storeId,
        providerSubscriptionId: paid.providerSubscriptionId,
        offerId: 'offer_fixture',
        offerVersion: 1,
        periodStart: paid.periodStart,
        periodEnd: paid.periodEnd,
        mode: 'test',
        environment: owner.environment,
      },
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    method: 'card',
    signature: { algorithm: 'Ed25519', keyId: 'fixture', value: '' },
  };
  resign(authority);
  return { authority, expected: { owner, merchantPublicId: 'merch_fixture', invoice: paid }, now };
}
function resign(authority: BillingFinalInvoiceAuthority) {
  authority.signature.value = sign(
    null,
    Buffer.from(canonicalBillingAuthority(authority)),
    keys.privateKey,
  ).toString('base64url');
}
describe('signed final invoice authority', () => {
  it('verifies canonical signatures with an independently pinned key', () => {
    const { authority, expected, now } = fixture();
    expect(verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toEqual(authority);
    const reordered = {
      schemaVersion: authority.schemaVersion,
      method: authority.method,
      invoice: authority.invoice,
      source: authority.source,
    };
    expect(canonicalBillingAuthority(reordered)).toBe(canonicalBillingAuthority(authority));
  });
  it('rejects unknown keys, tampering, cross-owner and stale evidence', () => {
    const { authority, expected, now } = fixture();
    expect(() => verifyFinalInvoiceAuthority(authority, expected, {}, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.sellerId = 'tampered';
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    resign(authority);
    authority.source.appId = 'another_app';
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.source.appId = expected.owner.oxyAppId;
    resign(authority);
    expect(() =>
      verifyFinalInvoiceAuthority(authority, expected, pinned, new Date(now.getTime() + 61_000)),
    ).toThrow('invalid_provider_response');
  });
  it('rejects signed totals differing from paid tax observations and unsafe Faircoin quotes', () => {
    const { authority, expected, now } = fixture();
    authority.invoice.netMinorUnits++;
    authority.invoice.taxMinorUnits--;
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.netMinorUnits--;
    authority.invoice.taxMinorUnits++;
    authority.method = 'faircoin';
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.faircoinQuote = {
      id: 'quote_fixture',
      amountBaseUnits: '1234',
      quotedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      roundingEvidenceId: 'round_fixture',
    };
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.faircoinQuote.expiresAt = new Date(now.getTime() + 30_000).toISOString();
    resign(authority);
    expect(verifyFinalInvoiceAuthority(authority, expected, pinned, now).method).toBe('faircoin');
  });
});
