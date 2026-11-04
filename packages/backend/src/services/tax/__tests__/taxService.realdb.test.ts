import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { exclusiveTaxOf, inclusiveTaxOf } from '../../../__tests__/helpers/fakeTax';
import { must } from '../../../__tests__/helpers/must';
import {
  gatewayDb,
  seedMerchant,
  useGatewayDatabase,
} from '../../../__tests__/helpers/gatewayTestDatabase';
import { createVerifiedBillingTaxQuote, verifyBillingTaxQuote } from '../../billing/tax-quote';
import { createPeableTaxQuoteCalculator, invoiceTaxLines } from '../billingTaxQuotes';
import { TaxProviderUnavailableError, type TaxProvider } from '../provider';
import { commitTaxTransaction, createTaxService, TaxError } from '../taxService';
import { createStripeTaxProvider, type StripeTaxApi } from '../stripeTaxProvider';

useGatewayDatabase();

/** A provider that charges a flat 20% and records what it was asked. */
function fakeProvider(answer: 'standard_rated' | 'not_collecting' | 'down' = 'standard_rated') {
  const calls: Parameters<TaxProvider['calculate']>[0][] = [];
  const synced: string[] = [];
  const provider: TaxProvider = {
    id: 'fake_tax',
    livemode: true,
    async status() {
      return { active: true, headOffice: null, missing: [] };
    },
    async ensureHeadOffice() {},
    async syncRegistration(registration) {
      synced.push(`${registration.country}:${registration.scheme}`);
      return { providerRef: `taxreg_provider_${synced.length}` };
    },
    async calculate(input) {
      calls.push(input);
      if (answer === 'down') throw new TaxProviderUnavailableError('timeout');
      return {
        providerRef: 'taxcalc_provider',
        livemode: true,
        expiresAt: null,
        lineItems: input.lineItems.map((line) => {
          const amountTax =
            answer === 'not_collecting'
              ? 0n
              : line.taxBehavior === 'inclusive'
                ? inclusiveTaxOf(line.amount, 20n)
                : exclusiveTaxOf(line.amount, 20n);
          return {
            reference: line.reference,
            amount: line.amount,
            amountTax,
            taxBehavior: line.taxBehavior,
            breakdown: [
              {
                country: input.customer.country,
                state: null,
                level: 'country',
                display_name: 'VAT',
                tax_type: 'vat',
                rate_percentage: answer === 'not_collecting' ? null : '20.0',
                taxable_amount: (
                  line.amount - (line.taxBehavior === 'inclusive' ? amountTax : 0n)
                ).toString(),
                amount: amountTax.toString(),
                inclusive: line.taxBehavior === 'inclusive',
                taxability_reason: answer,
              },
            ],
          };
        }),
      };
    },
  };
  return { provider, calls, synced };
}

async function approvedMerchant(provider: TaxProvider) {
  const merchant = await seedMerchant({ environment: 'production', network: 'mainnet' });
  const tax = createTaxService({ db: gatewayDb(), providers: [provider] });
  await tax.updateSettings(merchant, {
    legal_name: 'Example Seller, Inc.',
    head_office: { country: 'US', state: 'DE' },
    default_tax_code: 'txcd_10103000',
  });
  await tax.createRegistration(merchant, { country: 'IE', scheme: 'eu_oss_non_union' });
  const approved = await tax.approve(merchant, { userId: 'owner_1', officialApplication: true });
  return { merchant, tax, approved };
}
const euEvidence = (country: string) => ({
  customer_ref: 'acct_payer',
  evidence: [
    { type: 'billing_address', address: { country } },
    { type: 'payment_method_country', country },
  ],
});

