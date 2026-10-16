import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type Stripe from 'stripe';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  useGatewayDatabase,
} from '../../../__tests__/helpers/gatewayTestDatabase';
import { bindBillingObject } from '../../../db/billing/billingRepository';
import { billingRenewalTaxes, taxTransactions } from '../../../db/schema';
import { STRIPE_API_VERSION } from '../../providers/stripe/client';
import type { TaxProvider } from '../../tax/provider';
import { createTaxService } from '../../tax/taxService';
import { configureBillingRuntime } from '../configuredBilling';
import type { StripeBillingClient } from '../stripeBillingProvider';
import { PEABLE_TAX_STRIPE_EVENTS } from '../stripeInvoiceTax';

/** A tax provider charging a flat rate (20% unless a test changes it). */
let vatRate = 20;
const provider: TaxProvider = {
  id: 'fake_tax',
  livemode: true,
  status: async () => ({ active: true, headOffice: null, missing: [] }),
  ensureHeadOffice: async () => {},
  syncRegistration: async () => ({ providerRef: 'taxreg_provider' }),
  calculate: async (input) => ({
    providerRef: 'taxcalc_provider',
    livemode: true,
    expiresAt: null,
    lineItems: input.lineItems.map((line) => {
      const amountTax = Math.round((line.amount * vatRate) / 100);
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
            ratePercentage: `${vatRate}.0`,
            taxableAmount: line.amount,
            amount: amountTax,
            inclusive: false,
            taxabilityReason: 'standard_rated',
          },
        ],
      };
    }),
  }),
};

