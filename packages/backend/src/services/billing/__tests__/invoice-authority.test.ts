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
    invoice_id: 'in_fixture',
    line_id: 'il_fixture',
    payment_intent_id: 'pi_fixture',
    provider_subscription_id: 'sub_fixture',
    provider_customer_id: 'cus_fixture',
    provider_price_id: 'price_fixture',
    store_id: 'payer_fixture',
    plan_id: 'plan_fixture',
    livemode: false,
    currency: 'USD',
    amount_paid: '2999',
    net_amount: '2499',
    tax_amount: '500',
    period_start: '2026-10-01T00:00:00.000Z',
    period_end: '2026-11-01T00:00:00.000Z',
    paid_at: now.toISOString(),
    observed_at: now.toISOString(),
  };
  const authority: BillingFinalInvoiceAuthority = {
    schema_version: 1,
    source: {
      invoice_id: paid.invoice_id,
      payment_intent_id: paid.payment_intent_id,
      customer_id: paid.provider_customer_id,
      subscription_id: paid.provider_subscription_id,
      price_id: paid.provider_price_id,
      plan_id: paid.plan_id,
      merchant_id: 'merch_fixture',
      app_id: owner.oxyAppId,
      mode: 'test',
      environment: owner.environment,
    },
    invoice: {
      platform: 'peable',
      currency: 'USD',
      gross_minor_units: 2999,
      net_minor_units: 2499,
      tax_minor_units: 500,
      merchant_fee_minor_units: 0,
      tax_treatment: 'inclusive',
      seller_id: 'seller_fixture',
      invoice_issuer_id: 'issuer_fixture',
      tax_quote_id: 'tax_quote_fixture',
      customer_location_evidence_id: 'location_fixture',
      tax_rate_evidence_id: 'rate_fixture',
      context: {
        payer_account_id: paid.store_id,
        beneficiary_account_id: paid.store_id,
        provider_subscription_id: paid.provider_subscription_id,
        offer_id: 'offer_fixture',
        offer_version: 1,
        period_start: paid.period_start,
        period_end: paid.period_end,
        mode: 'test',
        environment: owner.environment,
      },
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
    },
    method: 'card',
    signature: { algorithm: 'Ed25519', key_id: 'fixture', value: '' },
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
      schemaVersion: authority.schema_version,
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
    authority.invoice.seller_id = 'tampered';
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    resign(authority);
    authority.source.app_id = 'another_app';
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.source.app_id = expected.owner.oxyAppId;
    resign(authority);
    expect(() =>
      verifyFinalInvoiceAuthority(authority, expected, pinned, new Date(now.getTime() + 61_000)),
    ).toThrow('invalid_provider_response');
  });
  it('rejects signed totals differing from paid tax observations and unsafe Faircoin quotes', () => {
    const { authority, expected, now } = fixture();
    authority.invoice.net_minor_units++;
    authority.invoice.tax_minor_units--;
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.net_minor_units--;
    authority.invoice.tax_minor_units++;
    authority.method = 'faircoin';
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.faircoin_quote = {
      id: 'quote_fixture',
      amount_base_units: '1234',
      quoted_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 120_000).toISOString(),
      rounding_evidence_id: 'round_fixture',
    };
    resign(authority);
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
    authority.invoice.faircoin_quote.expires_at = new Date(now.getTime() + 30_000).toISOString();
    resign(authority);
    expect(verifyFinalInvoiceAuthority(authority, expected, pinned, now).method).toBe('faircoin');
  });
});

it('keeps a settled historical FX quote verifiable while rejecting late or early payment', () => {
  const { authority, expected, now } = fixture();
  authority.method = 'faircoin';
  authority.invoice.faircoin_quote = {
    id: 'quote_old',
    amount_base_units: '1234',
    quoted_at: new Date(+now - 120_000).toISOString(),
    expires_at: new Date(+now - 60_000).toISOString(),
    rounding_evidence_id: 'round_old',
  };
  expected.invoice.paid_at = new Date(+now - 90_000).toISOString();
  resign(authority);
  expect(verifyFinalInvoiceAuthority(authority, expected, pinned, now).method).toBe('faircoin');
  for (const paidAt of [
    authority.invoice.faircoin_quote.expires_at,
    new Date(+now - 120_001).toISOString(),
  ]) {
    expected.invoice.paid_at = paidAt;
    expect(() => verifyFinalInvoiceAuthority(authority, expected, pinned, now)).toThrow(
      'invalid_provider_response',
    );
  }
});