describe('Peable Tax', () => {
  it('approval activates settings and mirrors registrations to the provider', async () => {
    const { provider, synced } = fakeProvider();
    const { approved } = await approvedMerchant(provider);
    expect(approved.settings).toMatchObject({ status: 'active', calculation_account: 'platform' });
    expect(approved.registrations[0]).toMatchObject({
      status: 'active',
      provider_registration_ref: 'taxreg_provider_1',
    });
    expect(synced).toEqual(['IE:eu_oss_non_union']);
  });

  it('a registration needs a provider: a third-party app cannot approve one', async () => {
    const merchant = await seedMerchant({ environment: 'production', network: 'mainnet' });
    const tax = createTaxService({ db: gatewayDb(), providers: [fakeProvider().provider] });
    await tax.updateSettings(merchant, { legal_name: 'X', head_office: { country: 'US' } });
    await tax.createRegistration(merchant, { country: 'GB', scheme: 'standard' });
    await expect(
      tax.approve(merchant, { userId: 'owner', officialApplication: false }),
    ).rejects.toMatchObject({ code: 'approval_requires_provider' });
  });

  it('collects where registered, records not_registered elsewhere, and freezes both', async () => {
    const { provider, calls } = fakeProvider();
    const { merchant, tax } = await approvedMerchant(provider);
    const de = await tax.recordEvidence(merchant, euEvidence('DE'));
    const inclusive = await tax.calculate(
      merchant,
      {
        currency: 'usd',
        customer_location_evidence_id: de.id,
        line_items: [{ reference: 'one_monthly', amount: '2999', tax_behavior: 'inclusive' }],
      },
      { requireActive: true },
    );
    expect(inclusive).toMatchObject({
      collection: 'collect',
      amount_total: '2999',
      tax_amount_inclusive: '500',
      amount_net: '2499',
    });
    expect(inclusive.line_items[0]).toMatchObject({
      tax_code: 'txcd_10103000',
      tax_behavior: 'inclusive',
      amount: '2999',
      amount_tax: '500',
      amount_net: '2499',
    });
    expect(inclusive.line_items[0]?.breakdown[0]).toMatchObject({
      taxable_amount: '2499',
      amount: '500',
    });
    expect(inclusive.line_items[0]).not.toHaveProperty('taxCode');
    expect(typeof inclusive.created).toBe('number');
    expect(typeof inclusive.expires_at).toBe('number');
    expect(calls[0]?.lineItems[0]).toMatchObject({ taxCode: 'txcd_10103000', amount: 2999n });
    expect(await tax.retrieveCalculation(merchant, inclusive.id)).toEqual(inclusive);

    const exclusive = await tax.calculate(
      merchant,
      {
        currency: 'USD',
        customer_location_evidence_id: de.id,
        line_items: [{ reference: 'seat', amount: '1000', tax_behavior: 'exclusive' }],
      },
      { requireActive: true },
    );
    expect(exclusive).toMatchObject({
      amount_total: '1200',
      amount_net: '1000',
      tax_amount_exclusive: '200',
      tax_amount_inclusive: '0',
    });

    const jp = await tax.recordEvidence(merchant, {
      customer_ref: 'acct_payer',
      evidence: [{ type: 'billing_address', address: { country: 'JP' } }],
    });
    const before = calls.length;
    const unregistered = await tax.calculate(
      merchant,
      {
        currency: 'USD',
        customer_location_evidence_id: jp.id,
        line_items: [{ reference: 'one_monthly', amount: '2999', tax_behavior: 'inclusive' }],
      },
      { requireActive: true },
    );
    expect(calls.length).toBe(before);
    expect(unregistered).toMatchObject({
      collection: 'not_registered',
      amount_total: '2999',
      amount_net: '2999',
      registration_id: null,
    });
    expect(unregistered.line_items[0]?.breakdown[0]).toMatchObject({
      taxability_reason: 'not_registered',
      taxable_amount: '0',
      amount: '0',
    });
  });

  it('totals and reverses exactly past the largest JS-safe integer', async () => {
    const { provider } = fakeProvider();
    const { merchant, tax } = await approvedMerchant(provider);
    const jp = await tax.recordEvidence(merchant, {
      customer_ref: 'acct_payer',
      evidence: [{ type: 'billing_address', address: { country: 'JP' } }],
    });
    const largest = String(Number.MAX_SAFE_INTEGER);
    const request = {
      currency: 'USD',
      customer_location_evidence_id: jp.id,
      line_items: [
        { reference: 'a', amount: largest },
        { reference: 'b', amount: largest },
      ],
    };
    const calculation = await tax.calculate(merchant, request, { requireActive: true });
    // 2 × (2^53 − 1): a float would answer 18014398509481980.
    expect(calculation.amount_total).toBe('18014398509481982');
    expect(calculation.amount_net).toBe('18014398509481982');
    // One line past what a provider prices is refused, not rounded.
    await expect(
      tax.calculate(
        merchant,
        { ...request, line_items: [{ reference: 'a', amount: '9007199254740992' }] },
        { requireActive: true },
      ),
    ).rejects.toMatchObject({ code: 'invalid_tax_request' });
    await commitTaxTransaction(gatewayDb(), {
      calculationPublicId: calculation.id,
      reference: 'in_large',
      rail: 'faircoin',
      committedAt: new Date(),
    });
    const sale = must((await tax.listTransactions(merchant, { limit: 1 })).data[0]);
    const reversal = await tax.createReversal(merchant, sale.id, {
      reference: 'refund_large',
      amount: '9007199254740992',
    });
    // 2^53, half of it per line: a float could not tell it from 2^53 + 1.
    expect(reversal.reversal).toMatchObject({
      amount_total: '-9007199254740992',
      amount_net: '-9007199254740992',
      tax_amount: '0',
    });
    expect(reversal.reversal?.line_items.map((line) => line.amount)).toEqual([
      '-4503599627370496',
      '-4503599627370496',
    ]);
  });

  it('fails closed when the provider is down or disagrees about the registration', async () => {
    for (const [answer, code] of [
      ['down', 'tax_calculation_unavailable'],
      ['not_collecting', 'tax_provider_registration_mismatch'],
    ] as const) {
      const { merchant, tax } = await approvedMerchant(fakeProvider(answer).provider);
      const evidence = await tax.recordEvidence(merchant, euEvidence('FR'));
      await expect(
        tax.calculate(
          merchant,
          {
            currency: 'USD',
            customer_location_evidence_id: evidence.id,
            line_items: [{ reference: 'p', amount: '500' }],
          },
          { requireActive: true },
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('refuses to price a sale before approval or on insufficient evidence', async () => {
    const merchant = await seedMerchant({ environment: 'production', network: 'mainnet' });
    const tax = createTaxService({ db: gatewayDb(), providers: [fakeProvider().provider] });
    const one = await tax.recordEvidence(merchant, {
      customer_ref: 'c',
      evidence: [{ type: 'billing_address', address: { country: 'DE' } }],
    });
    const request = {
      currency: 'USD',
      customer_location_evidence_id: one.id,
      line_items: [{ reference: 'p', amount: '500' }],
    };
    await expect(tax.calculate(merchant, request, { requireActive: true })).rejects.toMatchObject({
      code: 'tax_settings_not_active',
    });
    await expect(tax.calculate(merchant, request, { requireActive: false })).rejects.toBeInstanceOf(
      TaxError,
    );
  });

  it('signs a billing quote from a calculation, and commits it to the report', async () => {
    const { provider } = fakeProvider();
    const { merchant, tax } = await approvedMerchant(provider);
    const keys = generateKeyPairSync('ed25519');
    const owner = {
      merchantId: merchant.id,
      oxyAppId: merchant.oxyAppId,
      environment: merchant.environment,
    };
    const calculator = createPeableTaxQuoteCalculator({
      db: gatewayDb(),
      tax,
      offers: () => [
        {
          planId: 'one_monthly',
          providerPriceId: 'price_one',
          currency: 'USD',
          grossMinorUnits: 1000,
          taxTreatment: 'exclusive',
        },
      ],
      signingKey: keys.privateKey,
      keyId: 'test-key',
    });
    const evidence = await tax.recordEvidence(merchant, {
      ...euEvidence('NL'),
      customer_ref: 'store_1',
    });
    const quote = await createVerifiedBillingTaxQuote(calculator, owner, merchant.publicId, {
      store_id: 'store_1',
      plan_id: 'one_monthly',
      customer_location_evidence_id: evidence.id,
    });
    // Exclusive: the listed price is the net; the payer pays price plus tax.
    expect(quote.schema_version).toBe(3);
    expect(quote.quote).toMatchObject({
      net_minor_units: '1000',
      tax_minor_units: '200',
      gross_minor_units: '1200',
      tax_treatment: 'exclusive',
      country: 'NL',
      tax_service_ref: 'peable_tax',
    });
    expect(quote.quote.expires_at).toBeGreaterThan(quote.quote.quoted_at);
    expect(quote.quote.tax_rate_evidence_id).toMatch(/^taxcalc_/);
    expect(quote.quote.coverage_evidence_id).toMatch(/^taxreg_/);
    // A tampered amount does not verify.
    const product = must(
      (await calculator.resolveProduct(owner, 'one_monthly')) as Parameters<
        typeof verifyBillingTaxQuote
      >[1]['product'],
    );
    const location = (await calculator.readCustomerLocation(owner, evidence.id)) as Parameters<
      typeof verifyBillingTaxQuote
    >[1]['location'];
    const tampered = structuredClone(quote);
    tampered.quote.tax_minor_units = '100';
    tampered.quote.gross_minor_units = '1100';
    expect(() =>
      verifyBillingTaxQuote(
        tampered,
        { source: quote.source, product, location },
        calculator.verificationKeys,
        new Date(),
      ),
    ).toThrow();

    await commitTaxTransaction(gatewayDb(), {
      calculationPublicId: quote.quote.tax_rate_evidence_id,
      reference: 'in_fair_1',
      rail: 'faircoin',
      committedAt: new Date(),
    });
    // Idempotent: the same payment observed twice is one transaction.
    await commitTaxTransaction(gatewayDb(), {
      calculationPublicId: quote.quote.tax_rate_evidence_id,
      reference: 'in_fair_1',
      rail: 'faircoin',
      committedAt: new Date(),
    });
    // Unix seconds, parsed from the query string by the route (`taxReportQuery`).
    const window = {
      from: Math.floor(Date.now() / 1000) - 3600,
      to: Math.floor(Date.now() / 1000) + 3600,
    };
    const list = await tax.listTransactions(merchant, { limit: 100 });
    expect(list.data).toHaveLength(1);
    const report = await tax.report(merchant, window);
    expect(report.rows).toEqual([
      expect.objectContaining({
        country: 'NL',
        scheme: 'eu_oss_non_union',
        collection: 'collect',
        rate_percentage: '20.0',
        transactions: 1,
        taxable_amount: '1000',
        tax_amount: '200',
      }),
    ]);
    const lines = must(
      await invoiceTaxLines(gatewayDb(), merchant.id, quote.quote.tax_rate_evidence_id),
    );
    expect(lines.map((line) => [line.taxable_minor_units, line.tax_minor_units])).toEqual([
      ['1000', '200'],
    ]);

    // A FairCoin refund from the seller's wallet: reversed in part, by its
    // reference once, then the rest; the report nets both.
    const sale = must(list.data[0]);
    const half = await tax.createReversal(merchant, sale.id, {
      reference: 'refund_1',
      amount: '600',
    });
    expect(half).toMatchObject({
      type: 'reversal',
      reversal_of: sale.id,
      reversal: { amount_total: '-600', amount_net: '-500', tax_amount: '-100' },
    });
    // The reversal's lines are the wire's own shape, scaled: no unscaled
    // original amounts and no second spelling beside them.
    const reversedLine = must(half.reversal?.line_items[0]);
    expect(reversedLine).toMatchObject({ amount: '-500', amount_tax: '-100', amount_net: '-500' });
    expect(reversedLine).not.toHaveProperty('amountTax');
    expect(reversedLine.breakdown[0]).toMatchObject({ taxable_amount: '-500', amount: '-100' });
    expect(reversedLine.breakdown[0]).not.toHaveProperty('taxableAmount');
    expect(
      await tax.createReversal(merchant, sale.id, { reference: 'refund_1', amount: '600' }),
    ).toMatchObject({ id: half.id });
    await tax.createReversal(merchant, sale.id, { reference: 'refund_2' });
    expect((await tax.report(merchant, window)).rows).toEqual([
      expect.objectContaining({
        transactions: 1,
        reversals: 2,
        taxable_amount: '0',
        tax_amount: '0',
      }),
    ]);
  });
});

describe('Stripe Tax provider', () => {
  it('asks the Calculation API with a billing address and maps the breakdown', async () => {
    let sent: Record<string, unknown> | undefined;
    const api = {
      calculations: {
        create: async (params: Record<string, unknown>) => {
          sent = params;
          return {
            id: 'taxcalc_1',
            currency: 'usd',
            livemode: false,
            expires_at: 1_900_000_000,
            line_items: {
              has_more: false,
              data: [
                {
                  reference: 'p',
                  amount: 1000,
                  amount_tax: 89,
                  tax_behavior: 'exclusive',
                  tax_breakdown: [
                    {
                      amount: 89,
                      taxable_amount: 1000,
                      taxability_reason: 'standard_rated',
                      jurisdiction: {
                        country: 'US',
                        state: 'NY',
                        level: 'state',
                        display_name: 'New York',
                      },
                      tax_rate_details: { tax_type: 'sales_tax', percentage_decimal: '8.875' },
                    },
                  ],
                },
              ],
            },
          };
        },
      },
      registrations: {},
      settings: {},
    } as unknown as StripeTaxApi;
    const provider = createStripeTaxProvider(api, false);
    const result = await provider.calculate({
      currency: 'USD',
      customer: { country: 'US', state: 'NY', postal_code: '10001' },
      shipFrom: null,
      lineItems: [
        {
          reference: 'p',
          amount: 1000n,
          quantity: 1,
          taxCode: 'txcd_10103000',
          taxBehavior: 'exclusive',
        },
      ],
      idempotencyKey: 'k',
    });
    expect(sent).toMatchObject({
      currency: 'usd',
      customer_details: {
        address: { country: 'US', state: 'NY', postal_code: '10001' },
        address_source: 'billing',
      },
      line_items: [{ amount: 1000, tax_code: 'txcd_10103000', tax_behavior: 'exclusive' }],
    });
    expect(result.lineItems[0]).toMatchObject({
      amount: 1000n,
      amountTax: 89n,
      breakdown: [
        {
          state: 'NY',
          rate_percentage: '8.875',
          taxable_amount: '1000',
          amount: '89',
          taxability_reason: 'standard_rated',
        },
      ],
    });
  });
});