describe.skipIf(!POSTGRES_TESTS_ENABLED)('Peable Tax on the card rail / real PostgreSQL', () => {
  useGatewayDatabase();

  it('charges the frozen quote, reprices each renewal before it finalizes, commits each paid invoice once and reverses refunds', async () => {
    vatRate = 20;
    const merchant = await seedMerchant({ environment: 'production', network: 'mainnet' });
    const owner = {
      merchantId: merchant.id,
      oxyAppId: merchant.oxyAppId,
      environment: merchant.environment,
    };
    const tax = createTaxService({ db: gatewayDb(), provider });
    await tax.updateSettings(merchant, {
      legalName: 'Seller, Inc.',
      headOffice: { country: 'US' },
    });
    await tax.createRegistration(merchant, { country: 'IE', scheme: 'eu_oss_non_union' });
    await tax.approve(merchant, { userId: 'owner', officialApplication: true });
    const evidence = await tax.recordEvidence(merchant, {
      customerRef: 'store:one',
      evidence: [
        { type: 'billing_address', address: { country: 'DE' } },
        { type: 'payment_method_country', country: 'DE' },
      ],
    });

    const seconds = Math.floor(Date.now() / 1000);
    const calls: Record<string, unknown[]> = {};
    const record = (name: string, value: unknown) => {
      calls[name] = [...(calls[name] ?? []), value];
    };
    let rate = 0;
    const rates: Record<string, number> = {};
    const paidInvoice = (id: string, total: number, net: number, reason: string) => ({
      id,
      billing_reason: reason,
      customer: 'cus_one',
      livemode: true,
      status: 'paid',
      auto_advance: false,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      currency: 'usd',
      total,
      amount_paid: total,
      amount_due: total,
      amount_remaining: 0,
      total_excluding_tax: net,
      automatic_tax: { enabled: false },
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_one' } },
    });
    const invoices: Record<string, Record<string, unknown>> = {
      in_one: paidInvoice('in_one', 3599, 2999, 'subscription_create'),
    };
    const lineFor = (invoiceId: string, start: number) => ({
      id: `il_${invoiceId}`,
      invoice: invoiceId,
      livemode: true,
      subscription: 'sub_one',
      quantity: 1,
      amount: 2999,
      parent: {
        type: 'subscription_item_details',
        subscription_item_details: { subscription: 'sub_one', proration: false },
      },
      pricing: { price_details: { price: 'price_one' } },
      period: { start, end: start + 30 * 86_400 },
    });
    const line = lineFor('in_one', seconds - 60);
    const lines: Record<string, ReturnType<typeof lineFor>> = { in_one: line };
    const refunds: Record<string, { id: string; amount: number; status: string }[]> = {};
    // `in_two` is paid by `pi_two` through `ch_two`.
    const suffix = (id: string) => id.replace(/^[a-z]+_/, '');
    const intentFor = (invoiceId: string) => {
      const total = invoices[invoiceId]?.total as number;
      const refunded = (refunds[`ch_${suffix(invoiceId)}`] ?? []).reduce(
        (sum, r) => sum + r.amount,
        0,
      );
      return {
        id: `pi_${suffix(invoiceId)}`,
        customer: 'cus_one',
        livemode: true,
        currency: 'usd',
        status: 'succeeded',
        amount_received: total,
        latest_charge: {
          id: `ch_${suffix(invoiceId)}`,
          payment_intent: `pi_${suffix(invoiceId)}`,
          customer: 'cus_one',
          currency: 'usd',
          livemode: true,
          paid: true,
          captured: true,
          amount_captured: total,
          amount_refunded: refunded,
          refunded: refunded === total,
          disputed: false,
        },
      };
    };
    const client: StripeBillingClient = {
      scope: 'platform',
      apiVersion: STRIPE_API_VERSION,
      livemode: true,
      account: async () => ({ id: 'acct_platform' }),
      createCustomer: async () => ({ id: 'cus_one', livemode: true }),
      async createTaxRate(params: Stripe.TaxRateCreateParams) {
        record('taxRate', params);
        rate = params.percentage;
        const id = `txr_${Object.keys(rates).length + 1}`;
        rates[id] = params.percentage;
        return { id, livemode: true, active: true, ...params };
      },
      retrieveWebhookEndpoint: async (id) => ({
        id,
        status: 'enabled',
        livemode: true,
        api_version: STRIPE_API_VERSION,
        url: 'https://api.peable.to/v1/webhooks/stripe',
        enabled_events: [...PEABLE_TAX_STRIPE_EVENTS],
      }),
      async updateInvoice(id, params) {
        record('updateInvoice', [id, params]);
        const invoice = invoices[id];
        if (invoice && params.auto_advance !== undefined)
          invoice.auto_advance = params.auto_advance;
        return invoice;
      },
      async updateInvoiceLine(id, _line, params) {
        record('updateLine', [id, params]);
        // What Stripe recomputes for the draft from the line's manual rate.
        const [txr] = Array.isArray(params.tax_rates) ? params.tax_rates : [];
        const amountTax = txr ? Math.round((2999 * (rates[txr] ?? 0)) / 100) : 0;
        const invoice = invoices[id];
        if (invoice) Object.assign(invoice, { total: 2999 + amountTax, total_excluding_tax: 2999 });
        return {};
      },
      retrievePaymentMethod: async (id) => ({
        id,
        customer: 'cus_one',
        card: { country: 'DE' },
        billing_details: { address: { country: 'DE' } },
      }),
      listInvoiceCreditNotes: async () => ({ has_more: false, data: [] }),
      async createCheckout(params) {
        record('checkout', params);
        // What Stripe computes from the bound price and the manual rate.
        const amountTax = Math.round((2999 * rate) / 100);
        return {
          id: 'cs_live_one',
          customer: 'cus_one',
          mode: 'subscription',
          livemode: true,
          url: 'https://checkout.stripe.com/c/one',
          expires_at: params.expires_at,
          currency: 'usd',
          amount_total: 2999 + amountTax,
          total_details: { amount_tax: amountTax },
          automatic_tax: { enabled: false },
        };
      },
      expireCheckout: async (ref) => record('expire', ref),
      createPortal: async () => ({}),
      retrievePortalConfiguration: async () => ({
        id: 'bpc_one',
        active: true,
        livemode: true,
        features: {
          subscription_update: { enabled: false },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
        },
      }),
      retrieveSubscription: async () => ({
        default_payment_method: 'pm_one',
        id: 'sub_one',
        customer: 'cus_one',
        livemode: true,
        status: 'active',
        cancel_at_period_end: false,
        trial_end: null,
        cancel_at: null,
        canceled_at: null,
        latest_invoice: 'in_one',
        items: {
          has_more: false,
          data: [
            {
              current_period_start: line.period.start,
              current_period_end: line.period.end,
              quantity: 1,
              price: { id: 'price_one', recurring: { interval: 'month', interval_count: 1 } },
            },
          ],
        },
      }),
      updateSubscription: async () => ({}),
      retrieveCustomer: async (id) => ({
        id,
        address: { country: 'DE', postal_code: '10115', city: 'Berlin', line1: 'Street 1' },
        invoice_settings: { default_payment_method: 'pm_one' },
      }),
      retrievePrice: async (id) => ({
        id,
        livemode: true,
        active: true,
        currency: 'usd',
        unit_amount: 2999,
        recurring: { interval: 'month', interval_count: 1 },
      }),
      retrieveCheckout: async (id) => ({
        id,
        customer: 'cus_one',
        mode: 'subscription',
        livemode: true,
        status: 'complete',
        subscription: 'sub_one',
      }),
      listCheckoutsForSubscription: async () => ({
        has_more: false,
        data: [{ id: 'cs_live_one' }],
      }),
      listSubscriptionInvoices: async () => ({
        has_more: false,
        data: Object.values(invoices),
      }),
      retrieveInvoice: async (id) => structuredClone(invoices[id]),
      listInvoiceLines: async (id) => ({ has_more: false, data: [lines[id]] }),
      listInvoicePayments: async (id) => ({
        has_more: false,
        data: [
          {
            id: `inpay_${suffix(id)}`,
            invoice: id,
            livemode: true,
            currency: 'usd',
            status: 'paid',
            amount_paid: invoices[id]?.total,
            payment: { type: 'payment_intent', payment_intent: `pi_${suffix(id)}` },
            status_transitions: { paid_at: seconds - 30 },
          },
        ],
      }),
      retrievePaidPaymentIntent: async (id) => intentFor(`in_${suffix(id)}`),
      listChargeRefunds: async (charge) => ({
        has_more: false,
        data: (refunds[charge] ?? []).map((refund) => ({
          ...refund,
          charge,
          payment_intent: `pi_${suffix(charge)}`,
          currency: 'usd',
        })),
      }),
    };

    const keys = generateKeyPairSync('ed25519');
    const runtime = await configureBillingRuntime(
      gatewayDb(),
      JSON.stringify({
        rail: 'stripe',
        deployment: { provider: 'stripe', platformAccountId: 'acct_platform', livemode: true },
        portalConfigurationRef: 'bpc_one',
        taxQuoteAdapterRef: 'peable_tax',
        invoiceSigningKeyId: 'peable-test',
        webhookEndpointRef: 'we_peable',
        cohorts: [
          {
            ...owner,
            evidenceRef: 'fixture:cohort',
            offers: [
              {
                providerPriceId: 'price_one',
                planId: 'one',
                offerId: 'one_monthly',
                offerVersion: 1,
                interval: 'month',
                intervalCount: 1,
                currency: 'USD',
                grossMinorUnits: 2999,
                taxTreatment: 'exclusive',
              },
            ],
          },
        ],
      }),
      client,
      { taxService: tax, invoiceSigningKeys: { 'peable-test': keys.privateKey } },
    );
    if (!runtime?.invoiceTax) throw new Error('Peable Tax did not configure the card rail');
    const { service, invoiceTax } = runtime;

    const customer = await service.ensureCustomer(
      owner,
      { storeId: 'store:one', storeName: 'Store' },
      'customer:one',
    );
    await bindBillingObject(
      gatewayDb(),
      { provider: 'stripe', platformAccountId: 'acct_platform', livemode: true },
      owner,
      { kind: 'price', providerRef: 'price_one', planRef: 'one', bindingEvidenceRef: 'fixture' },
    );
    const quote = await service.createTaxQuote(owner, {
      rail: 'stripe',
      storeId: 'store:one',
      planId: 'one',
      providerPriceId: 'price_one',
      customerLocationEvidenceId: evidence.id,
    });
    expect(quote.quote).toMatchObject({
      grossMinorUnits: 3599,
      netMinorUnits: 2999,
      taxMinorUnits: 600,
      taxServiceRef: 'peable_tax',
      customerLocationEvidenceId: evidence.id,
    });
    expect(quote.quote.taxRateEvidenceId).toStartWith('taxcalc_');

    const session = await service.createCheckoutSession(
      owner,
      {
        ...customer,
        providerPriceId: 'price_one',
        trialDays: 0,
        returnUrl: 'https://example.invalid/billing',
        storeId: 'store:one',
        planId: 'one',
        taxQuote: quote,
      },
      'checkout:one',
    );
    expect(session.id).toBe('cs_live_one');
    expect(Date.parse(session.expiresAt)).toBeLessThanOrEqual(Date.parse(quote.quote.expiresAt));
    expect(calls.taxRate).toEqual([
      expect.objectContaining({ percentage: 20, inclusive: false, display_name: 'VAT' }),
    ]);
    expect(calls.checkout).toEqual([
      expect.objectContaining({
        automatic_tax: { enabled: false },
        line_items: [{ price: 'price_one', quantity: 1, tax_rates: ['txr_1'] }],
      }),
    ]);
    expect(calls.expire).toBeUndefined();

    // invoice.paid, delivered twice: one tax transaction.
    expect(await invoiceTax.recordPaidInvoice('in_one')).toBe('committed');
    expect(await invoiceTax.recordPaidInvoice('in_one')).toBe('committed');
    const committed = await gatewayDb().select().from(taxTransactions);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ reference: 'in_one', rail: 'stripe' });

    const authority = await service.retrieveFinalInvoiceAuthority(owner, 'sub_one', 'in_one', {
      taxLines: true,
    });
    expect(authority).toMatchObject({
      method: 'card',
      signature: { keyId: 'peable-test' },
      invoice: { grossMinorUnits: 3599, taxMinorUnits: 600, taxQuoteId: quote.quote.id },
    });
    expect(authority.invoice.taxLines?.reduce((sum, entry) => sum + entry.taxMinorUnits, 0)).toBe(
      600,
    );

    // The renewal: the rate changed, so the draft is held, repriced from fresh
    // evidence at 19% and released only once Stripe's totals are the quote.
    vatRate = 19;
    invoices.in_two = {
      ...paidInvoice('in_two', 3599, 2999, 'subscription_cycle'),
      status: 'draft',
      auto_advance: true,
    };
    lines.in_two = lineFor('in_two', line.period.end);
    expect(await invoiceTax.priceRenewalInvoice('in_two', 'cus_one')).toBe('priced');
    expect(await invoiceTax.priceRenewalInvoice('in_two', 'cus_one')).toBe('priced');
    expect(invoices.in_two).toMatchObject({ total: 3569, auto_advance: true });
    expect(calls.updateInvoice?.[0]).toEqual(['in_two', { auto_advance: false }]);
    expect(calls.updateLine).toEqual([['in_two', { tax_rates: ['txr_2'] }]]);
    expect(await gatewayDb().select().from(billingRenewalTaxes)).toHaveLength(1);
    // A customer that never bought through a quote costs no provider read.
    expect(await invoiceTax.priceRenewalInvoice('in_other', 'cus_other')).toBe('not_quoted');

    // Paid: the renewal commits its own calculation, and signs its own quote.
    Object.assign(invoices.in_two, { status: 'paid', amount_paid: 3569, amount_due: 3569 });
    expect(await invoiceTax.recordPaidInvoice('in_two')).toBe('committed');
    expect(await gatewayDb().select().from(taxTransactions)).toHaveLength(2);
    const renewal = await service.retrieveFinalInvoiceAuthority(owner, 'sub_one', 'in_two', {
      taxLines: true,
    });
    expect(renewal.invoice).toMatchObject({ grossMinorUnits: 3569, taxMinorUnits: 570 });
    expect(renewal.invoice.taxQuoteId).not.toBe(quote.quote.id);

    // Half refunded: the renewal's transaction is reversed by half, once.
    refunds.ch_two = [{ id: 're_one', amount: 1785, status: 'succeeded' }];
    expect(await invoiceTax.reconcileReversals({ paymentRef: 'pi_two' })).toBe('reversed');
    expect(await invoiceTax.reconcileReversals({ paymentRef: 'pi_two' })).toBe('unchanged');
    const window = {
      from: new Date(Date.now() - 3600_000).toISOString(),
      to: new Date(Date.now() + 3600_000).toISOString(),
    };
    const listed = await tax.listTransactions(merchant, window);
    const reversal = listed.data.find((row) => row.type === 'reversal');
    expect(reversal).toMatchObject({
      reference: 'in_two:reversal:1',
      reversal: { amountTotal: -1785, taxAmount: -285 },
    });
    expect(reversal?.reversalOf).toBe(listed.data.find((row) => row.reference === 'in_two')?.id);
    const report = await tax.report(merchant, window);
    expect(report.rows.find((row) => row.ratePercentage === '19.0')).toMatchObject({
      transactions: 1,
      reversals: 1,
      taxAmount: 285,
    });
  });
});
