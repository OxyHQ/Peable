/**
 * The native billing engine (ADR 0018) over HTTP, against a real Postgres,
 * with a recording fake card provider behind the registry, a fake Peable Tax
 * provider, Orbit's email outbox with a memory mailer, and TEST CLOCKS driving time.
 *
 * Pinned: the lifecycles a merchant relies on — trial → active → renewals
 * paid; a failing renewal dunned to its final action; an upgrade prorated and
 * invoiced; a quantity change prorated onto the next invoice; pause and
 * resume; cancel now with a final invoice; send_invoice with a due date; a
 * credit note that refunds; metered usage; entitlements granted by two
 * products; a FairCoin subscription renewed by explicit payer payment — plus
 * tax computed before finalization (covered, uncovered, fail closed), gapless
 * numbering under concurrency and an idempotent scheduler under two workers.
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
const { applyProviderPaymentResult } = await import('../../services/intentReconciliation');
const { runBillingEnginePass } = await import('../../services/billingEngine/scheduler');
const { findIntentForMerchant, findIntentById } = await import(
  '../../db/payments/paymentIntentRepository'
);
const { transitionIntent } = await import('../../services/intentTransition');
const { balanceTransactions, taxTransactions } = await import('../../db/schema');
const { eq } = await import('drizzle-orm');
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
let appId = 'app_billing_engine';
let baseUrl = '';
let gateway: ReturnType<typeof createGateway> | undefined;
let merchant: MerchantRow;
const mailer = new MemoryMailer();
/** The kinds of the emails the outbox would send now. */
async function sentKinds(): Promise<string[]> {
  await dispatchCustomerEmails(mailer);
  return mailer.sent.map((email) => email.headers['X-Peable-Email-Kind'] ?? '');
}
let restoreModes: () => void = () => undefined;

/** The application owner the stub credential names — whose Peable wallet receives. */
let stubOwner = 'owner';

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
  appId = `app_be_${++counter}`;
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

// ---- Lifecycles -----------------------------------------------------------------------

