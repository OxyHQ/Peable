/**
 * Adopting a provider-billed subscription (ADR 0018 §7), against a real
 * Postgres, a fake card provider and test clocks driving time.
 *
 * Pinned: an adoption writes the subscription in its current state with no
 * invoice and grants its entitlements at once; while the previous provider
 * still renews it, the subscription is inert — no renewal, no trial end, no
 * merchant change — however far time moves; the release hands renewal to the
 * engine (a period end already past renews at the next pass, charged
 * off-session against the adopted card); a provider renewal during the hold
 * realigns the period instead of billing it twice; and a prorating item change
 * inside the provider-billed period is refused.
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
import type { OxyAuthRequest } from '@oxy.so/core/server';

setDefaultTimeout(30_000);

const { installFakeCardProvider } = await import('../../../__tests__/helpers/fakeCardProvider');
const card = await installFakeCardProvider();
const { setStripeModes, stripeModeFixture } = await import(
  '../../../__tests__/helpers/stripeModes'
);
const { createGateway } = await import('../../../server');
const { gatewayDb, seedMerchant, storedEvents, useGatewayDatabase } = await import(
  '../../../__tests__/helpers/gatewayTestDatabase'
);
const { must } = await import('../../../__tests__/helpers/must');
const { registerPaymentMethod } = await import('../../../db/customers/paymentMethodRepository');
const { findCustomerForMerchant } = await import('../../../db/customers/customerRepository');
const { findPriceForMerchant } = await import('../../../db/catalog/priceRepository');
const { findSubscriptionForMerchant } = await import(
  '../../../db/billingEngine/subscriptionRepository'
);
const { adoptSubscription, realignHeldPeriod, releaseProviderHandoff } = await import(
  '../adoption'
);
const { runBillingEnginePass } = await import('../scheduler');
type MerchantRow = import('../../../db/merchants/merchantRepository').MerchantRow;

// biome-ignore lint/suspicious/noExplicitAny: wire JSON read by many assertions
type Json = Record<string, any>;
let appId = 'app_adoption';
let baseUrl = '';
let gateway: ReturnType<typeof createGateway> | undefined;
let merchant: MerchantRow;
let restoreModes: () => void = () => undefined;
let counter = 0;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId,
    appName: 'adoption',
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

beforeEach(async () => {
  appId = `app_adopt_${++counter}`;
  merchant = await seedMerchant({ oxyAppId: appId, environment: 'development' });
  card.confirmPlan.length = 0;
  card.calls.length = 0;
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

const DAY = 86_400;
/** The previous provider's period: anchored 1 Jan, the clock mid-period. */
const P0 = Date.UTC(2027, 0, 1) / 1000;
const P1 = Date.UTC(2027, 1, 1) / 1000;
const P2 = Date.UTC(2027, 2, 1) / 1000;
const P3 = Date.UTC(2027, 3, 1) / 1000;
const NOW = P0 + 10 * DAY;

const at = (seconds: number) => new Date(seconds * 1000);

async function advance(clockId: string, to: number): Promise<void> {
  const advanced = await ok('POST', `/v1/test_helpers/test_clocks/${clockId}/advance`, {
    frozen_time: to,
  });
  expect(advanced.status).toBe('ready');
}

interface Fixture {
  clock: string;
  customer: Json;
  price: Json;
  method: string;
}

/** A clocked customer with a saved card, and a Plus price whose product grants `mention_plus`. */
async function fixture(): Promise<Fixture> {
  const clock = (
    await ok('POST', '/v1/test_helpers/test_clocks', { frozen_time: NOW, name: 'adopt' })
  ).id as string;
  const customer = await ok('POST', '/v1/customers', {
    email: 'payer@example.test',
    test_clock: clock,
  });
  const row = must(await findCustomerForMerchant(gatewayDb(), customer.id, merchant.id));
  const { row: method } = await registerPaymentMethod(gatewayDb(), {
    publicId: `pm_adopt${++counter}`,
    merchantId: merchant.id,
    customerId: row.id,
    card: {
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: 2030,
      country: 'IE',
      funding: 'credit',
    },
    billingDetails: { address: null, email: null, name: null, phone: null },
    provider: 'stripe',
    providerObjectId: `pm_provider_adopt${counter}`,
  });
  const product = (await ok('POST', '/v1/products', { name: 'Mention Plus' })).id;
  const feature = await ok('POST', '/v1/entitlements/features', {
    lookup_key: 'mention_plus',
    name: 'Mention Plus',
  });
  await ok('POST', `/v1/products/${product}/features`, { entitlement_feature: feature.id });
  const price = await ok('POST', '/v1/prices', {
    product,
    currency: 'USD',
    unit_amount: '599',
    recurring: { interval: 'month' },
  });
  return { clock, customer, price, method: method.id };
}

