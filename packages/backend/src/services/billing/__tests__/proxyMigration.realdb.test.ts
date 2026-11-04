/**
 * Moving the Stripe-Billing proxy's subscriptions onto native ones (ADR 0018
 * §7), against a real Postgres, a fake Stripe (the migration's own reads and
 * its one write) and the fake card provider for the renewals that follow.
 *
 * Pinned: a dry run reports every subscription per cohort with the reason
 * anything is blocked, and writes nothing on either side; an execution adopts
 * (same Stripe customer, same card, held native subscription, access at once)
 * then releases Stripe (cancel at period end + collection voided + marker)
 * then the hold; a rerun changes nothing; a crash before or after Stripe's
 * answer resumes without a second write or a gap; a Stripe renewal during a
 * stuck hold is realigned and the engine bills only the period after it; a
 * Stripe subscription ended by someone else is an anomaly, never guessed; a
 * reverted release is re-asserted; and the proxy refuses a migrated
 * customer's writes.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import type Stripe from 'stripe';
import type { OxyAuthRequest } from '@oxy.so/core/server';

setDefaultTimeout(30_000);

const { installFakeCardProvider } = await import('../../../__tests__/helpers/fakeCardProvider');
const card = await installFakeCardProvider();
const { setStripeModes, stripeModeFixture } = await import(
  '../../../__tests__/helpers/stripeModes'
);
const { createGateway } = await import('../../../server');
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  '../../../__tests__/helpers/gatewayTestDatabase'
);
const { must } = await import('../../../__tests__/helpers/must');
const { bindBillingObject } = await import('../../../db/billing/billingRepository');
const { insertCustomerBinding, findCustomerForMerchant } = await import(
  '../../../db/customers/customerRepository'
);
const { findSubscriptionForMerchant } = await import(
  '../../../db/billingEngine/subscriptionRepository'
);
const { billingProxyMigrations, customers } = await import('../../../db/schema');
const { eq } = await import('drizzle-orm');
const { runProxyMigration } = await import('../proxyMigration');
const { createBillingService } = await import('../billingService');
const { BillingError } = await import('../contracts');
type MerchantRow = import('../../../db/merchants/merchantRepository').MerchantRow;
type ProxyMigrationProvider = import('../proxyMigration').ProxyMigrationProvider;
type ProxyMigrationRun = import('../proxyMigration').ProxyMigrationRun;

// biome-ignore lint/suspicious/noExplicitAny: wire JSON read by many assertions
type Json = Record<string, any>;

// ---- The fake Stripe ----------------------------------------------------------------

const ACCOUNT = 'acct_platform';
const DAY = 86_400;

interface FakeStripe extends ProxyMigrationProvider {
  subscriptions: Map<string, Json>;
  customers: Map<string, Json>;
  prices: Map<string, Json>;
  methods: Map<string, Json>;
  invoices: Map<string, { id: string; status: string }[]>;
  updates: { ref: string; params: Stripe.SubscriptionUpdateParams; key: string }[];
  /** The next update: `throw` before applying it, `lose` the answer after applying it. */
  failNextUpdate: 'throw' | 'lose' | null;
}

