/**
 * Quotes (`qt_…`, ADR 0018 §5) over HTTP, against a real Postgres, with the
 * billing engine's recording fake card provider, a fake Peable Tax provider
 * and TEST CLOCKS driving time.
 *
 * Pinned: the lifecycle (draft → open → accepted | canceled) and its events;
 * totals equal to the catalog's pricing; tax failing closed at finalize;
 * acceptance making a one-time invoice, or a subscription whose first invoice
 * also carries the one-time lines, in the quote's own transaction; a double
 * accept producing ONE of each; expiry on the customer's clock; FairCoin
 * quotes sent, never debited; gapless quote numbers and the PDF.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { WebhookEventType } from '@peable.to/shared-types';
import type { ProviderMode, ProviderPaymentResult } from '../../services/providers/provider';

// A test-clock advance runs months of renewals and dunning in one request.
setDefaultTimeout(30_000);

// ---- The fake card provider -------------------------------------------------------

const payments = new Map<string, ProviderPaymentResult & { amount: string }>();
/** How the next confirms answer, consumed in order; `succeed` when empty. */
const confirmPlan: ('succeed' | 'decline' | 'action')[] = [];
const providerCalls: string[] = [];
let counter = 0;

function fakeCardProvider(mode: ProviderMode) {
  return {
    id: 'stripe' as const,
    createPayment: async (request: {
      intentId: string;
      amount: { amount: string };
      paymentMethodObjectId?: string;
    }) => {
      providerCalls.push(`${mode}:createPayment:${request.amount.amount}`);
      const id = `pi_fake_${++counter}`;
      const result = {
        providerObjectId: id,
        status: request.paymentMethodObjectId
          ? ('requires_confirmation' as const)
          : ('requires_payment_method' as const),
        clientAction: { kind: 'client_secret' as const, value: `${id}_secret` },
        amount: request.amount.amount,
      };
      payments.set(id, result);
      return result;
    },
    confirm: async (request: { providerObjectId: string }) => {
      const outcome = confirmPlan.shift() ?? 'succeed';
      providerCalls.push(`${mode}:confirm:${outcome}`);
      const stored = payments.get(request.providerObjectId);
      if (!stored) throw new Error('no such fake payment');
      const result =
        outcome === 'succeed'
          ? {
              ...stored,
              status: 'succeeded' as const,
              chargeObjectId: `ch_${request.providerObjectId}`,
            }
          : outcome === 'action'
            ? { ...stored, status: 'requires_action' as const }
            : {
                ...stored,
                status: 'requires_payment_method' as const,
                lastPaymentError: {
                  type: 'card_error' as const,
                  code: 'card_declined',
                  declineCode: 'insufficient_funds',
                },
              };
      payments.set(request.providerObjectId, result);
      return result;
    },
    capture: async () => {
      throw new Error('not used');
    },
    cancel: async (request: { providerObjectId: string }) => {
      providerCalls.push(`${mode}:cancel`);
      const stored = payments.get(request.providerObjectId);
      const result = {
        ...(stored ?? { providerObjectId: request.providerObjectId, amount: '0' }),
        status: 'canceled' as const,
      };
      payments.set(request.providerObjectId, result);
      return result;
    },
    refund: async (request: { amount: { amount: string } }) => {
      providerCalls.push(`${mode}:refund:${request.amount.amount}`);
      return { providerObjectId: `re_fake_${++counter}`, state: 'succeeded' as const };
    },
    getStatus: async (id: string) => {
      const stored = payments.get(id);
      if (!stored) throw new Error(`no payment ${id}`);
      return stored;
    },
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createCustomer: async () => ({ providerObjectId: `cus_fake_${++counter}` }),
  };
}

const fakes = { test: fakeCardProvider('test'), live: fakeCardProvider('live') };
const realRegistry = await import('../../services/providers/registry');
const { resolveProvider: realResolveProvider, resolveCardProvider: realResolveCardProvider } =
  realRegistry;