async function adopt(
  f: Fixture,
  overrides: Partial<Parameters<typeof adoptSubscription>[1]> = {},
): Promise<string> {
  const customer = must(await findCustomerForMerchant(gatewayDb(), f.customer.id, merchant.id));
  const price = must(await findPriceForMerchant(gatewayDb(), f.price.id, merchant.id));
  const row = await gatewayDb().transaction((tx) =>
    adoptSubscription(tx, {
      merchant,
      customer,
      price,
      defaultPaymentMethodId: f.method,
      status: 'active',
      startDate: at(P0 - 40 * DAY),
      billingCycleAnchor: at(P0 - 31 * DAY),
      currentPeriodStart: at(P0),
      currentPeriodEnd: at(P1),
      trialStart: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      automaticTax: false,
      metadata: { store_id: 'store_1' },
      ...overrides,
    }),
  );
  return row.publicId;
}

async function release(publicId: string): Promise<void> {
  const row = must(await findSubscriptionForMerchant(gatewayDb(), publicId, merchant.id));
  await gatewayDb().transaction((tx) => releaseProviderHandoff(tx, row.id));
}

const invoicesOf = async (sub: string): Promise<Json[]> =>
  (await ok('GET', `/v1/invoices?subscription=${sub}&limit=100`)).data;

