import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
  type BillingPaidInvoice,
} from '@peable.to/shared-types';
import type { GatewayClient, RestClient } from '../../src/core/client';
import { withBillingAuthority } from '../../src/overlays/billingAuthority';
import { resources } from '../support/testGateway';

/** `peable.billing` over `client`, verifying with `invoiceAuthorityKeys`. */
function BillingOver(client: RestClient, invoiceAuthorityKeys?: Readonly<Record<string, string>>) {
  return withBillingAuthority(resources(client as GatewayClient).billing, {
    ...(invoiceAuthorityKeys === undefined ? {} : { invoiceAuthorityKeys }),
  });
}
const keys = generateKeyPairSync('ed25519');
const unix = (ms: number) => Math.floor(ms / 1000);
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
    period_start: 1790812800,
    period_end: 1793491200,
    paid_at: unix(+now),
    observed_at: unix(+now),
  };
  const authority: BillingFinalInvoiceAuthority = {
    schema_version: 2,
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
      issued_at: unix(+now),
      expires_at: unix(+now + 60_000),
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

function client(value: unknown, requests: string[], paid?: BillingPaidInvoice): RestClient {
  return {
    async request<T>(_method: string, path: string): Promise<T> {
      requests.push(path);
      return (path.includes('/paid_invoices/') ? paid : value) as T;
    },
  };
}
describe('pinned SDK invoice authority', () => {
  it('requires pinned keys before HTTP, verifies signatures and correlates requested references', async () => {
    const { authority } = fixture();
    const requests: string[] = [];
    await expect(
      BillingOver(client(authority, requests)).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('unconfigured');
    expect(requests).toHaveLength(0);
    const resource = BillingOver(client(authority, requests), pinned);
    expect(await resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')).toEqual(
      authority,
    );
    await expect(
      resource.retrieveFinalInvoiceAuthority('sub_another', 'in_fixture'),
    ).rejects.toThrow('verification failed');
    authority.invoice.gross_minor_units++;
    await expect(
      resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture'),
    ).rejects.toThrow('verification failed');
  });
  it('rejects unknown keys, unsupported versions and payments outside signed Faircoin quotes', async () => {
    const { authority, expected } = fixture();
    const requests: string[] = [];
    await expect(
      BillingOver(client(authority, requests), {}).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('unconfigured');
    const resource = BillingOver(client(authority, requests), { another: pinned.fixture });
    await expect(
      resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture'),
    ).rejects.toThrow('verification failed');
    authority.method = 'faircoin';
    authority.invoice.faircoin_quote = {
      id: 'quote_fixture',
      amount_base_units: '1234',
      quoted_at: unix(Date.now() - 60_000),
      expires_at: unix(Date.now() - 1_000),
      rounding_evidence_id: 'round_fixture',
    };
    resign(authority);
    await expect(
      BillingOver(client(authority, requests), pinned).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('verification failed');
    authority.invoice.faircoin_quote.expires_at = unix(Date.now() + 20_000);
    resign(authority);
    expect(
      (
        await BillingOver(
          client(authority, requests, expected.invoice),
          pinned,
        ).retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')
      ).method,
    ).toBe('faircoin');
    // The ISO-instant schema (version 1) is refused, even when signed.
    const unsupported = { ...authority, schema_version: 1 as unknown as 2 };
    resign(unsupported);
    await expect(
      BillingOver(client(unsupported, requests), pinned).retrieveFinalInvoiceAuthority(
        'sub_fixture',
        'in_fixture',
      ),
    ).rejects.toThrow('verification failed');
  });
});

it('recovers a payment inside its original quote after quote expiry', async () => {
  const { authority, expected, now } = fixture();
  authority.method = 'faircoin';
  authority.invoice.faircoin_quote = {
    id: 'quote_old',
    amount_base_units: '1234',
    quoted_at: unix(+now - 120_000),
    expires_at: unix(+now - 60_000),
    rounding_evidence_id: 'round_old',
  };
  expected.invoice.paid_at = unix(+now - 90_000);
  resign(authority);
  const resource = BillingOver(client(authority, [], expected.invoice), pinned);
  expect((await resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')).method).toBe(
    'faircoin',
  );
  expected.invoice.paid_at = authority.invoice.faircoin_quote.expires_at;
  await expect(resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')).rejects.toThrow(
    'verification failed',
  );
  expected.invoice.paid_at = authority.invoice.faircoin_quote.quoted_at;
  expected.invoice.payment_intent_id = 'pi_other';
  await expect(resource.retrieveFinalInvoiceAuthority('sub_fixture', 'in_fixture')).rejects.toThrow(
    'verification failed',
  );
});

it('asks for tax lines only when requested, and verifies them against the tax', async () => {
  const { authority } = fixture();
  const requests: string[] = [];
  const queries: unknown[] = [];
  const recording = (value: unknown): RestClient => ({
    async request<T>(_method: string, path: string, opts?: { query?: unknown }): Promise<T> {
      requests.push(path);
      queries.push(opts?.query);
      return value as T;
    },
  });
  // Without the option, an authority without lines verifies and no query is sent.
  await BillingOver(recording(authority), pinned).retrieveFinalInvoiceAuthority(
    'sub_fixture',
    'in_fixture',
  );
  expect(queries.at(-1)).toBeUndefined();
  // Asked for but missing: refused.
  await expect(
    BillingOver(recording(authority), pinned).retrieveFinalInvoiceAuthority(
      'sub_fixture',
      'in_fixture',
      { include: 'tax_lines' },
    ),
  ).rejects.toThrow('verification failed');
  authority.invoice.tax_lines = [
    {
      calculation_id: 'taxcalc_fixture',
      country: 'DE',
      state: null,
      tax_type: 'vat',
      rate_percentage: '19.0',
      taxable_minor_units: 2499,
      tax_minor_units: 500,
      inclusive: true,
      taxability_reason: 'standard_rated',
    },
  ];
  resign(authority);
  const withLines = await BillingOver(recording(authority), pinned).retrieveFinalInvoiceAuthority(
    'sub_fixture',
    'in_fixture',
    { include: 'tax_lines' },
  );
  expect(queries.at(-1)).toEqual({ include: 'tax_lines' });
  expect(withLines.invoice.tax_lines?.[0]?.tax_minor_units).toBe(500);
  // Lines that do not add up to the tax are refused even when signed.
  const line = authority.invoice.tax_lines[0];
  if (line) line.tax_minor_units = 400;
  resign(authority);
  await expect(
    BillingOver(recording(authority), pinned).retrieveFinalInvoiceAuthority(
      'sub_fixture',
      'in_fixture',
      { include: 'tax_lines' },
    ),
  ).rejects.toThrow('verification failed');
});
