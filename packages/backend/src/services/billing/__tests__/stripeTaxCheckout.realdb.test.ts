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
import { taxTransactions } from '../../../db/schema';
import { STRIPE_API_VERSION } from '../../providers/stripe/client';
import type { TaxProvider } from '../../tax/provider';
import { createTaxService } from '../../tax/taxService';
import { configureBillingRuntime } from '../configuredBilling';
import type { StripeBillingClient } from '../stripeBillingProvider';

/** A tax provider charging a flat 20%. */
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
      const amountTax = Math.round(line.amount * 0.2);
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
            ratePercentage: '20.0',
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

  it('charges the frozen quote on Stripe, commits it once when paid and signs its tax lines', async () => {
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
    const invoice = {
      id: 'in_one',
      billing_reason: 'subscription_create',
      customer: 'cus_one',
      livemode: true,
      status: 'paid',
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      currency: 'usd',
      total: 3599,
      amount_paid: 3599,
      amount_due: 3599,
      amount_remaining: 0,
      total_excluding_tax: 2999,
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_one' } },
    };
    const line = {
      id: 'il_one',
      invoice: 'in_one',
      livemode: true,
      subscription: 'sub_one',
      quantity: 1,
      amount: 2999,
      parent: {
        type: 'subscription_item_details',
        subscription_item_details: { subscription: 'sub_one', proration: false },
      },
      pricing: { price_details: { price: 'price_one' } },
      period: { start: seconds - 60, end: seconds + 30 * 86_400 },
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
        return { id: 'txr_one', livemode: true, active: true, ...params };
      },
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
      retrieveCustomer: async () => ({}),
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
      listSubscriptionInvoices: async () => ({ has_more: false, data: [invoice] }),
      retrieveInvoice: async () => invoice,
      listInvoiceLines: async () => ({ has_more: false, data: [line] }),
      listInvoicePayments: async () => ({
        has_more: false,
        data: [
          {
            id: 'inpay_one',
            invoice: 'in_one',
            livemode: true,
            currency: 'usd',
            status: 'paid',
            amount_paid: 3599,
            payment: { type: 'payment_intent', payment_intent: 'pi_one' },
            status_transitions: { paid_at: seconds - 30 },
          },
        ],
      }),
      retrievePaidPaymentIntent: async () => ({
        id: 'pi_one',
        customer: 'cus_one',
        livemode: true,
        currency: 'usd',
        status: 'succeeded',
        amount_received: 3599,
        latest_charge: {
          id: 'ch_one',
          payment_intent: 'pi_one',
          customer: 'cus_one',
          currency: 'usd',
          livemode: true,
          paid: true,
          captured: true,
          amount_captured: 3599,
          amount_refunded: 0,
          refunded: false,
          disputed: false,
        },
      }),
      listChargeRefunds: async () => ({ has_more: false, data: [] }),
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
        line_items: [{ price: 'price_one', quantity: 1, tax_rates: ['txr_one'] }],
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
  });
});