describe('subscriptions on a test clock', () => {
  test('trial → trial_will_end → active → renewals paid, numbered gaplessly', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('1000');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
      trial_period_days: 7,
      expand: ['latest_invoice'],
    });
    expect(sub.status).toBe('trialing');
    expect(sub.trial_end).toBe(T0 + 7 * DAY);
    expect(sub.latest_invoice).toMatchObject({
      status: 'paid',
      total: '0',
      billing_reason: 'subscription_create',
    });
    expect(sub.test_clock).toBe(tc.id);

    await advance(tc.id, T0 + 5 * DAY);
    expect(await eventTypes()).toContain('customer.subscription.trial_will_end');

    await advance(tc.id, T0 + 7 * DAY + 2 * 3600);
    const active = await ok('GET', `/v1/subscriptions/${sub.id}`);
    expect(active.status).toBe('active');
    expect(active.current_period_start).toBe(T0 + 7 * DAY);
    const afterTrial = await invoices(sub.id);
    expect(afterTrial.map((i) => [i.status, i.amount_paid, i.billing_reason])).toEqual([
      ['paid', '0', 'subscription_create'],
      ['paid', '1000', 'subscription_cycle'],
    ]);

    await advance(tc.id, active.current_period_end + 2 * 3600);
    const all = await invoices(sub.id);
    expect(all.map((i) => i.status)).toEqual(['paid', 'paid', 'paid']);
    const numbers = all.map((i) => i.number as string);
    const prefix = numbers[0]?.split('-')[0];
    expect(numbers).toEqual([`${prefix}-0001`, `${prefix}-0002`, `${prefix}-0003`]);
    const types = await eventTypes();
    for (const type of [
      'customer.subscription.created',
      'invoice.created',
      'invoice.finalized',
      'invoice.paid',
      'invoice.upcoming',
    ] as const) {
      expect(types).toContain(type);
    }
  });

  test('a failing renewal is dunned on the schedule, then cancelled', async () => {
    await ok('POST', '/v1/billing_settings', {
      dunning: { retry_schedule_days: [1, 2], final_action: 'cancel' },
    });
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('2000');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
    });
    expect(sub.status).toBe('active');

    confirmPlan.push('decline', 'decline', 'decline');
    await advance(tc.id, sub.current_period_end + 2 * 3600);
    let renewal = must((await invoices(sub.id)).at(-1));
    expect(renewal).toMatchObject({ status: 'open', attempt_count: 1 });
    expect(renewal.next_payment_attempt).toBe(sub.current_period_end + 2 * 3600 + DAY);
    expect((await ok('GET', `/v1/subscriptions/${sub.id}`)).status).toBe('past_due');
    expect(await sentKinds()).toContain('invoice_payment_failed');

    await advance(tc.id, sub.current_period_end + 2 * 3600 + DAY + 60);
    renewal = must((await invoices(sub.id)).at(-1));
    expect(renewal.attempt_count).toBe(2);

    await advance(tc.id, sub.current_period_end + 2 * 3600 + 3 * DAY + 120);
    renewal = must((await invoices(sub.id)).at(-1));
    expect(renewal).toMatchObject({
      status: 'uncollectible',
      attempt_count: 3,
      next_payment_attempt: null,
    });
    const ended = await ok('GET', `/v1/subscriptions/${sub.id}?expand[]=latest_invoice`);
    expect(ended).toMatchObject({
      status: 'canceled',
      cancellation_details: { reason: 'payment_failed' },
    });
    expect((await eventTypes()).filter((t) => t === 'invoice.payment_failed')).toHaveLength(3);
  });

  test('an upgrade mid-period is prorated and invoiced at once (always_invoice)', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const basic = await price('1000');
    const pro = await price('3000');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: basic.id }],
    });
    const half = T0 + Math.floor((sub.current_period_end - T0) / 2);
    await advance(tc.id, half);
    const item = sub.items.data[0];
    const changed = await ok('POST', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: item.id, price: pro.id }],
      proration_behavior: 'always_invoice',
      proration_date: half,
    });
    expect(changed.items.data[0].price.id).toBe(pro.id);
    const latest = must((await invoices(sub.id)).at(-1));
    expect(latest.billing_reason).toBe('subscription_update');
    const amounts = (latest.lines.data as Json[]).map((line) => [line.amount, line.proration]);
    expect(amounts).toEqual([
      ['-500', true],
      ['1500', true],
    ]);
    expect(latest).toMatchObject({ status: 'paid', total: '1000', amount_paid: '1000' });
  });

  test('a quantity change is prorated onto the next invoice (create_prorations)', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const seat = await price('1000');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: seat.id, quantity: 2 }],
    });
    const half = T0 + Math.floor((sub.current_period_end - T0) / 2);
    await advance(tc.id, half);
    await ok('POST', `/v1/subscriptions/${sub.id}`, {
      items: [{ id: sub.items.data[0].id, quantity: 4 }],
      proration_date: half,
    });
    const pending = await ok('GET', `/v1/invoiceitems?customer=${payer.id}&pending=true`);
    expect((pending.data as Json[]).map((item) => item.amount).sort()).toEqual(['-1000', '2000']);
    await advance(tc.id, sub.current_period_end + 2 * 3600);
    const renewal = must((await invoices(sub.id)).at(-1));
    expect(renewal.status).toBe('paid');
    expect(renewal.total).toBe(String(4000 + 2000 - 1000));
  });

  test('a trial with no payment method pauses, and resumes into a paid period', async () => {
    const tc = await clock();
    const payer = await customer(tc.id, { card: false });
    const plan = await price('1500');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
      trial_period_days: 3,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
    });
    await advance(tc.id, T0 + 3 * DAY + 60);
    expect((await ok('GET', `/v1/subscriptions/${sub.id}`)).status).toBe('paused');
    expect(await eventTypes()).toContain('customer.subscription.paused');

    const row = must(await findCustomerForMerchant(gatewayDb(), payer.id, merchant.id));
    const { row: method } = await registerPaymentMethod(gatewayDb(), {
      publicId: `pm_resume${counter++}`,
      merchantId: merchant.id,
      customerId: row.id,
      card: {
        brand: 'visa',
        last4: '1111',
        exp_month: 1,
        exp_year: 2031,
        country: 'IE',
        funding: 'debit',
      },
      billingDetails: { address: null, email: null, name: null, phone: null },
      provider: 'stripe',
      providerObjectId: `pm_provider_resume_${counter++}`,
    });
    await ok('POST', `/v1/customers/${payer.id}`, {
      invoice_settings: { default_payment_method: method.publicId },
    });
    const resumed = await ok('POST', `/v1/subscriptions/${sub.id}/resume`, {});
    expect(resumed.status).toBe('active');
    expect(must((await invoices(sub.id)).at(-1))).toMatchObject({
      status: 'paid',
      amount_paid: '1500',
    });
    expect(await eventTypes()).toContain('customer.subscription.resumed');
  });

  test('pause_collection keep_as_draft leaves renewals as drafts', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('900');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
    });
    await ok('POST', `/v1/subscriptions/${sub.id}`, {
      pause_collection: { behavior: 'keep_as_draft' },
    });
    await advance(tc.id, sub.current_period_end + 3 * 3600);
    const renewal = must((await invoices(sub.id)).at(-1));
    expect(renewal).toMatchObject({ status: 'draft', auto_advance: false });
  });

  test('cancel now with invoice_now and prorate credits the unused time to the balance', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('3000');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
    });
    const third = T0 + Math.floor((sub.current_period_end - T0) / 3);
    await advance(tc.id, third);
    const canceled = await call('DELETE', `/v1/subscriptions/${sub.id}`, {
      invoice_now: true,
      prorate: true,
    });
    expect(canceled.status).toBe(200);
    expect(canceled.json.status).toBe('canceled');
    const final = must((await invoices(sub.id)).at(-1));
    expect(final.billing_reason).toBe('subscription_cancel');
    expect(BigInt(final.total)).toBeLessThan(0n);
    expect(final.status).toBe('paid');
    const after = await ok('GET', `/v1/customers/${payer.id}`);
    expect(after.balance).toBe(final.ending_balance);
    expect(BigInt(after.balance)).toBeLessThan(0n);
    const ledger = await ok('GET', `/v1/customers/${payer.id}/balance_transactions`);
    expect((ledger.data as Json[])[0]).toMatchObject({
      type: 'applied_to_invoice',
      amount: after.balance,
    });
  });

  test('send_invoice: finalized with a due date, emailed, past due once it passes', async () => {
    const tc = await clock();
    const payer = await customer(tc.id, { card: false });
    const plan = await price('5000');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
      collection_method: 'send_invoice',
      days_until_due: 10,
      expand: ['latest_invoice'],
    });
    expect(sub.status).toBe('active');
    expect(sub.latest_invoice).toMatchObject({
      status: 'open',
      due_date: T0 + 10 * DAY,
      collection_method: 'send_invoice',
    });
    expect(sub.latest_invoice.hosted_invoice_url).toContain('/invoice/inv_tok_');
    expect(await sentKinds()).toEqual(['invoice']);
    expect(mailer.sent[0]?.to).toBe('payer@example.test');
    expect(mailer.sent[0]?.text).toContain('/invoice/inv_tok_');
    expect(await eventTypes()).toContain('invoice.sent');
    await advance(tc.id, T0 + 10 * DAY + 60);
    expect((await ok('GET', `/v1/subscriptions/${sub.id}`)).status).toBe('past_due');
  });
});