// Module mocks outlive the file in a bun run, so the fakes answer only while
// this suite runs; every other suite sees the real registry.
let useFakes = false;
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFakes ? fakes[mode] : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFakes ? fakes[mode] : realResolveCardProvider(mode),
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createGateway } = await import('../../server');
const { gatewayDb, seedMerchant, storedEvents, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { must } = await import('../../__tests__/helpers/must');
const { exclusiveTaxOf, inclusiveTaxOf } = await import('../../__tests__/helpers/fakeTax');
const { registerPaymentMethod } = await import('../../db/customers/paymentMethodRepository');
const { findCustomerForMerchant } = await import('../../db/customers/customerRepository');
const { createTaxService } = await import('../../services/tax/taxService');
const { TaxProviderUnavailableError } = await import('../../services/tax/provider');
const { MemoryMailer } = await import('../../services/email/mailer');
const { dispatchCustomerEmails } = await import('../../services/email/dispatcher');
type MerchantRow = import('../../db/merchants/merchantRepository').MerchantRow;
type TaxProvider = import('../../services/tax/provider').TaxProvider;

// ---- The fake tax provider ----------------------------------------------------------

let taxDown = false;
const taxProvider: TaxProvider = {
  id: 'fake_tax',
  livemode: false,
  async status() {
    return { active: true, headOffice: null, missing: [] };
  },
  async ensureHeadOffice() {},
  async syncRegistration() {
    return { providerRef: 'taxreg_fake' };
  },
  async calculate(input) {
    if (taxDown) throw new TaxProviderUnavailableError('timeout');
    return {
      providerRef: 'taxcalc_fake',
      livemode: false,
      expiresAt: null,
      lineItems: input.lineItems.map((line) => {
        const amountTax =
          line.taxBehavior === 'inclusive'
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
              rate_percentage: '20.0',
              taxable_amount: line.amount.toString(),
              amount: amountTax.toString(),
              inclusive: line.taxBehavior === 'inclusive',
              taxability_reason: 'standard_rated',
            },
          ],
        };
      }),
    };
  },
};

// ---- The gateway -------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: wire JSON read by many assertions
type Json = Record<string, any>;
let appId = 'app_quotes';
let baseUrl = '';
let gateway: ReturnType<typeof createGateway> | undefined;
let merchant: MerchantRow;
const mailer = new MemoryMailer();
let restoreModes: () => void = () => undefined;

/** The application owner the stub credential names — whose Peable wallet receives. */
const stubOwner = 'owner';

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId,
    appName: 'billing',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: stubOwner,
    environment: 'development',
    tier: 'internal',
  };
  next();
};

useGatewayDatabase();

beforeAll(() => {
  useFakes = true;
  restoreModes = setStripeModes({ test: stripeModeFixture('test') });
  const tax = createTaxService({ db: gatewayDb(), providers: [taxProvider] });
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
    publicRateLimit: (_req, _res, next) => next(),
    taxService: tax,
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  useFakes = false;
  gateway?.httpServer.close();
  gateway?.watcher.stop();
  restoreModes();
});

beforeEach(async () => {
  appId = `app_qt_${++counter}`;
  merchant = await seedMerchant({ oxyAppId: appId, environment: 'development' });
  confirmPlan.length = 0;
  taxDown = false;
  // What earlier cases owed is sent (and forgotten) before this one starts.
  await dispatchCustomerEmails(mailer);
  mailer.sent.length = 0;
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Json) : {} };
}

async function ok(method: string, path: string, body?: unknown): Promise<Json> {
  const answer = await call(method, path, body);
  if (answer.status !== 200 && answer.status !== 201) {
    throw new Error(`${method} ${path} → ${answer.status} ${JSON.stringify(answer.json)}`);
  }
  return answer.json;
}

const DAY = 86_400;
const T0 = Date.UTC(2027, 0, 15, 12) / 1000;

async function clock(at = T0): Promise<Json> {
  return ok('POST', '/v1/test_helpers/test_clocks', { frozen_time: at, name: 'engine' });
}

async function advance(clockId: string, to: number): Promise<Json> {
  const advanced = await ok('POST', `/v1/test_helpers/test_clocks/${clockId}/advance`, {
    frozen_time: to,
  });
  expect(advanced.status).toBe('ready');
  return advanced;
}