function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    livemode: false,
    subscriptions: new Map(),
    customers: new Map(),
    prices: new Map(),
    methods: new Map(),
    invoices: new Map(),
    updates: [],
    failNextUpdate: null,
    account: async () => ({ id: ACCOUNT }),
    retrieveSubscription: async (ref) => structuredClone(must(fake.subscriptions.get(ref))),
    retrieveCustomer: async (ref) => structuredClone(must(fake.customers.get(ref))),
    retrievePrice: async (ref) => structuredClone(must(fake.prices.get(ref))),
    listSubscriptionInvoices: async (ref) => ({
      has_more: false,
      data: fake.invoices.get(ref) ?? [],
    }),
    readPaymentMethod: async (ref) => {
      const method = must(fake.methods.get(ref));
      return {
        providerObjectId: method.id,
        card: {
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030,
          country: 'IE',
          funding: 'credit',
        },
        billingDetails: { address: null, email: null, name: null, phone: null },
        customerObjectId: method.customer,
      };
    },
    updateSubscription: async (ref, params, key) => {
      const failure = fake.failNextUpdate;
      fake.failNextUpdate = null;
      if (failure === 'throw') throw new Error('network down');
      fake.updates.push({ ref, params, key });
      const sub = must(fake.subscriptions.get(ref));
      if (params.cancel_at_period_end !== undefined)
        sub.cancel_at_period_end = params.cancel_at_period_end;
      if (params.pause_collection !== undefined) sub.pause_collection = params.pause_collection;
      if (params.metadata) sub.metadata = { ...sub.metadata, ...(params.metadata as Json) };
      if (failure === 'lose') throw new Error('answer lost');
      return structuredClone(sub);
    },
  };
  return fake;
}

// ---- The gateway (for reading the native objects back) ---------------------------------

let appId = 'app_proxy_migration';
let baseUrl = '';
let gateway: ReturnType<typeof createGateway> | undefined;
let merchant: MerchantRow;
let stripe: FakeStripe;
let restoreModes: () => void = () => undefined;
let counter = 0;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId,
    appName: 'migration',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'development',
    tier: 'internal',
  };
  next();
};

useGatewayDatabase();

beforeAll(() => {
  card.enabled = true;
  restoreModes = setStripeModes({ test: stripeModeFixture('test') });
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
    publicRateLimit: (_req, _res, next) => next(),
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  card.enabled = false;
  gateway?.httpServer.close();
  gateway?.watcher.stop();
  restoreModes();
});

let orbitPrice: Json;
/** Bindings are unique per Stripe object across merchants: each case has its own price. */
let stripePrice = 'price_stripePlus';
let plan: { cohorts: Record<string, { prices: Record<string, string> }> };

beforeEach(async () => {
  appId = `app_pm_${++counter}`;
  merchant = await seedMerchant({ oxyAppId: appId, environment: 'development' });
  stripe = fakeStripe();
  stripePrice = `price_stripePlus${counter}`;
  card.calls.length = 0;
  const product = (await ok('POST', '/v1/products', { name: 'Mention Plus' })).id;
  const feature = await ok('POST', '/v1/entitlements/features', {
    lookup_key: 'mention_plus',
    name: 'Mention Plus',
  });
  await ok('POST', `/v1/products/${product}/features`, { entitlement_feature: feature.id });
  orbitPrice = await ok('POST', '/v1/prices', {
    product,
    currency: 'USD',
    unit_amount: '599',
    tax_behavior: 'inclusive',
    recurring: { interval: 'month' },
  });
  stripe.prices.set(stripePrice, {
    id: stripePrice,
    currency: 'usd',
    unit_amount: 599,
    billing_scheme: 'per_unit',
    type: 'recurring',
    tax_behavior: 'inclusive',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  });
  plan = { cohorts: { [merchant.publicId]: { prices: { [stripePrice]: orbitPrice.id } } } };
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json };
}

async function ok(method: string, path: string, body?: unknown): Promise<Json> {
  const answer = await call(method, path, body);
  if (answer.status !== 200 && answer.status !== 201) {
    throw new Error(`${method} ${path} → ${answer.status} ${JSON.stringify(answer.json)}`);
  }
  return answer.json;
}

const deployment = () => ({
  provider: 'stripe' as const,
  platformAccountId: ACCOUNT,
  livemode: false,
});
const owner = () => ({
  merchantId: merchant.id,
  oxyAppId: merchant.oxyAppId,
  environment: merchant.environment,
});