describe('search (Stripe Search API, Orbit Phase 8)', () => {
  test('subscriptions and invoices are searchable, canceled subscriptions included', async () => {
    const payer = await customer(null);
    const plan = await price('900');
    const tag = `search-${Date.now()}`;
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
      metadata: { tag },
      expand: ['latest_invoice'],
    });
    expect(sub.status).toBe('active');
    const query = (resource: string, q: string, extra = '') =>
      ok('GET', `/v1/${resource}/search?query=${encodeURIComponent(q)}${extra}`);

    const byTag = await query('subscriptions', `metadata['tag']:'${tag}'`);
    expect(byTag).toMatchObject({ object: 'search_result', has_more: false });
    expect((byTag.data as Json[]).map((s) => s.id)).toEqual([sub.id]);
    // The hit is the list's own DTO, items included.
    expect((byTag.data as Json[])[0]?.items.data[0].price.id).toBe(plan.id);

    await ok('DELETE', `/v1/subscriptions/${sub.id}`);
    const canceled = await query(
      'subscriptions',
      `status:"canceled" AND customer:"${payer.id}"`,
      '&expand[]=total_count',
    );
    expect((canceled.data as Json[]).map((s) => s.id)).toEqual([sub.id]);
    expect(canceled.total_count).toBe(1);

    const invoice = sub.latest_invoice as Json;
    const bySubscription = await query('invoices', `subscription:"${sub.id}" AND status:"paid"`);
    expect((bySubscription.data as Json[]).map((i) => i.id)).toEqual([invoice.id]);
    expect((bySubscription.data as Json[])[0]?.lines.data).toHaveLength(1);
    const byNumber = await query('invoices', `number:"${invoice.number}" AND total>=900`);
    expect((byNumber.data as Json[]).map((i) => i.id)).toEqual([invoice.id]);
    expect((await query('invoices', 'total>900')).data as Json[]).not.toContainEqual(
      expect.objectContaining({ id: invoice.id }),
    );
    const refused = await call(
      'GET',
      `/v1/invoices/search?query=${encodeURIComponent('amount>1')}`,
    );
    expect(refused.status).toBe(400);
  });
});

describe('invoices', () => {
  test('a manual invoice: items, finalize, pay; numbers are gapless under concurrency', async () => {
    const payer = await customer(null);
    const made = await Promise.all(
      [1, 2].map(async () => {
        const invoice = await ok('POST', '/v1/invoices', { customer: payer.id, currency: 'EUR' });
        await ok('POST', '/v1/invoiceitems', {
          customer: payer.id,
          invoice: invoice.id,
          amount: '700',
          currency: 'EUR',
          description: 'Setup',
        });
        return invoice.id as string;
      }),
    );
    const finalized = await Promise.all(
      made.map((id) => ok('POST', `/v1/invoices/${id}/finalize`, {})),
    );
    const numbers = finalized.map((invoice) => invoice.number as string).sort();
    const prefix = must(numbers[0]).split('-')[0];
    expect(numbers).toEqual([`${prefix}-0001`, `${prefix}-0002`]);
    const paid = await ok('POST', `/v1/invoices/${made[0]}/pay`, {});
    expect(paid).toMatchObject({ status: 'paid', amount_paid: '700' });
    const declined = await (async () => {
      confirmPlan.push('decline');
      return call('POST', `/v1/invoices/${made[1]}/pay`, {});
    })();
    expect(declined.status).toBe(402);
    expect(declined.json.error).toMatchObject({
      type: 'card_error',
      decline_code: 'insufficient_funds',
    });
    const voided = await ok('POST', `/v1/invoices/${made[1]}/void`, {});
    expect(voided.status).toBe('void');
  });

  test('a credit note on a paid invoice refunds and reverses its tax', async () => {
    await approveTax();
    const payer = await customer(null);
    const invoice = await ok('POST', '/v1/invoices', {
      customer: payer.id,
      currency: 'EUR',
      automatic_tax: { enabled: true },
    });
    await ok('POST', '/v1/invoiceitems', {
      customer: payer.id,
      invoice: invoice.id,
      amount: '1000',
      currency: 'EUR',
    });
    const final = await ok('POST', `/v1/invoices/${invoice.id}/finalize`, {});
    expect(final).toMatchObject({
      tax: '200',
      total: '1200',
      automatic_tax: { status: 'complete' },
    });
    expect(final.automatic_tax.tax_calculation).toMatch(/^taxcalc_/);
    await ok('POST', `/v1/invoices/${invoice.id}/pay`, {});
    const note = await ok('POST', '/v1/credit_notes', {
      invoice: invoice.id,
      amount: '600',
      reason: 'order_change',
    });
    expect(note).toMatchObject({
      type: 'post_payment',
      total: '600',
      refund_amount: '600',
      status: 'issued',
    });
    expect(note.refund).toMatch(/^re_/);
    expect(providerCalls).toContain('test:refund:600');
    const rows = await gatewayDb()
      .select()
      .from(taxTransactions)
      .where(eq(taxTransactions.merchantId, merchant.id));
    const byReference = Object.fromEntries(
      rows.map((row) => [row.reference, row.reversal?.amount_total ?? null]),
    );
    expect(byReference).toEqual({ [invoice.id]: null, [note.id]: '-600' });
  });

  test('tax before finalize: uncovered is not_registered (zero); a covered sale fails closed', async () => {
    await approveTax();
    const abroad = await customer(null, { country: 'US' });
    const us = await ok('POST', '/v1/invoices', {
      customer: abroad.id,
      currency: 'EUR',
      automatic_tax: { enabled: true },
    });
    await ok('POST', '/v1/invoiceitems', {
      customer: abroad.id,
      invoice: us.id,
      amount: '1000',
      currency: 'EUR',
    });
    const usFinal = await ok('POST', `/v1/invoices/${us.id}/finalize`, {});
    expect(usFinal).toMatchObject({
      tax: '0',
      total: '1000',
      automatic_tax: { status: 'complete' },
    });

    taxDown = true;
    const home = await customer(null);
    const ie = await ok('POST', '/v1/invoices', {
      customer: home.id,
      currency: 'EUR',
      automatic_tax: { enabled: true },
    });
    await ok('POST', '/v1/invoiceitems', {
      customer: home.id,
      invoice: ie.id,
      amount: '1000',
      currency: 'EUR',
    });
    const refused = await call('POST', `/v1/invoices/${ie.id}/finalize`, {});
    expect(refused.status).toBe(503);
    expect(refused.json.error.code).toBe('tax_calculation_unavailable');
    const still = await ok('GET', `/v1/invoices/${ie.id}`);
    expect(still).toMatchObject({
      status: 'draft',
      number: null,
      automatic_tax: { status: 'failed' },
    });

    // A subscription's first invoice is priced before anything is written:
    // fail closed creates nothing.
    const plan = await price('1000');
    const denied = await call('POST', '/v1/subscriptions', {
      customer: home.id,
      items: [{ price: plan.id }],
      automatic_tax: { enabled: true },
    });
    expect(denied.status).toBe(503);
    expect((await ok('GET', `/v1/subscriptions?customer=${home.id}&status=all`)).data).toEqual([]);
  });

  test('the hosted invoice page and its PDF answer by token, anonymously', async () => {
    const payer = await customer(null);
    const invoice = await ok('POST', '/v1/invoices', {
      customer: payer.id,
      currency: 'EUR',
      collection_method: 'send_invoice',
      days_until_due: 5,
    });
    await ok('POST', '/v1/invoiceitems', {
      customer: payer.id,
      invoice: invoice.id,
      amount: '4200',
      currency: 'EUR',
      description: 'Consulting',
    });
    const final = await ok('POST', `/v1/invoices/${invoice.id}/finalize`, {});
    const token = String(final.hosted_invoice_url).split('/invoice/')[1];
    const page = await ok('GET', `/v1/invoices/public/${token}`);
    expect(page).toMatchObject({
      object: 'public_invoice',
      amount_remaining: '4200',
      // FairCoin is always offered beside the card (ADR 0021 D1).
      payment_method_types: ['card', 'faircoin'],
      faircoin: { available: true, unavailable_reason: null },
    });
    const pay = await ok('POST', `/v1/invoices/public/${token}/pay`, {});
    expect(pay.payment_intent).toMatch(/^pi_/);
    expect(pay.client_secret).toContain('_secret_');
    expect((await ok('POST', `/v1/invoices/public/${token}/pay`, {})).payment_intent).toBe(
      pay.payment_intent,
    );
    const pdf = await fetch(`${baseUrl}/v1/invoices/public/${token}/pdf`);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.4');
    expect((await call('GET', '/v1/invoices/public/inv_tok_nope')).status).toBe(404);
  });
});