/** A customer on `clockId` with a saved card as its default (and a billing address for tax). */
async function customer(
  clockId: string | null,
  options: { card?: boolean; country?: string } = {},
): Promise<Json> {
  const created = await ok('POST', '/v1/customers', {
    email: 'payer@example.test',
    name: 'Payer',
    address:
      options.country === 'US'
        ? {
            country: 'US',
            state: 'CA',
            line1: '1 Market St',
            city: 'San Francisco',
            postal_code: '94105',
          }
        : {
            country: options.country ?? 'IE',
            line1: '1 Main St',
            city: 'Dublin',
            postal_code: 'D01',
          },
    ...(clockId ? { test_clock: clockId } : {}),
  });
  if (options.card === false) return created;
  const row = must(await findCustomerForMerchant(gatewayDb(), created.id, merchant.id));
  const { row: method } = await registerPaymentMethod(gatewayDb(), {
    publicId: `pm_${counter++}fake${Date.now()}`,
    merchantId: merchant.id,
    customerId: row.id,
    card: {
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: 2030,
      country: options.country ?? 'IE',
      funding: 'credit',
    },
    billingDetails: { address: null, email: null, name: null, phone: null },
    provider: 'stripe',
    providerObjectId: `pm_provider_${++counter}`,
  });
  return ok('POST', `/v1/customers/${created.id}`, {
    invoice_settings: { default_payment_method: method.publicId },
  });
}

async function price(
  unitAmount: string,
  options: { currency?: string; interval?: string; product?: string; meter?: string } = {},
): Promise<Json> {
  const product =
    options.product ?? (await ok('POST', '/v1/products', { name: `Plan ${unitAmount}` })).id;
  return ok('POST', '/v1/prices', {
    product,
    currency: options.currency ?? 'EUR',
    unit_amount: unitAmount,
    recurring: {
      interval: options.interval ?? 'month',
      ...(options.meter ? { usage_type: 'metered', meter: options.meter } : {}),
    },
  });
}

async function invoices(subscription: string): Promise<Json[]> {
  const list = await ok('GET', `/v1/invoices?subscription=${subscription}&limit=100`);
  return (list.data as Json[]).reverse();
}

async function eventTypes(): Promise<WebhookEventType[]> {
  return (await storedEvents({ merchantId: merchant.id })).map(({ row }) => row.type);
}

/** Approve Peable Tax for the merchant, registered in Ireland. */
async function approveTax(): Promise<void> {
  const tax = createTaxService({ db: gatewayDb(), providers: [taxProvider] });
  await tax.updateSettings(merchant, {
    legal_name: 'Seller Ltd',
    head_office: { country: 'IE' },
    default_tax_code: 'txcd_10103000',
    default_tax_behavior: 'exclusive',
  });
  await tax.createRegistration(merchant, { country: 'IE', scheme: 'standard' });
  await tax.approve(merchant, { userId: 'owner', officialApplication: true });
}

// ---- Quotes ------------------------------------------------------------------------------

async function oneTime(unitAmount: string, options: { currency?: string; name?: string } = {}) {
  const product = (await ok('POST', '/v1/products', { name: options.name ?? `Item ${unitAmount}` }))
    .id;
  return ok('POST', '/v1/prices', {
    product,
    currency: options.currency ?? 'EUR',
    unit_amount: unitAmount,
  });
}

async function quoteEvents(): Promise<WebhookEventType[]> {
  return (await eventTypes()).filter((type) => type.startsWith('quote.'));
}

