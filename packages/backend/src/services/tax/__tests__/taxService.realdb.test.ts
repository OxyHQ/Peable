import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
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
              ? 0
              : line.taxBehavior === 'inclusive'
                ? line.amount - Math.round(line.amount / 1.2)
                : Math.round(line.amount * 0.2);
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
                displayName: 'VAT',
                taxType: 'vat',
                ratePercentage: answer === 'not_collecting' ? null : '20.0',
                taxableAmount: line.amount - (line.taxBehavior === 'inclusive' ? amountTax : 0),
                amount: amountTax,
                inclusive: line.taxBehavior === 'inclusive',
                taxabilityReason: answer,
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
  const tax = createTaxService({ db: gatewayDb(), provider });
  await tax.updateSettings(merchant, {
    legalName: 'Example Seller, Inc.',
    headOffice: { country: 'US', state: 'DE' },
    defaultTaxCode: 'txcd_10103000',
  });
  await tax.createRegistration(merchant, { country: 'IE', scheme: 'eu_oss_non_union' });
  const approved = await tax.approve(merchant, { userId: 'owner_1', officialApplication: true });
  return { merchant, tax, approved };
}
const euEvidence = (country: string) => ({
  customerRef: 'acct_payer',
  evidence: [
    { type: 'billing_address', address: { country } },
    { type: 'payment_method_country', country },
  ],
});

describe('Peable Tax', () => {
  it('approval activates settings and mirrors registrations to the provider', async () => {
    const { provider, synced } = fakeProvider();
    const { approved } = await approvedMerchant(provider);
    expect(approved.settings).toMatchObject({ status: 'active', calculationAccount: 'platform' });
    expect(approved.registrations[0]).toMatchObject({
      status: 'active',
      providerRegistrationRef: 'taxreg_provider_1',
    });
    expect(synced).toEqual(['IE:eu_oss_non_union']);
  });

  it('a registration needs a provider: a third-party app cannot approve one', async () => {
    const merchant = await seedMerchant({ environment: 'production', network: 'mainnet' });
    const tax = createTaxService({ db: gatewayDb(), provider: fakeProvider().provider });
    await tax.updateSettings(merchant, { legalName: 'X', headOffice: { country: 'US' } });
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
        customerLocationEvidenceId: de.id,
        lineItems: [{ reference: 'one_monthly', amount: 2999, taxBehavior: 'inclusive' }],
      },
      { requireActive: true },
    );
    expect(inclusive).toMatchObject({
      collection: 'collect',
      amountTotal: 2999,
      taxAmountInclusive: 2999 - 2499,
      amountNet: 2499,
    });
    expect(calls[0]?.lineItems[0]?.taxCode).toBe('txcd_10103000');
    expect(await tax.retrieveCalculation(merchant, inclusive.id)).toEqual(inclusive);

    const exclusive = await tax.calculate(
      merchant,
      {
        currency: 'USD',
        customerLocationEvidenceId: de.id,
        lineItems: [{ reference: 'seat', amount: 1000, taxBehavior: 'exclusive' }],
      },
      { requireActive: true },
    );
    expect(exclusive).toMatchObject({
      amountTotal: 1200,
      amountNet: 1000,
      taxAmountExclusive: 200,
    });

    const jp = await tax.recordEvidence(merchant, {
      customerRef: 'acct_payer',
      evidence: [{ type: 'billing_address', address: { country: 'JP' } }],
    });
    const before = calls.length;
    const unregistered = await tax.calculate(
      merchant,
      {
        currency: 'USD',
        customerLocationEvidenceId: jp.id,
        lineItems: [{ reference: 'one_monthly', amount: 2999, taxBehavior: 'inclusive' }],
      },
      { requireActive: true },
    );
    expect(calls.length).toBe(before);
    expect(unregistered).toMatchObject({
      collection: 'not_registered',
      amountTotal: 2999,
      amountNet: 2999,
      registrationId: null,
    });
    expect(unregistered.lineItems[0]?.breakdown[0]?.taxabilityReason).toBe('not_registered');
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
            customerLocationEvidenceId: evidence.id,
            lineItems: [{ reference: 'p', amount: 500 }],
          },
          { requireActive: true },
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('refuses to price a sale before approval or on insufficient evidence', async () => {
    const merchant = await seedMerchant({ environment: 'production', network: 'mainnet' });
    const tax = createTaxService({ db: gatewayDb(), provider: fakeProvider().provider });
    const one = await tax.recordEvidence(merchant, {
      customerRef: 'c',
      evidence: [{ type: 'billing_address', address: { country: 'DE' } }],
    });
    const request = {
      currency: 'USD',
      customerLocationEvidenceId: one.id,
      lineItems: [{ reference: 'p', amount: 500 }],
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
      customerRef: 'store_1',
    });
    const quote = await createVerifiedBillingTaxQuote(calculator, owner, merchant.publicId, {
      storeId: 'store_1',
      planId: 'one_monthly',
      customerLocationEvidenceId: evidence.id,
    });
    // Exclusive: the listed price is the net; the payer pays price plus tax.
    expect(quote.quote).toMatchObject({
      netMinorUnits: 1000,
      taxMinorUnits: 200,
      grossMinorUnits: 1200,
      taxTreatment: 'exclusive',
      country: 'NL',
      taxServiceRef: 'peable_tax',
    });
    expect(quote.quote.taxRateEvidenceId).toMatch(/^taxcalc_/);
    expect(quote.quote.coverageEvidenceId).toMatch(/^taxreg_/);
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
    tampered.quote.taxMinorUnits = 100;
    tampered.quote.grossMinorUnits = 1100;
    expect(() =>
      verifyBillingTaxQuote(
        tampered,
        { source: quote.source, product, location },
        calculator.verificationKeys,
        new Date(),
      ),
    ).toThrow();

    await commitTaxTransaction(gatewayDb(), {
      calculationPublicId: quote.quote.taxRateEvidenceId,
      reference: 'in_fair_1',
      rail: 'faircoin',
      committedAt: new Date(),
    });
    // Idempotent: the same payment observed twice is one transaction.
    await commitTaxTransaction(gatewayDb(), {
      calculationPublicId: quote.quote.taxRateEvidenceId,
      reference: 'in_fair_1',
      rail: 'faircoin',
      committedAt: new Date(),
    });
    const window = {
      from: new Date(Date.now() - 3600_000).toISOString(),
      to: new Date(Date.now() + 3600_000).toISOString(),
    };
    const list = await tax.listTransactions(merchant, window);
    expect(list.data).toHaveLength(1);
    const report = await tax.report(merchant, window);
    expect(report.rows).toEqual([
      expect.objectContaining({
        country: 'NL',
        scheme: 'eu_oss_non_union',
        collection: 'collect',
        ratePercentage: '20.0',
        transactions: 1,
        taxableAmount: 1000,
        taxAmount: 200,
      }),
    ]);
    const lines = must(
      await invoiceTaxLines(gatewayDb(), merchant.id, quote.quote.taxRateEvidenceId),
    );
    expect(lines.reduce((sum, line) => sum + line.taxMinorUnits, 0)).toBe(200);
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
      customer: { country: 'US', state: 'NY', postalCode: '10001' },
      shipFrom: null,
      lineItems: [
        {
          reference: 'p',
          amount: 1000,
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
      amountTax: 89,
      breakdown: [{ state: 'NY', ratePercentage: '8.875', taxabilityReason: 'standard_rated' }],
    });
  });
});