describe('adopting a provider-billed subscription', () => {
  test('is written in its current state with no invoice, and grants access at once', async () => {
    const f = await fixture();
    const sub = await adopt(f);
    const read = await ok('GET', `/v1/subscriptions/${sub}`);
    expect(read).toMatchObject({
      status: 'active',
      current_period_start: P0,
      current_period_end: P1,
      billing_cycle_anchor: P0 - 31 * DAY,
      latest_invoice: null,
      collection_method: 'charge_automatically',
      metadata: { store_id: 'store_1' },
    });
    expect(await invoicesOf(sub)).toEqual([]);
    expect(card.calls).toEqual([]);
    const active = await ok(
      'GET',
      `/v1/entitlements/active_entitlements?customer=${f.customer.id}`,
    );
    expect(active.data.map((e: Json) => e.lookup_key)).toEqual(['mention_plus']);
    const types = (await storedEvents({ merchantId: merchant.id })).map(({ row }) => row.type);
    expect(types).toContain('customer.subscription.created');
    expect(types).toContain('entitlements.active_entitlement_summary.updated');
  });

  test('is inert while the previous provider renews it, however far time moves', async () => {
    const f = await fixture();
    const sub = await adopt(f);
    await advance(f.clock, P2 + DAY);
    await runBillingEnginePass();
    const read = await ok('GET', `/v1/subscriptions/${sub}`);
    expect(read).toMatchObject({ status: 'active', current_period_end: P1 });
    expect(await invoicesOf(sub)).toEqual([]);
    expect(card.calls).toEqual([]);
    // The migration owns it until the release: no merchant change in between.
    const update = await call('POST', `/v1/subscriptions/${sub}`, { cancel_at_period_end: true });
    expect(update.status).toBe(409);
    expect(update.json.error.code).toBe('subscription_unexpected_state');
    expect((await call('DELETE', `/v1/subscriptions/${sub}`, {})).status).toBe(409);
  });

  test('a trial the previous provider runs does not end here while held', async () => {
    const f = await fixture();
    const sub = await adopt(f, {
      status: 'trialing',
      trialStart: at(P0),
      trialEnd: at(P0 + 14 * DAY),
      billingCycleAnchor: at(P0 + 14 * DAY),
      currentPeriodEnd: at(P0 + 14 * DAY),
    });
    await advance(f.clock, P0 + 20 * DAY);
    expect((await ok('GET', `/v1/subscriptions/${sub}`)).status).toBe('trialing');
    expect(await invoicesOf(sub)).toEqual([]);
  });

  test('released, the engine renews at the period end and charges the adopted card', async () => {
    const f = await fixture();
    const sub = await adopt(f);
    await release(sub);
    await advance(f.clock, P1 + 2 * 3600);
    const [renewal, ...rest] = await invoicesOf(sub);
    expect(rest).toEqual([]);
    expect(renewal).toMatchObject({
      billing_reason: 'subscription_cycle',
      status: 'paid',
      amount_paid: '599',
      period_start: P1,
      period_end: P2,
    });
    expect(card.calls).toEqual([
      'test:createCustomer',
      'test:createPayment:599',
      'test:confirm:succeed',
    ]);
    const fake = must([...card.payments.values()][0]);
    expect(fake.method).toBe(`pm_provider_adopt${counter}`);
    expect(await ok('GET', `/v1/subscriptions/${sub}`)).toMatchObject({
      current_period_start: P1,
      current_period_end: P2,
    });
  });

  test('released after its period end, it renews at the next pass — one charge, none missed', async () => {
    const f = await fixture();
    const sub = await adopt(f);
    await advance(f.clock, P1 + DAY);
    expect(await invoicesOf(sub)).toEqual([]);
    await release(sub);
    await advance(f.clock, P1 + DAY + 3 * 3600);
    const list = await invoicesOf(sub);
    expect(list.map((i) => [i.period_start, i.status])).toEqual([[P1, 'paid']]);
  });

  test('a provider renewal during the hold is realigned, never billed twice', async () => {
    const f = await fixture();
    const sub = await adopt(f);
    await advance(f.clock, P1 + 5 * DAY);
    const row = must(await findSubscriptionForMerchant(gatewayDb(), sub, merchant.id));
    await gatewayDb().transaction(async (tx) => {
      await realignHeldPeriod(tx, row.id, {
        status: 'active',
        currentPeriodStart: at(P1),
        currentPeriodEnd: at(P2),
      });
      await releaseProviderHandoff(tx, row.id);
    });
    await runBillingEnginePass();
    expect(await invoicesOf(sub)).toEqual([]);
    await advance(f.clock, P2 + 2 * 3600);
    const list = await invoicesOf(sub);
    expect(list.map((i) => [i.period_start, i.period_end, i.status])).toEqual([[P2, P3, 'paid']]);
  });

  test('a prorating item change inside the provider-billed period is refused', async () => {
    const f = await fixture();
    const sub = await adopt(f);
    await release(sub);
    const bigger = await ok('POST', '/v1/prices', {
      product: f.price.product,
      currency: 'USD',
      unit_amount: '999',
      recurring: { interval: 'month' },
    });
    const item = (await ok('GET', `/v1/subscriptions/${sub}`)).items.data[0].id;
    const refused = await call('POST', `/v1/subscriptions/${sub}`, {
      items: [{ id: item, price: bigger.id }],
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.param).toBe('proration_behavior');
    await ok('POST', `/v1/subscriptions/${sub}`, {
      items: [{ id: item, price: bigger.id }],
      proration_behavior: 'none',
    });
    expect(await invoicesOf(sub)).toEqual([]);
    await advance(f.clock, P1 + 2 * 3600);
    expect((await invoicesOf(sub)).map((i) => i.amount_paid)).toEqual(['999']);
  });

  test('refuses a period that is not current, or not the price interval from its anchor', async () => {
    const f = await fixture();
    await expect(
      adopt(f, { currentPeriodStart: at(P1), currentPeriodEnd: at(P2) }),
    ).rejects.toThrow('only a subscription inside its current period can be adopted');
    await expect(adopt(f, { billingCycleAnchor: at(P0 + 3 * DAY) })).rejects.toThrow(
      "the current period is not the price's interval from the billing cycle anchor",
    );
    expect((await ok('GET', '/v1/subscriptions?status=all')).data).toEqual([]);
  });
});
