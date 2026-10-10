import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
  type BillingPaidInvoice,
} from '@peable.to/shared-types';
import { BillingResource } from '../../src/resources/billing';
import type { RestClient } from '../../src/core/client';
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

function client(value: unknown, requests: string[]): RestClient {
  return {
    async request<T>(_method: string, path: string): Promise<T> {
      requests.push(path);
      return value as T;
    },
  };
}
describe('pinned SDK invoice authority', () => {
  it('requires pinned keys before HTTP, verifies signatures and correlates requested references', async () => {
    const { authority } = fixture();
    const requests: string[] = [];
    await expect(
      new BillingResource(client(authority, requests)).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('unconfigured');
    expect(requests).toHaveLength(0);
    const resource = new BillingResource(client(authority, requests), pinned);
    expect(await resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')).toEqual(
      authority,
    );
    await expect(
      resource.retrieveFinalInvoiceAuthority('sub_another', 'in_fixture'),
    ).rejects.toThrow('verification failed');
    authority.invoice.grossMinorUnits++;
    await expect(
      resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture'),
    ).rejects.toThrow('verification failed');
  });
  it('rejects unknown keys, unsupported versions and signed expired Faircoin quotes', async () => {
    const { authority } = fixture();
    const requests: string[] = [];
    await expect(
      new BillingResource(client(authority, requests), {}).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('unconfigured');
    const resource = new BillingResource(client(authority, requests), { another: pinned.fixture });
    await expect(
      resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture'),
    ).rejects.toThrow('verification failed');
    authority.method = 'faircoin';
    authority.invoice.faircoinQuote = {
      id: 'quote_fixture',
      amountBaseUnits: '1234',
      quotedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
      roundingEvidenceId: 'round_fixture',
    };
    resign(authority);
    await expect(
      new BillingResource(client(authority, requests), pinned).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('verification failed');
    authority.invoice.faircoinQuote.expiresAt = new Date(Date.now() + 20_000).toISOString();
    resign(authority);
    expect(
      (
        await new BillingResource(
          client(authority, requests),
          pinned,
        ).retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')
      ).method,
    ).toBe('faircoin');
    const unsupported = { ...authority, schemaVersion: 2 };
    await expect(
      new BillingResource(client(unsupported, requests), pinned).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('verification failed');
  });
});