describe('usage, entitlements, FairCoin, portal', () => {
  test('a metered price bills the period’s usage in arrears', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const meter = await ok('POST', '/v1/billing/meters', {
      display_name: 'API calls',
      event_name: 'api_call',
      default_aggregation: { formula: 'sum' },
    });
    const metered = await price('2', { meter: meter.id });
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: metered.id }],
    });
    // Usage is reported on the customer's clock; a repeated identifier is one event.
    await advance(tc.id, T0 + DAY + 3600);
    for (const [identifier, value] of [
      ['a', '100'],
      ['b', '150'],
      ['a', '100'],
    ] as const) {
      await ok('POST', '/v1/billing/meter_events', {
        event_name: 'api_call',
        identifier,
        payload: { peable_customer_id: payer.id, value },
        timestamp: T0 + DAY,
      });
    }
    const summary = await ok(
      'GET',
      `/v1/billing/meters/${meter.id}/event_summaries?customer=${payer.id}&start_time=${T0}&end_time=${T0 + 2 * DAY}`,
    );
    expect(summary.data[0].aggregated_value).toBe('250');
    await advance(tc.id, sub.current_period_end + 2 * 3600);
    const renewal = must((await invoices(sub.id)).at(-1));
    const usage = (renewal.lines.data as Json[]).find((line) => line.price?.id === metered.id);
    expect(usage).toMatchObject({ quantity: 250, amount: '500' });
    expect(renewal).toMatchObject({ status: 'paid', amount_paid: '500' });
  });

  test('a feature granted by two products is one entitlement, kept while either stands', async () => {
    const plusProduct = (await ok('POST', '/v1/products', { name: 'Mention Plus' })).id;
    const oneProduct = (await ok('POST', '/v1/products', { name: 'Oxy One' })).id;
    const feature = await ok('POST', '/v1/entitlements/features', {
      lookup_key: 'mention_plus',
      name: 'Mention Plus',
    });
    await ok('POST', `/v1/products/${plusProduct}/features`, { entitlement_feature: feature.id });
    await ok('POST', `/v1/products/${oneProduct}/features`, { entitlement_feature: feature.id });
    const plus = await price('500', { product: plusProduct });
    const one = await price('1500', { product: oneProduct });
    const payer = await customer(null);
    const active = () => ok('GET', `/v1/entitlements/active_entitlements?customer=${payer.id}`);
    expect((await active()).data).toEqual([]);
    const viaOne = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: one.id }],
    });
    expect((await active()).data.map((e: Json) => e.lookup_key)).toEqual(['mention_plus']);
    const viaPlus = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plus.id }],
    });
    expect((await active()).data).toHaveLength(1);
    await ok('DELETE', `/v1/subscriptions/${viaOne.id}`, {});
    expect((await active()).data.map((e: Json) => e.lookup_key)).toEqual(['mention_plus']);
    await ok('DELETE', `/v1/subscriptions/${viaPlus.id}`, {});
    expect((await active()).data).toEqual([]);
    const summaries = (
      await storedEvents({
        merchantId: merchant.id,
        type: 'entitlements.active_entitlement_summary.updated',
      })
    ).map(({ event }) => (event.data.object as Json).entitlements.data.length);
    expect(summaries).toEqual([1, 0]);
  });

  test('FairCoin renews by explicit payer payment, never a debit', async () => {
    const tc = await clock();
    const payer = await customer(tc.id, { card: false });
    const fair = await price('100000000', { currency: 'FAIR' });
    const debit = await call('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: fair.id }],
      collection_method: 'charge_automatically',
    });
    expect(debit.json.error).toMatchObject({
      code: 'faircoin_cannot_debit',
      param: 'collection_method',
    });
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: fair.id }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice'],
    });
    expect(sub).toMatchObject({ status: 'incomplete', collection_method: 'send_invoice' });
    const token = String(sub.latest_invoice.hosted_invoice_url).split('/invoice/')[1];
    const pay = await ok('POST', `/v1/invoices/public/${token}/pay`, {});
    const intent = must(await findIntentForMerchant(gatewayDb(), pay.payment_intent, merchant.id));
    expect(intent).toMatchObject({
      rail: 'faircoin',
      status: 'requires_action',
      amount: '100000000',
    });
    // The payer's wallet broadcasts; the watcher proves it.
    await transitionIntent(intent.id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'a'.repeat(64),
    });
    await transitionIntent(intent.id, {
      from: 'processing',
      status: 'succeeded',
    });
    expect(must(await findIntentById(gatewayDb(), intent.id)).status).toBe('succeeded');
    const paid = await ok('GET', `/v1/subscriptions/${sub.id}?expand[]=latest_invoice`);
    expect(paid.status).toBe('active');
    expect(paid.latest_invoice.status).toBe('paid');
    await advance(tc.id, sub.current_period_end + 2 * 3600);
    const renewal = must((await invoices(sub.id)).at(-1));
    expect(renewal).toMatchObject({
      status: 'open',
      collection_method: 'send_invoice',
      payment_intent: null,
    });
  });

  test('the portal: a session URL opens the customer view and cancels at period end', async () => {
    const payer = await customer(null);
    const plan = await price('800');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
    });
    const session = await ok('POST', '/v1/billing_portal/sessions', {
      customer: payer.id,
      return_url: 'https://app.example/account',
    });
    expect(session.url).toContain('/portal/bps_tok_');
    const token = String(session.url).split('/portal/')[1];
    const view = await ok('GET', `/v1/billing_portal/public/${token}`);
    expect(view.subscriptions.map((s: Json) => s.id)).toEqual([sub.id]);
    expect(view.customer.default_payment_method.card.last4).toBe('4242');
    expect(view.invoices).toHaveLength(1);
    const after = await ok('POST', `/v1/billing_portal/public/${token}/cancel`, {
      subscription: sub.id,
    });
    expect(after.subscriptions[0].cancel_at_period_end).toBe(true);
    expect((await call('GET', '/v1/billing_portal/public/bps_tok_nope')).status).toBe(404);
  });
});