describe('a one-time quote', () => {
  test('draft → open → accepted: an invoice priced like the quote, paid with the saved card', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const setup = await oneTime('50000', { name: 'Setup' });
    const hours = await oneTime('12000', { name: 'Consulting hour' });
    const draft = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: setup.id }],
      header: 'Implementation',
      metadata: { deal: 'D-1' },
    });
    expect(draft).toMatchObject({
      object: 'quote',
      status: 'draft',
      number: null,
      currency: 'EUR',
      collection_method: 'charge_automatically',
      amount_subtotal: '50000',
      amount_total: '50000',
      total_details: { amount_discount: '0', amount_shipping: '0', amount_tax: '0' },
      expires_at: T0 + 30 * DAY,
      test_clock: tc.id,
      invoice: null,
      subscription: null,
    });
    // Only a draft's lines move; `line_items` replaces them all.
    const edited = await ok('POST', `/v1/quotes/${draft.id}`, {
      line_items: [{ price: setup.id }, { price: hours.id, quantity: 3 }],
    });
    expect(edited).toMatchObject({ amount_subtotal: '86000', amount_total: '86000' });
    const lines = await ok('GET', `/v1/quotes/${draft.id}/line_items`);
    expect(
      (lines.data as Json[]).map((line) => [line.description, line.quantity, line.amount_total]),
    ).toEqual([
      ['Setup', 1, '50000'],
      ['Consulting hour', 3, '36000'],
    ]);
    expect(lines.data[1]).toMatchObject({ object: 'item', price: hours.id, unit_amount: '12000' });

    const open = await ok('POST', `/v1/quotes/${draft.id}/finalize`, {});
    expect(open.status).toBe('open');
    expect(open.number).toMatch(/^QT-[0-9A-F]+-0001$/);
    expect(open.status_transitions.finalized_at).toBe(T0);
    const refused = await call('POST', `/v1/quotes/${draft.id}`, { header: 'Changed' });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('quote_not_editable');
    // Metadata moves on any quote.
    expect(
      (await ok('POST', `/v1/quotes/${draft.id}`, { metadata: { stage: 'sent' } })).metadata,
    ).toEqual({ deal: 'D-1', stage: 'sent' });

    const accepted = await ok('POST', `/v1/quotes/${draft.id}/accept`, {
      expand: ['invoice'],
    });
    expect(accepted).toMatchObject({ status: 'accepted', subscription: null });
    expect(accepted.status_transitions.accepted_at).toBe(T0);
    expect(accepted.invoice).toMatchObject({
      billing_reason: 'quote_accept',
      customer: payer.id,
      status: 'paid',
      subtotal: '86000',
      total: '86000',
      amount_paid: '86000',
    });
    expect(
      (accepted.invoice.lines.data as Json[]).map((line) => [
        line.type,
        line.quantity,
        line.amount,
      ]),
    ).toEqual([
      ['invoiceitem', 1, '50000'],
      ['invoiceitem', 3, '36000'],
    ]);
    expect(await quoteEvents()).toEqual(['quote.created', 'quote.finalized', 'quote.accepted']);

    const again = await call('POST', `/v1/quotes/${draft.id}/accept`, {});
    expect(again.json.error.code).toBe('quote_unexpected_state');
    const cancel = await call('POST', `/v1/quotes/${draft.id}/cancel`, {});
    expect(cancel.json.error.code).toBe('quote_unexpected_state');
    const listed = await ok('GET', `/v1/quotes?customer=${payer.id}&status=accepted`);
    expect((listed.data as Json[]).map((quote) => quote.id)).toEqual([draft.id]);
  });

  test('totals are the catalog pricing and the discount split, never re-derived', async () => {
    const payer = await customer(null);
    const product = (await ok('POST', '/v1/products', { name: 'Seats' })).id;
    const tiered = await ok('POST', '/v1/prices', {
      product,
      currency: 'EUR',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: 5, unit_amount: '1000' },
        { up_to: 'inf', unit_amount: '750', flat_amount: '99' },
      ],
    });
    const extra = await oneTime('333');
    const coupon = await ok('POST', '/v1/coupons', { percent_off: 12.5, duration: 'once' });
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [
        { price: tiered.id, quantity: 8 },
        { price: extra.id, quantity: 3 },
      ],
      discounts: [{ coupon: coupon.id }],
    });
    const { amountForQuantity, discountAmount } = await import('../../services/catalog/pricing');
    const { pricingCouponOf, pricingPriceOf } = await import('../../services/catalog/pricingRows');
    const { findPriceForMerchant } = await import('../../db/catalog/priceRepository');
    const { findCouponForMerchant } = await import('../../db/catalog/couponRepository');
    const pricing = async (id: string, quantity: bigint) =>
      amountForQuantity(
        pricingPriceOf(must(await findPriceForMerchant(gatewayDb(), id, merchant.id))),
        quantity,
      );
    const couponRow = pricingCouponOf(
      must(await findCouponForMerchant(gatewayDb(), coupon.id, merchant.id)),
    );
    const a = await pricing(tiered.id, 8n);
    const b = await pricing(extra.id, 3n);
    const off = discountAmount(a, 'EUR', couponRow) + discountAmount(b, 'EUR', couponRow);
    expect(quote).toMatchObject({
      amount_subtotal: (a + b).toString(),
      total_details: { amount_discount: off.toString() },
      amount_total: (a + b - off).toString(),
      discount: { coupon: coupon.id },
    });
    // The redemption is counted when the quote is accepted, not before.
    expect((await ok('GET', `/v1/coupons/${coupon.id}`)).times_redeemed).toBe(0);
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const accepted = await ok('POST', `/v1/quotes/${quote.id}/accept`, { expand: ['invoice'] });
    expect(accepted.invoice).toMatchObject({
      subtotal: quote.amount_subtotal,
      total: quote.amount_total,
    });
    expect((await ok('GET', `/v1/coupons/${coupon.id}`)).times_redeemed).toBe(1);
  });

  test('two accepts at once: one invoice, one quote.accepted', async () => {
    const payer = await customer(null, { card: false });
    const item = await oneTime('2500');
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: item.id }],
      collection_method: 'send_invoice',
      invoice_settings: { days_until_due: 14 },
    });
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const answers = await Promise.all([
      call('POST', `/v1/quotes/${quote.id}/accept`, {}),
      call('POST', `/v1/quotes/${quote.id}/accept`, {}),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
    expect(answers.find((answer) => answer.status === 400)?.json.error.code).toBe(
      'quote_unexpected_state',
    );
    const made = await ok('GET', `/v1/invoices?customer=${payer.id}`);
    expect(made.data).toHaveLength(1);
    expect(made.data[0]).toMatchObject({
      status: 'open',
      collection_method: 'send_invoice',
      days_until_due: 14,
      billing_reason: 'quote_accept',
    });
    expect((await quoteEvents()).filter((type) => type === 'quote.accepted')).toHaveLength(1);
  });
});