/** A month anchored at `anchor`, whose current period contains `now` (Unix seconds). */
function monthAround(now: number): { start: number; end: number } {
  const d = new Date(now * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  // Keep clear of the lead window whatever day the suite runs on.
  if (end - now < 3 * DAY) return monthAround(end + DAY);
  return { start, end };
}

interface Proxied {
  store: string;
  sub: string;
  cus: string;
  pm: string;
  bindingId: string;
}

/** A proxied subscription: bound in Peable, present at the fake Stripe. */
async function proxied(
  overrides: Json = {},
  period: { start: number; end: number } = monthAround(Math.floor(Date.now() / 1000)),
): Promise<Proxied> {
  const n = ++counter;
  const cus = `cus_proxy${n}`;
  const sub = `sub_proxy${n}`;
  const pm = `pm_proxy${n}`;
  const c = await bindBillingObject(gatewayDb(), deployment(), owner(), {
    kind: 'customer',
    providerRef: cus,
    externalSubjectRef: `store_${n}`,
    bindingEvidenceRef: 'fixture:import',
  });
  const p =
    (await gatewayDb().query.billingObjectBindings.findFirst({
      where: (b, { and, eq }) =>
        and(eq(b.merchantId, merchant.id), eq(b.kind, 'price'), eq(b.providerRef, stripePrice)),
    })) ??
    (await bindBillingObject(gatewayDb(), deployment(), owner(), {
      kind: 'price',
      providerRef: stripePrice,
      planRef: 'mention_plus_monthly',
      bindingEvidenceRef: 'fixture:import',
    }));
  const s = await bindBillingObject(gatewayDb(), deployment(), owner(), {
    kind: 'subscription',
    providerRef: sub,
    externalSubjectRef: `store_${n}`,
    planRef: 'mention_plus_monthly',
    customerBindingId: c.id,
    priceBindingId: p.id,
    bindingEvidenceRef: 'fixture:import',
  });
  stripe.customers.set(cus, {
    id: cus,
    email: `payer${n}@example.test`,
    name: 'Payer',
    address: {
      line1: '1 Main St',
      line2: null,
      city: 'Dublin',
      state: null,
      postal_code: 'D01',
      country: 'IE',
    },
    invoice_settings: { default_payment_method: null },
  });
  stripe.methods.set(pm, { id: pm, customer: cus });
  stripe.subscriptions.set(sub, {
    id: sub,
    customer: cus,
    livemode: false,
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    ended_at: null,
    start_date: period.start - 31 * DAY,
    billing_cycle_anchor: period.start,
    trial_start: null,
    trial_end: null,
    default_payment_method: pm,
    discounts: [],
    pause_collection: null,
    automatic_tax: { enabled: false },
    metadata: {},
    items: {
      has_more: false,
      data: [
        {
          price: { id: stripePrice },
          quantity: 1,
          current_period_start: period.start,
          current_period_end: period.end,
        },
      ],
    },
    ...overrides,
  });
  stripe.invoices.set(sub, [{ id: `in_paid${n}`, status: 'paid' }]);
  return { store: `store_${n}`, sub, cus, pm, bindingId: s.id };
}

const run = (dryRun: boolean): Promise<ProxyMigrationRun> =>
  dryRun
    ? runProxyMigration({ db: gatewayDb(), livemode: false, provider: stripe, plan, dryRun: true })
    : runProxyMigration({
        db: gatewayDb(),
        livemode: false,
        provider: stripe,
        plan,
        dryRun: false,
      });

function lines(report: ProxyMigrationRun) {
  return report.cohorts.find((c) => c.merchant === merchant.publicId)?.subscriptions ?? [];
}

async function migrations() {
  return gatewayDb()
    .select()
    .from(billingProxyMigrations)
    .where(eq(billingProxyMigrations.merchantId, merchant.id));
}

// ---- The cases ----------------------------------------------------------------------

describe('the dry run', () => {
  test('reports each subscription per cohort with its reason, and writes nothing', async () => {
    const good = await proxied();
    const now = Math.floor(Date.now() / 1000);
    await proxied({ status: 'incomplete' });
    await proxied({ status: 'past_due' });
    await proxied({ status: 'canceled' });
    await proxied({ discounts: ['di_1'] });
    await proxied({ default_payment_method: null });
    await proxied({}, { start: now - 29 * DAY, end: now + DAY });
    const open = await proxied();
    stripe.invoices.set(open.sub, [{ id: 'in_open', status: 'open' }]);
    const report = await run(true);
    const cohort = must(report.cohorts.find((c) => c.merchant === merchant.publicId));
    expect(report).toMatchObject({ mode: 'test', dry_run: true });
    expect(cohort.counts).toEqual({ migrate: 1, resume: 0, released: 0, skip: 1, blocked: 6 });
    expect(cohort.blocked).toEqual({
      status_incomplete: 1,
      status_past_due: 1,
      discount: 1,
      no_payment_method: 1,
      period_ends_soon: 1,
      open_invoice: 1,
    });
    expect(lines(report).find((l) => l.provider_subscription === good.sub)).toMatchObject({
      action: 'migrate',
      customer: 'new',
      price: orbitPrice.id,
      status: 'active',
      automatic_tax: false,
    });
    expect(stripe.updates).toEqual([]);
    expect(await migrations()).toEqual([]);
    expect(
      await gatewayDb().select().from(customers).where(eq(customers.merchantId, merchant.id)),
    ).toEqual([]);
  });

  test('blocks an unmapped or mismatched price and a missing key, never guessing', async () => {
    await proxied();
    plan = { cohorts: {} };
    expect(must(lines(await run(true))[0]).reason).toBe('price_unmapped');
    const cheaper = await ok('POST', '/v1/prices', {
      product: orbitPrice.product,
      currency: 'USD',
      unit_amount: '499',
      tax_behavior: 'inclusive',
      recurring: { interval: 'month' },
    });
    plan = { cohorts: { [merchant.publicId]: { prices: { [stripePrice]: cheaper.id } } } };
    expect(must(lines(await run(true))[0]).reason).toBe('price_mismatch_unit_amount');
    const keyless = await runProxyMigration({
      db: gatewayDb(),
      livemode: false,
      plan,
      dryRun: true,
    });
    expect(must(lines(keyless)[0]).reason).toBe('provider_key_missing');
  });
});

describe('executing', () => {
  test('adopts, releases Stripe, then the hold — and a rerun changes nothing', async () => {
    const proxy = await proxied();
    const report = await run(false);
    const line = must(lines(report)[0]);
    expect(line).toMatchObject({ action: 'migrate', outcome: 'migrated' });
    // Stripe: no renewal, collection voided, no proration — and the marker.
    expect(stripe.updates).toHaveLength(1);
    expect(must(stripe.updates[0]).params).toEqual({
      cancel_at_period_end: true,
      pause_collection: { behavior: 'void' },
      proration_behavior: 'none',
      metadata: { orbit_subscription: must(line.subscription) },
    });
    // Native: the same customer (bound, no new Stripe customer), the same card, released.
    const sub = await ok('GET', `/v1/subscriptions/${line.subscription}`);
    const item = must(stripe.subscriptions.get(proxy.sub)).items.data[0];
    expect(sub).toMatchObject({
      status: 'active',
      current_period_start: item.current_period_start,
      current_period_end: item.current_period_end,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: { store_id: expect.stringMatching(/^store_/), plan_id: 'mention_plus_monthly' },
    });
    const customer = await ok('GET', `/v1/customers/${sub.customer}`);
    expect(customer).toMatchObject({
      email: expect.stringMatching(/@example.test$/),
      address: { country: 'IE' },
      metadata: { store_id: expect.stringMatching(/^store_/) },
    });
    // The consumer finds the customer that replaced its proxy customer by its own store id.
    const found = await ok(
      'GET',
      `/v1/customers/search?query=${encodeURIComponent(`metadata['store_id']:'${proxy.store}'`)}`,
    );
    expect(found.data.map((c: Json) => c.id)).toEqual([sub.customer]);
    const methods = await ok('GET', `/v1/payment_methods?customer=${sub.customer}`);
    expect(methods.data).toHaveLength(1);
    expect(customer.invoice_settings.default_payment_method).toBe(methods.data[0].id);
    expect(sub.default_payment_method).toBe(methods.data[0].id);
    const access = await ok('GET', `/v1/entitlements/active_entitlements?customer=${sub.customer}`);
    expect(access.data.map((e: Json) => e.lookup_key)).toEqual(['mention_plus']);
    const row = must(await findSubscriptionForMerchant(gatewayDb(), sub.id, merchant.id));
    expect(row.providerHandoffPending).toBe(false);
    expect(row.nextActionAt).not.toBeNull();
    expect((await migrations()).map((m) => m.state)).toEqual(['released']);
    expect(card.calls).toEqual([]);

    const again = await run(false);
    expect(must(lines(again)[0])).toMatchObject({ action: 'released', outcome: 'verified' });
    expect(stripe.updates).toHaveLength(1);
    expect(await migrations()).toHaveLength(1);
  });

  test('a subscriber who had cancelled keeps the cancellation natively', async () => {
    await proxied({ cancel_at_period_end: true });
    const line = must(lines(await run(false))[0]);
    expect(line.outcome).toBe('migrated');
    expect((await ok('GET', `/v1/subscriptions/${line.subscription}`)).cancel_at_period_end).toBe(
      true,
    );
  });

  test('a crash before Stripe answered resumes: one release, access throughout', async () => {
    const proxy = await proxied();
    stripe.failNextUpdate = 'throw';
    const first = must(lines(await run(false))[0]);
    expect(first.outcome).toBe('failed:Error:network down');
    expect((await migrations()).map((m) => m.state)).toEqual(['adopted']);
    // Held: Stripe still renews, the engine cannot; the payer has access.
    const held = must(
      await findSubscriptionForMerchant(gatewayDb(), must(first.subscription), merchant.id),
    );
    expect(held.providerHandoffPending).toBe(true);
    expect(held.nextActionAt).toBeNull();
    const customer = must(
      await gatewayDb().query.customers.findFirst({
        where: (c, { eq }) => eq(c.id, held.customerId),
      }),
    );
    const access = await ok(
      'GET',
      `/v1/entitlements/active_entitlements?customer=${customer.publicId}`,
    );
    expect(access.data).toHaveLength(1);
    // The proxy is frozen for this customer from the adoption on.
    expect(must(stripe.subscriptions.get(proxy.sub)).cancel_at_period_end).toBe(false);

    const second = must(lines(await run(false))[0]);
    expect(second).toMatchObject({ action: 'resume', outcome: 'released' });
    expect(stripe.updates).toHaveLength(1);
    expect((await migrations()).map((m) => m.state)).toEqual(['released']);
  });

  test('a crash after Stripe applied the release reads it back, and never writes twice', async () => {
    await proxied();
    stripe.failNextUpdate = 'lose';
    expect(must(lines(await run(false))[0]).outcome).toBe('failed:Error:answer lost');
    expect(stripe.updates).toHaveLength(1);
    expect(must(lines(await run(false))[0]).outcome).toBe('released');
    expect(stripe.updates).toHaveLength(1);
  });

  test('Stripe renewed during a stuck hold: realigned, and the engine bills only the next period', async () => {
    // A clocked Orbit customer already bound to the Stripe customer (the job reuses it).
    const T = Date.UTC(2027, 0, 10) / 1000;
    const P0 = Date.UTC(2027, 0, 1) / 1000;
    const P1 = Date.UTC(2027, 1, 1) / 1000;
    const P2 = Date.UTC(2027, 2, 1) / 1000;
    const clock = (await ok('POST', '/v1/test_helpers/test_clocks', { frozen_time: T })).id;
    const orbit = await ok('POST', '/v1/customers', { email: 'c@example.test', test_clock: clock });
    const proxy = await proxied({}, { start: P0, end: P1 });
    const row = must(await findCustomerForMerchant(gatewayDb(), orbit.id, merchant.id));
    await insertCustomerBinding(gatewayDb(), {
      customerId: row.id,
      provider: 'stripe',
      providerObjectId: proxy.cus,
    });
    stripe.failNextUpdate = 'throw';
    const first = must(lines(await run(false))[0]);
    expect(first.customer).toBe(orbit.id);
    // Weeks pass with the hold stuck: Stripe renews into [P1, P2]; the engine does nothing.
    await ok('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, {
      frozen_time: P1 + 5 * DAY,
    });
    expect((await ok('GET', `/v1/invoices?subscription=${first.subscription}`)).data).toEqual([]);
    const at = must(stripe.subscriptions.get(proxy.sub));
    at.items.data[0].current_period_start = P1;
    at.items.data[0].current_period_end = P2;
    const resumed = must(lines(await run(false))[0]);
    expect(resumed.outcome).toBe('realigned_and_released');
    expect(await ok('GET', `/v1/subscriptions/${first.subscription}`)).toMatchObject({
      current_period_start: P1,
      current_period_end: P2,
    });
    await ok('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, {
      frozen_time: P2 + 3 * 3600,
    });
    const invoices = (await ok('GET', `/v1/invoices?subscription=${first.subscription}`)).data;
    expect(invoices.map((i: Json) => [i.period_start, i.status, i.amount_paid])).toEqual([
      [P2, 'paid', '599'],
    ]);
    expect(card.payments.size).toBeGreaterThan(0);
  });

  test('a Stripe subscription someone else ended during the hold is an anomaly, left adopted', async () => {
    const proxy = await proxied();
    stripe.failNextUpdate = 'throw';
    await run(false);
    const at = must(stripe.subscriptions.get(proxy.sub));
    at.status = 'canceled';
    at.ended_at = Math.floor(Date.now() / 1000);
    expect(must(lines(await run(false))[0]).outcome).toBe('anomaly:provider_ended_early');
    expect((await migrations()).map((m) => m.state)).toEqual(['adopted']);
  });

  test('a release undone at Stripe is reported by the dry run and re-asserted by the run', async () => {
    const proxy = await proxied();
    await run(false);
    const at = must(stripe.subscriptions.get(proxy.sub));
    at.cancel_at_period_end = false;
    at.pause_collection = null;
    expect(must(lines(await run(true))[0]).outcome).toBe('provider_release_reverted');
    expect(stripe.updates).toHaveLength(1);
    expect(must(lines(await run(false))[0]).outcome).toBe('reasserted');
    expect(stripe.updates).toHaveLength(2);
    expect(must(stripe.subscriptions.get(proxy.sub)).cancel_at_period_end).toBe(true);
  });

  test('the proxy refuses a migrated customer its checkout, portal and cancellation', async () => {
    const proxy = await proxied();
    await run(false);
    const unreachable = async () => {
      throw new Error('the provider must not be reached');
    };
    const service = createBillingService({
      db: gatewayDb(),
      provider: {
        deployment: deployment(),
        verifyDeployment: unreachable,
        verifyPortalConfiguration: unreachable,
        ensureCustomer: unreachable,
        createCheckoutSession: unreachable,
        createPortalSession: unreachable,
        retrieveSubscription: unreachable,
        cancelAtPeriodEnd: unreachable,
      },
      cohorts: [{ ...owner(), ...deployment(), evidenceRef: 'fixture' }],
    });
    const refusal = { code: 'subscription_migrated', status: 409 };
    await expect(
      service.createPortalSession(owner(), {
        provider_customer_id: proxy.cus,
        return_url: 'https://example.test/return',
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      service.createCheckoutSession(
        owner(),
        {
          store_id: proxy.store,
          plan_id: 'mention_plus_monthly',
          provider_customer_id: proxy.cus,
          provider_price_id: stripePrice,
          trial_days: 0,
          return_url: 'https://example.test/return',
        },
        'checkout-key-0001',
      ),
    ).rejects.toMatchObject(refusal);
    expect(BillingError).toBeDefined();
    await expect(service.cancelAtPeriodEnd(owner(), proxy.sub)).rejects.toMatchObject(refusal);
  });
});