describe('checkout in subscription mode', () => {
  async function session(body: Json): Promise<Json> {
    const created = await call('POST', '/v1/checkout_sessions', body);
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`session → ${created.status} ${JSON.stringify(created.json)}`);
    }
    return created.json;
  }
  const payer = (cs: Json, suffix: string, body?: unknown) =>
    fetch(`${baseUrl}/v1/checkout_sessions/${cs.id}/public${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Peable-Client-Secret': decodeURIComponent(String(cs.url).split('#cs=')[1] ?? ''),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({
      status: response.status,
      json: (await response.json()) as Json,
    }));

  test('a card session starts the subscription, its first invoice and the payment that pays both', async () => {
    const payerCustomer = await customer(null, { card: false });
    const plan = await price('1500');
    const cs = await session({
      mode: 'subscription',
      customer: payerCustomer.id,
      success_url: 'https://shop.example/done',
      line_items: [{ price: plan.id, quantity: 2 }],
    });
    expect(cs.mode).toBe('subscription');
    const confirmed = await payer(cs, '/confirm', {});
    expect(confirmed.status).toBe(200);
    const intentId = confirmed.json.payment_intent.id ?? confirmed.json.payment_intent;
    const intent = must(await findIntentForMerchant(gatewayDb(), intentId, merchant.id));
    expect(intent).toMatchObject({ amount: '3000', rail: 'card', setupFutureUsage: 'off_session' });
    const [sub] = (await ok('GET', `/v1/subscriptions?customer=${payerCustomer.id}&status=all`))
      .data as Json[];
    expect(sub).toMatchObject({ status: 'incomplete', metadata: { checkout_session: cs.id } });
    // The payer completes the card payment in the browser.
    await applyProviderPaymentResult(intent, {
      status: 'succeeded',
      chargeObjectId: `ch_${intent.providerObjectId}`,
    });
    const active = await ok('GET', `/v1/subscriptions/${must(sub).id}?expand[]=latest_invoice`);
    expect(active.status).toBe('active');
    expect(active.latest_invoice).toMatchObject({ status: 'paid', amount_paid: '3000' });
    expect((await payer(cs, '')).json.status).toBe('complete');
  });

  test('a line that is not a licensed recurring price is refused at creation', async () => {
    const payerCustomer = await customer(null, { card: false });
    const once = await ok('POST', '/v1/prices', {
      product: (await ok('POST', '/v1/products', { name: 'Setup' })).id,
      currency: 'EUR',
      unit_amount: '900',
    });
    const refused = await call('POST', '/v1/checkout_sessions', {
      mode: 'subscription',
      customer: payerCustomer.id,
      success_url: 'https://shop.example/done',
      line_items: [{ price: once.id, quantity: 1 }],
    });
    expect(refused.status).toBe(400);
  });
});

describe('FairCoin is always offered on fiat orders (ADR 0021)', () => {
  // The preloaded test sources: 0.5 USD per FAIR, 1.25 USD per EUR → 0.4 EUR per FAIR.
  const asPayer = (cs: Json, suffix: string, body?: unknown) =>
    fetch(`${baseUrl}/v1/checkout_sessions/${cs.id}/public${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Peable-Client-Secret': decodeURIComponent(String(cs.url).split('#cs=')[1] ?? ''),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({
      status: response.status,
      json: (await response.json()) as Json,
    }));
  const intentOf = async (publicId: string) =>
    must(await findIntentForMerchant(gatewayDb(), publicId, merchant.id));
  const linkedIntent = (view: Json): string =>
    String(view.payment_intent?.id ?? view.payment_intent);
  async function paid(intentPublicId: string): Promise<void> {
    const intent = await intentOf(intentPublicId);
    await transitionIntent(intent.id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'b'.repeat(64),
    });
    await transitionIntent(intent.id, { from: 'processing', status: 'succeeded' });
  }
  async function oneTimePrice(unitAmount: string): Promise<Json> {
    const product = (await ok('POST', '/v1/products', { name: 'Poster' })).id;
    return ok('POST', '/v1/prices', { product, currency: 'EUR', unit_amount: unitAmount });
  }

  test('a fiat session offers card and FairCoin; leaving FairCoin out is payment_method_locked', async () => {
    const poster = await oneTimePrice('4200');
    const refused = await call('POST', '/v1/checkout_sessions', {
      success_url: 'https://shop.example/done',
      line_items: [{ price: poster.id, quantity: 1 }],
      payment_method_types: ['card'],
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatchObject({
      code: 'payment_method_locked',
      param: 'payment_method_types',
    });
    const cs = await ok('POST', '/v1/checkout_sessions', {
      success_url: 'https://shop.example/done',
      customer_email: 'payer@example.test',
      line_items: [{ price: poster.id, quantity: 1 }],
    });
    expect(cs).toMatchObject({ rail: 'card', network: 'testnet' });
    expect(cs.payment_method_types).toEqual(['card', 'faircoin']);
    const view = (await asPayer(cs, '')).json;
    expect(view.payment_method_types).toEqual(['card', 'faircoin']);
    expect(view.faircoin).toEqual({ available: true, unavailable_reason: null });
  });

  test('choosing FairCoin quotes the total; switching replaces an unpaid payment; FairCoin completes the order', async () => {
    const poster = await oneTimePrice('4200');
    const cs = await ok('POST', '/v1/checkout_sessions', {
      success_url: 'https://shop.example/done',
      customer_email: 'payer@example.test',
      line_items: [{ price: poster.id, quantity: 1 }],
    });
    const byCard = await asPayer(cs, '/confirm', {});
    expect(byCard.status, JSON.stringify(byCard.json)).toBe(200);
    const card = await intentOf(linkedIntent(byCard.json));
    expect(card).toMatchObject({ rail: 'card', amount: '4200', currency: 'EUR' });

    const byFaircoin = await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' });
    expect(byFaircoin.status).toBe(200);
    const fair = byFaircoin.json.payment_intent;
    expect(fair).toMatchObject({
      currency: 'FAIR',
      amount: '10500000000',
      payment_method_types: ['faircoin'],
      next_action: { type: 'faircoin_payment' },
    });
    expect(fair.faircoin.quote).toMatchObject({
      currency: 'EUR',
      amount: '4200',
      rate: '0.4',
      price: { source: 'wfair-base', usd_per_fair: '0.5' },
      reference_rates: { source: 'ecb', usd_per_eur: '1.25', currency_per_eur: '1' },
    });
    expect(fair.faircoin.quote.expires_at - fair.faircoin.quote.quoted_at).toBe(600);
    // The card payment was cancelled at the provider and here; the session stays open.
    expect((await intentOf(card.publicId)).status).toBe('canceled');
    expect(byFaircoin.json.status).toBe('open');
    // Confirming FairCoin again answers the same quoted payment.
    expect(
      linkedIntent((await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' })).json),
    ).toBe(fair.id);

    await paid(fair.id);
    const done = (await asPayer(cs, '')).json;
    expect(done).toMatchObject({ status: 'complete', payment_status: 'paid' });
    // The books record the FAIR received and the fiat it was priced at (ADR 0021 D7).
    const [entry] = await gatewayDb()
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.sourceId, fair.id));
    expect(must(entry)).toMatchObject({
      currency: 'FAIR',
      amount: '10500000000',
      status: 'informational',
    });
    expect(must(entry).faircoinQuote).toMatchObject({ currency: 'EUR', amount: '4200' });
  });

  test('a lapsed quote returns the order to the payer instead of expiring it', async () => {
    const poster = await oneTimePrice('4200');
    const cs = await ok('POST', '/v1/checkout_sessions', {
      success_url: 'https://shop.example/done',
      customer_email: 'payer@example.test',
      line_items: [{ price: poster.id, quantity: 1 }],
    });
    const quoted = await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' });
    const { expireIntentNow } = await import('../../services/expirySweeper');
    await expireIntentNow(await intentOf(linkedIntent(quoted.json)));
    const after = (await asPayer(cs, '')).json;
    expect(after).toMatchObject({ status: 'open', payment_intent: null });
    // A fresh quote is a new payment.
    const again = await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' });
    expect(linkedIntent(again.json)).not.toBe(linkedIntent(quoted.json));
  });

  test("the owner's Peable wallet isn't set up: FairCoin says so, never silently card-only (ADR 0021 D5)", async () => {
    // The credential names an owner with no identity key — an organization
    // whose owners have not created its Peable wallet yet.
    stubOwner = `keyless_org_${String(counter)}`;
    try {
      const poster = await oneTimePrice('4200');
      const cs = await ok('POST', '/v1/checkout_sessions', {
        success_url: 'https://shop.example/done',
        customer_email: 'payer@example.test',
        line_items: [{ price: poster.id, quantity: 1 }],
      });
      // The order is created and FairCoin is still offered — with the reason.
      expect(cs.payment_method_types).toEqual(['card', 'faircoin']);
      expect((await asPayer(cs, '')).json.faircoin).toEqual({
        available: false,
        unavailable_reason: 'faircoin_wallet_missing',
      });
      const refused = await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' });
      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('faircoin_wallet_missing');
      const byCard = await asPayer(cs, '/confirm', { payment_method_type: 'card' });
      expect(byCard.status).toBe(200);
    } finally {
      stubOwner = 'owner';
    }
  });

  test('no fresh price: FairCoin says why and fails closed, the card still works', async () => {
    const { useQuoteSources } = await import('../../services/faircoin/quote');
    const restore = useQuoteSources({
      readPrice: async () => ({ usdPerFair: '0.5', observedAt: new Date(Date.now() - 3600_000) }),
      readReferenceRates: async () => ({
        perEur: { EUR: '1', USD: '1.25' },
        observedAt: new Date(),
      }),
    });
    try {
      const poster = await oneTimePrice('4200');
      const cs = await ok('POST', '/v1/checkout_sessions', {
        success_url: 'https://shop.example/done',
        customer_email: 'payer@example.test',
        line_items: [{ price: poster.id, quantity: 1 }],
      });
      expect((await asPayer(cs, '')).json.faircoin).toEqual({
        available: false,
        unavailable_reason: 'price_unavailable',
      });
      const refused = await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' });
      expect(refused.status).toBe(503);
      expect(refused.json.error.code).toBe('faircoin_price_unavailable');
      const byCard = await asPayer(cs, '/confirm', { payment_method_type: 'card' });
      expect(byCard.status).toBe(200);
      expect(byCard.json.payment_intent.currency).toBe('EUR');
    } finally {
      restore();
    }
  });

  test('a hosted fiat invoice is payable in FairCoin, and records its fiat amount as paid', async () => {
    const payerCustomer = await customer(null, { card: false });
    const invoice = await ok('POST', '/v1/invoices', {
      customer: payerCustomer.id,
      currency: 'EUR',
      collection_method: 'send_invoice',
      days_until_due: 5,
    });
    await ok('POST', '/v1/invoiceitems', {
      customer: payerCustomer.id,
      invoice: invoice.id,
      amount: '4200',
      currency: 'EUR',
      description: 'Consulting',
    });
    const final = await ok('POST', `/v1/invoices/${invoice.id}/finalize`, {});
    const token = String(final.hosted_invoice_url).split('/invoice/')[1];
    const byCard = await ok('POST', `/v1/invoices/public/${token}/pay`, {});
    const byFaircoin = await ok('POST', `/v1/invoices/public/${token}/pay`, {
      payment_method_type: 'faircoin',
    });
    expect(byFaircoin.payment_intent).not.toBe(byCard.payment_intent);
    expect((await intentOf(byCard.payment_intent)).status).toBe('canceled');
    const fair = await intentOf(byFaircoin.payment_intent);
    expect(fair).toMatchObject({ rail: 'faircoin', amount: '10500000000' });
    expect(fair.faircoinQuote).toMatchObject({ currency: 'EUR', amount: '4200' });
    await paid(fair.publicId);
    expect(await ok('GET', `/v1/invoices/${invoice.id}`)).toMatchObject({
      status: 'paid',
      amount_paid: '4200',
    });
  });

  test('a subscription checkout paid in FairCoin is invoiced from then on, never debited', async () => {
    const payerCustomer = await customer(null, { card: false });
    const plan = await price('1500');
    const cs = await ok('POST', '/v1/checkout_sessions', {
      mode: 'subscription',
      customer: payerCustomer.id,
      success_url: 'https://shop.example/done',
      line_items: [{ price: plan.id, quantity: 2 }],
    });
    expect(cs.payment_method_types).toEqual(['card', 'faircoin']);
    const byCard = await asPayer(cs, '/confirm', {});
    expect(byCard.status).toBe(200);
    const byFaircoin = await asPayer(cs, '/confirm', { payment_method_type: 'faircoin' });
    expect(byFaircoin.status).toBe(200);
    const fair = byFaircoin.json.payment_intent;
    expect(fair).toMatchObject({ currency: 'FAIR', amount: '7500000000' });
    expect((await intentOf(linkedIntent(byCard.json))).status).toBe('canceled');
    const [sub] = (await ok('GET', `/v1/subscriptions?customer=${payerCustomer.id}&status=all`))
      .data as Json[];
    expect(must(sub).status).toBe('incomplete');
    await paid(fair.id);
    const active = await ok('GET', `/v1/subscriptions/${must(sub).id}?expand[]=latest_invoice`);
    expect(active).toMatchObject({ status: 'active', collection_method: 'send_invoice' });
    expect(active.latest_invoice).toMatchObject({ status: 'paid', amount_paid: '3000' });
    expect((await asPayer(cs, '')).json.status).toBe('complete');
  });
});