describe('a recurring quote', () => {
  test('accepting makes a subscription whose first invoice carries the one-time lines', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('3000', { interval: 'month' });
    const onboarding = await oneTime('9900', { name: 'Onboarding' });
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: plan.id, quantity: 2 }, { price: onboarding.id }],
      subscription_data: { description: 'Team plan', metadata: { from: 'quote' } },
    });
    expect(quote.amount_total).toBe('15900');
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const accepted = await ok('POST', `/v1/quotes/${quote.id}/accept`, {
      expand: ['subscription', 'invoice'],
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.subscription).toMatchObject({
      status: 'active',
      customer: payer.id,
      description: 'Team plan',
      metadata: { from: 'quote' },
    });
    expect(accepted.subscription.items.data).toHaveLength(1);
    expect(accepted.subscription.items.data[0]).toMatchObject({ quantity: 2 });
    expect(accepted.invoice).toMatchObject({
      id: accepted.subscription.latest_invoice,
      billing_reason: 'subscription_create',
      status: 'paid',
      total: '15900',
    });
    expect((accepted.invoice.lines.data as Json[]).map((line) => [line.type, line.amount])).toEqual(
      [
        ['subscription', '6000'],
        ['invoiceitem', '9900'],
      ],
    );
    // The one-time line is billed once: the renewal carries only the plan.
    await advance(tc.id, accepted.subscription.current_period_end + 2 * 3600);
    const renewal = must((await invoices(accepted.subscription.id)).at(-1));
    expect(renewal).toMatchObject({ billing_reason: 'subscription_cycle', total: '6000' });
  });

  test('a trial from subscription_data; a trial without a recurring line is refused', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('3000');
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: plan.id }],
      subscription_data: { trial_period_days: 14 },
    });
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const accepted = await ok('POST', `/v1/quotes/${quote.id}/accept`, {
      expand: ['subscription'],
    });
    expect(accepted.subscription).toMatchObject({ status: 'trialing', trial_end: T0 + 14 * DAY });

    const item = await oneTime('100');
    const refused = await call('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: item.id }],
      subscription_data: { trial_period_days: 14 },
    });
    expect(refused.json.error).toMatchObject({
      code: 'parameter_invalid',
      param: 'subscription_data[trial_period_days]',
    });
  });

  test('two accepts at once: one subscription, and the loser writes nothing', async () => {
    const payer = await customer(null);
    const plan = await price('4000');
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: plan.id }],
    });
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const answers = await Promise.all([
      call('POST', `/v1/quotes/${quote.id}/accept`, {}),
      call('POST', `/v1/quotes/${quote.id}/accept`, {}),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
    const subscriptions = await ok('GET', `/v1/subscriptions?customer=${payer.id}&status=all`);
    expect(subscriptions.data).toHaveLength(1);
    const made = await ok('GET', `/v1/invoices?customer=${payer.id}`);
    expect(made.data).toHaveLength(1);
    // Gapless: the loser's invoice number was given back with its rollback.
    expect(String(made.data[0].number)).toMatch(/-0001$/);
  });

  test('lines on different intervals or currencies are refused', async () => {
    const payer = await customer(null);
    const monthly = await price('1000', { interval: 'month' });
    const yearly = await price('10000', { interval: 'year' });
    const intervals = await call('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: monthly.id }, { price: yearly.id }],
    });
    expect(intervals.json.error).toMatchObject({
      code: 'parameter_invalid',
      param: 'line_items[1][price]',
    });
    const usd = await oneTime('100', { currency: 'USD' });
    const currencies = await call('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: monthly.id }, { price: usd.id }],
    });
    expect(currencies.json.error.param).toBe('line_items[1][price]');
  });
});

describe('Peable Tax on a quote', () => {
  test('finalize fails closed while tax cannot be computed, then freezes it', async () => {
    await approveTax();
    const payer = await customer(null);
    const item = await oneTime('10000');
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: item.id }],
      automatic_tax: { enabled: true },
    });
    expect(quote.total_details.amount_tax).toBeNull();
    taxDown = true;
    const refused = await call('POST', `/v1/quotes/${quote.id}/finalize`, {});
    expect(refused.status).toBe(503);
    expect(refused.json.error.code).toBe('tax_calculation_unavailable');
    const still = await ok('GET', `/v1/quotes/${quote.id}`);
    expect(still).toMatchObject({
      status: 'draft',
      number: null,
      automatic_tax: { enabled: true, status: 'failed' },
    });
    taxDown = false;
    const open = await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    expect(open).toMatchObject({
      status: 'open',
      amount_subtotal: '10000',
      total_details: { amount_tax: '2000' },
      amount_total: '12000',
      automatic_tax: { enabled: true, status: 'complete' },
    });
    expect(open.automatic_tax.tax_calculation).toMatch(/^taxcalc_/);
    const lines = await ok('GET', `/v1/quotes/${quote.id}/line_items`);
    expect(lines.data[0]).toMatchObject({ amount_tax: '2000', amount_total: '12000' });
    // Accepting taxes the invoice before it finalizes, the same way.
    const accepted = await ok('POST', `/v1/quotes/${quote.id}/accept`, { expand: ['invoice'] });
    expect(accepted.invoice).toMatchObject({ tax: '2000', total: '12000', status: 'paid' });
  });

  test('a customer with no location stays a draft, requires_location_inputs', async () => {
    await approveTax();
    const created = await ok('POST', '/v1/customers', { email: 'nowhere@example.test' });
    const item = await oneTime('10000');
    const quote = await ok('POST', '/v1/quotes', {
      customer: created.id,
      line_items: [{ price: item.id }],
      automatic_tax: { enabled: true },
    });
    const refused = await call('POST', `/v1/quotes/${quote.id}/finalize`, {});
    expect(refused.json.error.code).toBe('customer_location_insufficient');
    expect((await ok('GET', `/v1/quotes/${quote.id}`)).automatic_tax.status).toBe(
      'requires_location_inputs',
    );
  });
});