describe('the scheduler', () => {
  test('two workers renewing the same subscription make one invoice', async () => {
    const tc = await clock();
    const payer = await customer(tc.id);
    const plan = await price('1200');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
    });
    // Move the frozen time without draining, then race two passes.
    const { updateTestClock } = await import('../../db/billingEngine/testClockRepository');
    const { findLiveTestClockForMerchant } = await import(
      '../../db/billingEngine/testClockRepository'
    );
    const row = must(await findLiveTestClockForMerchant(gatewayDb(), tc.id, merchant.id));
    await updateTestClock(gatewayDb(), row.id, {
      frozenTime: new Date((sub.current_period_end + 2 * 3600) * 1000),
    });
    await Promise.all([
      runBillingEnginePass({ testClockId: row.id }),
      runBillingEnginePass({ testClockId: row.id }),
    ]);
    await Promise.all([
      runBillingEnginePass({ testClockId: row.id }),
      runBillingEnginePass({ testClockId: row.id }),
    ]);
    const all = await invoices(sub.id);
    expect(all.filter((i) => i.billing_reason === 'subscription_cycle')).toHaveLength(1);
    expect(must(all.at(-1))).toMatchObject({
      status: 'paid',
      amount_paid: '1200',
      attempt_count: 1,
    });
  });
});