describe('expiry, cancellation and numbering', () => {
  test("an open quote past expires_at is cancelled on the customer's clock", async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const item = await oneTime('700');
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: item.id }],
    });
    const past = await call('POST', `/v1/quotes/${quote.id}/finalize`, { expires_at: T0 - 1 });
    expect(past.json.error.param).toBe('expires_at');
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, { expires_at: T0 + 2 * DAY });
    await advance(tc.id, T0 + DAY);
    expect((await ok('GET', `/v1/quotes/${quote.id}`)).status).toBe('open');
    await advance(tc.id, T0 + 3 * DAY);
    const expired = await ok('GET', `/v1/quotes/${quote.id}`);
    expect(expired).toMatchObject({ status: 'canceled' });
    expect(expired.status_transitions.canceled_at).toBe(T0 + 3 * DAY);
    expect(await quoteEvents()).toEqual(['quote.created', 'quote.finalized', 'quote.canceled']);
    const late = await call('POST', `/v1/quotes/${quote.id}/accept`, {});
    expect(late.json.error.code).toBe('quote_unexpected_state');
  });

  test('a draft is cancelled; numbers are per merchant and gapless', async () => {
    const payer = await customer(null);
    const item = await oneTime('700');
    const create = () =>
      ok('POST', '/v1/quotes', { customer: payer.id, line_items: [{ price: item.id }] });
    const dropped = await create();
    const canceled = await ok('POST', `/v1/quotes/${dropped.id}/cancel`, {});
    expect(canceled).toMatchObject({ status: 'canceled', number: null });
    const first = await ok('POST', `/v1/quotes/${(await create()).id}/finalize`, {});
    const second = await ok('POST', `/v1/quotes/${(await create()).id}/finalize`, {});
    const prefix = String(first.number).slice(0, -5);
    expect([first.number, second.number]).toEqual([`${prefix}-0001`, `${prefix}-0002`]);
  });

  test('the PDF is the engine renderer, titled QUOTE', async () => {
    const payer = await customer(null);
    const item = await oneTime('4200', { name: 'Audit' });
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: item.id }],
      header: 'Security audit',
    });
    const open = await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const response = await fetch(`${baseUrl}/v1/quotes/${quote.id}/pdf`);
    expect(response.headers.get('content-type')).toContain('application/pdf');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await response.arrayBuffer()));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    for (const expected of [
      '(QUOTE)',
      `(Quote number: ${open.number})`,
      '(Security audit)',
      '(Audit)',
      '(42.00 EUR)',
    ]) {
      expect(text).toContain(expected);
    }
  });
});

describe('a FairCoin quote', () => {
  test('is sent, never debited; its invoice is paid by the payer', async () => {
    const payer = await customer(null, { card: false });
    const fair = await oneTime('100000000', { currency: 'FAIR' });
    const debit = await call('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: fair.id }],
      collection_method: 'charge_automatically',
    });
    expect(debit.json.error).toMatchObject({
      code: 'faircoin_cannot_debit',
      param: 'collection_method',
    });
    const quote = await ok('POST', '/v1/quotes', {
      customer: payer.id,
      line_items: [{ price: fair.id }],
    });
    expect(quote.collection_method).toBe('send_invoice');
    await ok('POST', `/v1/quotes/${quote.id}/finalize`, {});
    const accepted = await ok('POST', `/v1/quotes/${quote.id}/accept`, { expand: ['invoice'] });
    expect(accepted.invoice).toMatchObject({
      status: 'open',
      currency: 'FAIR',
      collection_method: 'send_invoice',
      amount_due: '100000000',
    });
    const token = String(accepted.invoice.hosted_invoice_url).split('/invoice/')[1];
    const page = await ok('GET', `/v1/invoices/public/${token}`);
    expect(page.payment_method_types).toEqual(['faircoin']);
  });
});