/**
 * Every route of the billing engine answered once, so the contract preload
 * (`__tests__/setup/contractCheck.ts`) checks each answer against its
 * `RouteContract` — the lifecycles above reach only some of them.
 */
describe('the contracts (ADR 0014 D5)', () => {
  test('subscription items, the upcoming invoice, invoice and item edits answer their contracts', async () => {
    const payer = await customer(null);
    const plan = await price('900');
    const addOn = await price('300');
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id, quantity: 1 }],
      default_payment_method: payer.invoice_settings.default_payment_method,
    });
    const added = await ok('POST', '/v1/subscription_items', {
      subscription: sub.id,
      price: addOn.id,
      quantity: 2,
      proration_behavior: 'none',
    });
    expect(added).toMatchObject({ object: 'subscription_item', quantity: 2 });
    expect(added.price.id).toBe(addOn.id);
    const items = await ok('GET', `/v1/subscription_items?subscription=${sub.id}`);
    expect(items.data).toHaveLength(2);
    expect((await ok('GET', `/v1/subscription_items/${added.id}`)).id).toBe(added.id);
    const changed = await ok('POST', `/v1/subscription_items/${added.id}`, {
      quantity: 3,
      proration_behavior: 'none',
      metadata: { seat: 'extra' },
    });
    expect(changed).toMatchObject({ quantity: 3, metadata: { seat: 'extra' } });
    const upcoming = await ok(
      'GET',
      `/v1/invoices/upcoming?customer=${payer.id}&subscription_items[0][id]=${added.id}&subscription_items[0][quantity]=4`,
    );
    expect(upcoming).toMatchObject({ object: 'invoice', billing_reason: 'upcoming' });
    expect(
      await ok('DELETE', `/v1/subscription_items/${added.id}`, { proration_behavior: 'none' }),
    ).toEqual({ id: added.id, object: 'subscription_item', deleted: true });
    const updated = await ok('POST', `/v1/subscriptions/${sub.id}`, {
      description: 'Team plan',
      metadata: { team: 'core' },
      expand: ['customer', 'default_payment_method'],
    });
    expect(updated.customer.id).toBe(payer.id);
    expect(updated.default_payment_method.object).toBe('payment_method');

    const draft = await ok('POST', '/v1/invoices', { customer: payer.id, currency: 'EUR' });
    const inline = await ok('POST', '/v1/invoiceitems', {
      customer: payer.id,
      invoice: draft.id,
      price_data: { product: plan.product, currency: 'EUR', unit_amount: '250' },
      quantity: 2,
      expand: ['invoice'],
    });
    expect(inline).toMatchObject({ amount: '500', unit_amount: '250' });
    expect(inline.invoice.id).toBe(draft.id);
    const tooBig = await call('POST', '/v1/invoiceitems', {
      customer: payer.id,
      price_data: { product: plan.product, currency: 'EUR', unit_amount: '100000000000000' },
    });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error.param).toBe('price_data[unit_amount]');
    const pending = await ok('POST', '/v1/invoiceitems', {
      customer: payer.id,
      amount: '150',
      currency: 'EUR',
    });
    expect((await ok('GET', `/v1/invoiceitems/${pending.id}`)).invoice).toBeNull();
    expect(
      (await ok('POST', `/v1/invoiceitems/${pending.id}`, { description: 'Later' })).description,
    ).toBe('Later');
    expect((await ok('GET', `/v1/invoiceitems?invoice=${draft.id}`)).data).toHaveLength(1);
    expect(await ok('DELETE', `/v1/invoiceitems/${pending.id}`)).toEqual({
      id: pending.id,
      object: 'invoiceitem',
      deleted: true,
    });
    expect(
      (await ok('POST', `/v1/invoices/${draft.id}`, { description: 'Extras' })).description,
    ).toBe('Extras');
    expect((await ok('GET', `/v1/invoices/${draft.id}?expand[]=customer`)).customer.id).toBe(
      payer.id,
    );
    const lines = await ok('GET', `/v1/invoices/${draft.id}/lines`);
    expect(lines).toMatchObject({ object: 'list', has_more: false });
    expect(lines.data).toHaveLength(1);
    const other = await ok('POST', '/v1/invoices', { customer: payer.id, currency: 'EUR' });
    expect(await ok('DELETE', `/v1/invoices/${other.id}`)).toEqual({
      id: other.id,
      object: 'invoice',
      deleted: true,
    });
    const final = await ok('POST', `/v1/invoices/${draft.id}/finalize`, { auto_advance: false });
    expect(final.status).toBe('open');
    const pdf = await fetch(`${baseUrl}/v1/invoices/${draft.id}/pdf`);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    await pdf.arrayBuffer();
    expect((await ok('POST', `/v1/invoices/${draft.id}/mark_uncollectible`, {})).status).toBe(
      'uncollectible',
    );
  });

  test('send, credit notes, the balance ledger and the portal answer their contracts', async () => {
    const payer = await customer(null);
    const invoice = await ok('POST', '/v1/invoices', {
      customer: payer.id,
      currency: 'EUR',
      collection_method: 'send_invoice',
      days_until_due: 10,
    });
    await ok('POST', '/v1/invoiceitems', {
      customer: payer.id,
      invoice: invoice.id,
      amount: '1000',
      currency: 'EUR',
    });
    await ok('POST', `/v1/invoices/${invoice.id}/finalize`, {});
    expect((await ok('POST', `/v1/invoices/${invoice.id}/send`, {})).status).toBe('open');
    const preview = await ok(
      'GET',
      `/v1/credit_notes/preview?invoice=${invoice.id}&amount=300&reason=duplicate`,
    );
    expect(preview).toMatchObject({ object: 'credit_note', total: '300', id: '' });
    const note = await ok('POST', '/v1/credit_notes', {
      invoice: invoice.id,
      amount: '300',
      expand: ['invoice', 'customer'],
    });
    expect(note.invoice.id).toBe(invoice.id);
    expect((await ok('GET', `/v1/credit_notes?invoice=${invoice.id}`)).data).toHaveLength(1);
    expect((await ok('GET', `/v1/credit_notes/${note.id}`)).id).toBe(note.id);
    expect((await ok('POST', `/v1/credit_notes/${note.id}/void`, {})).status).toBe('void');

    const credit = await ok('POST', `/v1/customers/${payer.id}/balance_transactions`, {
      amount: '-500',
      currency: 'EUR',
      description: 'Goodwill',
      expand: ['customer'],
    });
    expect(credit).toMatchObject({ amount: '-500', ending_balance: '-500', type: 'adjustment' });
    expect(credit.customer.id).toBe(payer.id);
    expect(
      (await ok('GET', `/v1/customers/${payer.id}/balance_transactions/${credit.id}`)).id,
    ).toBe(credit.id);

    const plan = await price('800');
    const upgrade = await price('1600', { product: plan.product });
    const sub = await ok('POST', '/v1/subscriptions', {
      customer: payer.id,
      items: [{ price: plan.id }],
    });
    const configuration = await ok('POST', '/v1/billing_portal/configurations', {
      business_profile: { headline: 'Manage your plan' },
      features: {
        customer_update: { enabled: true, allowed_updates: ['name', 'email'] },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          products: [{ product: plan.product, prices: [plan.id, upgrade.id] }],
        },
      },
    });
    expect(configuration).toMatchObject({
      object: 'billing_portal.configuration',
      is_default: true,
    });
    expect(
      (await ok('GET', '/v1/billing_portal/configurations?is_default=true')).data,
    ).toHaveLength(1);
    expect((await ok('GET', `/v1/billing_portal/configurations/${configuration.id}`)).id).toBe(
      configuration.id,
    );
    const bad = await call(
      'GET',
      `/v1/billing_portal/configurations/${configuration.id}?expand[]=customer`,
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error.param).toBe('expand');
    expect(
      (
        await ok('POST', `/v1/billing_portal/configurations/${configuration.id}`, {
          default_return_url: 'https://app.example/account',
        })
      ).default_return_url,
    ).toBe('https://app.example/account');
    const session = await ok('POST', '/v1/billing_portal/sessions', { customer: payer.id });
    const token = String(session.url).split('/portal/')[1];
    const portal = `/v1/billing_portal/public/${token}`;
    const switched = await ok('POST', `${portal}/change_plan`, {
      subscription: sub.id,
      price: upgrade.id,
    });
    expect(switched.subscriptions[0].items[0].price).toBe(upgrade.id);
    expect(switched.plans[0].prices).toHaveLength(2);
    expect((await ok('POST', `${portal}/customer`, { name: 'Renamed Payer' })).customer.name).toBe(
      'Renamed Payer',
    );
    await ok('POST', `${portal}/cancel`, { subscription: sub.id });
    const renewed = await ok('POST', `${portal}/renew`, { subscription: sub.id });
    expect(renewed.subscriptions[0].cancel_at_period_end).toBe(false);
  });
});
