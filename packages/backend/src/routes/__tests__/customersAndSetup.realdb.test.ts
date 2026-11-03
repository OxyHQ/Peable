/**
 * Customers, payment methods and SetupIntents (ADR 0016) — over HTTP, against a
 * real database, with one recording fake provider PER MODE behind the registry
 * (the `environmentIsolation.realdb.test.ts` idiom).
 *
 * What is pinned: the CRUD surface and its list contract; that a `pm_…` is born
 * from a SUCCEEDED SetupIntent (through the drain, from the provider's own
 * word) attached to the customer, with its events in the same commit; that
 * detach and customer deletion are permanent and clear the default; that a
 * payment saving its card registers a `pm_…` once; that every lookup is
 * merchant-scoped; and that a production credential's calls reach only the live
 * fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import type { ProviderMode, ProviderSetupResult } from '../../services/providers/provider';

const providerCalls: string[] = [];
let counter = 0;
const next = () => String(++counter);

/** Provider SetupIntent state, keyed by provider id — what `getSetup` answers. */
const setups = new Map<string, ProviderSetupResult>();
/** What `getStatus` answers per provider payment id. */
const payments = new Map<string, { status: 'succeeded'; paymentMethodObjectId: string }>();

function fakeProviderFor(mode: ProviderMode) {
  const record = (fn: string) => providerCalls.push(`${mode}:${fn}`);
  return {
    id: 'stripe' as const,
    createPayment: async () => {
      throw new Error('not used');
    },
    confirm: async () => {
      throw new Error('not used');
    },
    capture: async () => {
      throw new Error('not used');
    },
    cancel: async () => {
      throw new Error('not used');
    },
    refund: async () => {
      throw new Error('not used');
    },
    getStatus: async (providerObjectId: string) => {
      record('getStatus');
      const payment = payments.get(providerObjectId);
      if (!payment) throw new Error(`no payment ${providerObjectId}`);
      return { providerObjectId, ...payment };
    },
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createCustomer: async (request: { customerId: string }) => {
      record(`createCustomer:${request.customerId}`);
      return { providerObjectId: `cus_${mode}_${next()}` };
    },
    createSetup: async (request: { customerObjectId: string; usage: string }) => {
      record(`createSetup:${request.usage}`);
      const result: ProviderSetupResult = {
        providerObjectId: `seti_${mode}_${next()}`,
        status: 'requires_payment_method',
        clientAction: { kind: 'client_secret', value: `seti_secret_${mode}` },
      };
      setups.set(result.providerObjectId, result);
      return result;
    },
    getSetup: async (providerObjectId: string) => {
      record('getSetup');
      const setup = setups.get(providerObjectId);
      if (!setup) throw new Error(`no setup ${providerObjectId}`);
      return setup;
    },
    cancelSetup: async (request: { providerObjectId: string }) => {
      record('cancelSetup');
      const setup = setups.get(request.providerObjectId);
      if (!setup) throw new Error('no setup');
      const canceled = { ...setup, status: 'canceled' as const };
      setups.set(request.providerObjectId, canceled);
      return canceled;
    },
    getPaymentMethod: async (providerObjectId: string) => {
      record(`getPaymentMethod:${providerObjectId}`);
      return {
        providerObjectId,
        card: {
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030,
          country: 'ES',
          funding: 'credit',
        },
        billingDetails: { address: null, email: 'payer@example.test', name: 'Payer', phone: null },
      };
    },
    detachPaymentMethod: async (request: { providerObjectId: string }) => {
      record(`detachPaymentMethod:${request.providerObjectId}`);
    },
  };
}

const fakes = { test: fakeProviderFor('test'), live: fakeProviderFor('live') };

const realRegistry = await import('../../services/providers/registry');
const { resolveProvider: realResolveProvider, resolveCardProvider: realResolveCardProvider } =
  realRegistry;
let useFakeRegistry = false;
const { config } = await import('../../config');
function fakeFor(mode: ProviderMode) {
  return config.stripe[mode]?.cardRail ? fakes[mode] : undefined;
}
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFakeRegistry ? fakeFor(mode) : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFakeRegistry ? fakeFor(mode) : realResolveCardProvider(mode),
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createCustomersRouter } = await import('../customers');
const { createPaymentMethodsRouter } = await import('../paymentMethods');
const { createSetupIntentsRouter } = await import('../setupIntents');
const { gatewayDb, seedIntent, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { linkProviderObject, updateIntentState, findIntentById } = await import(
  '../../db/payments/paymentIntentRepository'
);
const { insertProviderEvent, findProviderEventById } = await import(
  '../../db/providers/providerEventRepository'
);
const { processProviderEvent } = await import('../../services/providers/eventProcessor');
const { saveIntentPaymentMethod } = await import('../../services/customers/paymentMethodService');
const { events, paymentIntents } = await import('../../db/schema');
const { eq } = await import('drizzle-orm');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');

const APP_ID = 'app_customers_setup';
const OTHER_APP_ID = 'app_customers_other';
let credential: { appId: string; environment: OxyServiceEnvironment } = {
  appId: APP_ID,
  environment: 'development',
};

const stubRequireMerchant: RequestHandler = (req, _res, nextHandler) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: credential.appId,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: credential.environment,
    tier: 'external',
  };
  nextHandler();
};
/** The dual-auth routes: a merchant credential only when the test asks for one. */
let payerRequest = false;
const optionalServiceAuth: RequestHandler = (req, res, nextHandler) => {
  if (payerRequest) {
    nextHandler();
    return;
  }
  stubRequireMerchant(req, res, nextHandler);
};

let server: Server;
let baseUrl = '';
let restoreModes: () => void = () => undefined;

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
type Json = any;

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function eventTypes(merchantId: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ type: events.type, at: events.createdAt })
    .from(events)
    .where(eq(events.merchantId, merchantId))
    .orderBy(events.createdAt, events.id);
  return rows.map((row) => row.type);
}

async function deliverSetupEvent(type: string, providerObjectId: string, livemode = false) {
  const n = next();
  const id = await insertProviderEvent(gatewayDb(), {
    provider: 'stripe',
    providerEventId: `evt_setup_${n}`,
    providerAccountId: null,
    type,
    livemode,
    apiVersion: '2026-07-29.dahlia',
    objectIds: { setup_intent: providerObjectId },
    payload: { id: `evt_setup_${n}`, object: 'event' },
  });
  const row = id ? await findProviderEventById(gatewayDb(), id) : null;
  if (!row) throw new Error('event not stored');
  return processProviderEvent(row);
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('customers, payment methods and setup intents', () => {
  useGatewayDatabase();

  let merchantId = '';
  let liveMerchantId = '';
  let devMerchant: Awaited<ReturnType<typeof seedMerchant>> | undefined;

  beforeAll(async () => {
    useFakeRegistry = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    const merchant = await seedMerchant({
      oxyAppId: APP_ID,
      environment: 'development',
      webhookUrl: 'https://merchant.example/hook',
      webhookSecret: 'whsec_merchant',
    });
    merchantId = merchant.id;
    devMerchant = merchant;
    const live = await seedMerchant({
      oxyAppId: APP_ID,
      environment: 'production',
      network: 'mainnet',
      webhookUrl: 'https://merchant.example/hook',
      webhookSecret: 'whsec_merchant',
    });
    liveMerchantId = live.id;
    await seedMerchant({ oxyAppId: OTHER_APP_ID, environment: 'development' });

    const app = express();
    app.use(express.json());
    app.use(createCustomersRouter({ requireMerchant: stubRequireMerchant }));
    app.use(createPaymentMethodsRouter({ requireMerchant: stubRequireMerchant }));
    app.use(
      createSetupIntentsRouter({ requireMerchant: stubRequireMerchant, optionalServiceAuth }),
    );
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
        res.status(500).json({ error: { type: 'api_error', message: error.message } });
      },
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    credential = { appId: APP_ID, environment: 'development' };
    payerRequest = false;
  });

  afterAll(async () => {
    restoreModes();
    useFakeRegistry = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('customer CRUD: create, retrieve, update with clearing and metadata patch, list by email', async () => {
    const created = await call('POST', '/v1/customers', {
      email: 'ada@example.test',
      name: 'Ada',
      phone: '+34600000000',
      address: { line1: 'Calle 1', country: 'ES' },
      metadata: { tier: 'gold', drop: '' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      object: 'customer',
      livemode: false,
      email: 'ada@example.test',
      name: 'Ada',
      address: { line1: 'Calle 1', line2: null, country: 'ES' },
      invoice_settings: { default_payment_method: null },
      metadata: { tier: 'gold' },
    });
    expect(created.body.id).toMatch(/^cus_[0-9a-f]{24}$/);
    // No provider customer yet: the binding is lazy (ADR 0016).
    expect(providerCalls).toEqual([]);

    const updated = await call('POST', `/v1/customers/${created.body.id}`, {
      phone: '',
      name: 'Ada L.',
      metadata: { tier: '', since: '2026' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      name: 'Ada L.',
      phone: null,
      metadata: { since: '2026' },
    });

    await call('POST', '/v1/customers', { email: 'other@example.test' });
    const byEmail = await call('GET', '/v1/customers?email=ada%40example.test');
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.object).toBe('list');
    expect(byEmail.body.data.map((c: Json) => c.id)).toEqual([created.body.id]);

    const retrieved = await call('GET', `/v1/customers/${created.body.id}`);
    expect(retrieved.body.name).toBe('Ada L.');

    const types = await eventTypes(merchantId);
    expect(types.filter((t) => t.startsWith('customer.'))).toEqual([
      'customer.created',
      'customer.updated',
      'customer.created',
    ]);
  });

  test('a new customer cannot name a default payment method, and an unknown field is a 400', async () => {
    const refused = await call('POST', '/v1/customers', {
      invoice_settings: { default_payment_method: 'pm_x' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('invoice_settings[default_payment_method]');
    const unknown = await call('POST', '/v1/customers', { nickname: 'x' });
    expect(unknown.status).toBe(400);
  });

  test("another merchant's customer is a 404, never confirmed", async () => {
    const mine = await call('POST', '/v1/customers', { email: 'mine@example.test' });
    credential = { appId: OTHER_APP_ID, environment: 'development' };
    expect((await call('GET', `/v1/customers/${mine.body.id}`)).status).toBe(404);
    expect((await call('POST', `/v1/customers/${mine.body.id}`, { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/v1/customers/${mine.body.id}`)).status).toBe(404);
    expect(
      (await call('POST', '/v1/setup_intents', { customer: mine.body.id })).body.error.param,
    ).toBe('customer');
  });

  test('a SetupIntent saves a card: provider customer made lazily, pm_ born attached on success', async () => {
    const customer = await call('POST', '/v1/customers', { email: 'saver@example.test' });
    const created = await call('POST', '/v1/setup_intents', {
      customer: customer.body.id,
      usage: 'off_session',
      metadata: { order: '42' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      object: 'setup_intent',
      livemode: false,
      status: 'requires_payment_method',
      usage: 'off_session',
      payment_method_types: ['card'],
      customer: customer.body.id,
      payment_method: null,
      next_action: null,
      metadata: { order: '42' },
    });
    expect(created.body.id).toMatch(/^seti_/);
    expect(created.body.client_secret).toStartWith(`${created.body.id}_secret_`);
    // The provider's credential is never on the DTO.
    expect(JSON.stringify(created.body)).not.toContain('seti_secret_test');
    expect(providerCalls).toEqual([
      `test:createCustomer:${customer.body.id}`,
      'test:createSetup:off_session',
    ]);

    // The payer reads it with Peable's client_secret, and fetches the provider credential.
    payerRequest = true;
    const asPayer = await call(
      'GET',
      `/v1/setup_intents/${created.body.id}?client_secret=${created.body.client_secret}`,
    );
    expect(asPayer.status).toBe(200);
    expect(asPayer.body.id).toBe(created.body.id);
    const wrongSecret = await call(
      'GET',
      `/v1/setup_intents/${created.body.id}?client_secret=nope`,
    );
    expect(wrongSecret.status).toBe(403);
    const action = await call(
      'POST',
      `/v1/setup_intents/${created.body.id}/client_action`,
      {},
      {
        'X-Peable-Client-Secret': created.body.client_secret,
      },
    );
    expect(action.status).toBe(200);
    expect(action.body).toMatchObject({
      object: 'client_action',
      kind: 'client_secret',
      value: 'seti_secret_test',
    });
    payerRequest = false;

    // The provider reports success; the drain makes it true here.
    const providerId = [...setups.keys()].at(-1) as string;
    setups.set(providerId, {
      providerObjectId: providerId,
      status: 'succeeded',
      paymentMethodObjectId: 'pm_stripe_saved_1',
    });
    const outcome = await deliverSetupEvent('setup_intent.succeeded', providerId);
    expect(outcome.kind).toBe('applied');
    // A redelivery is a no-op: one pm_, one set of events.
    expect((await deliverSetupEvent('setup_intent.succeeded', providerId)).kind).toBe('noop');

    const retrieved = await call(
      'GET',
      `/v1/setup_intents/${created.body.id}?expand[]=payment_method`,
    );
    expect(retrieved.body.status).toBe('succeeded');
    expect(retrieved.body.payment_method).toMatchObject({
      object: 'payment_method',
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, funding: 'credit' },
      billing_details: { email: 'payer@example.test', name: 'Payer' },
      customer: customer.body.id,
    });
    const pmId = retrieved.body.payment_method.id as string;
    expect(pmId).toMatch(/^pm_[0-9a-f]{24}$/);
    expect(JSON.stringify(retrieved.body)).not.toContain('pm_stripe_saved_1');

    const listed = await call('GET', `/v1/payment_methods?customer=${customer.body.id}`);
    expect(listed.body.data.map((m: Json) => m.id)).toEqual([pmId]);

    const types = await eventTypes(merchantId);
    expect(
      types.filter((t) => t.startsWith('setup_intent.') || t.startsWith('payment_method.')),
    ).toEqual(['setup_intent.created', 'payment_method.attached', 'setup_intent.succeeded']);

    // The default must be the customer's own attached method.
    const withDefault = await call('POST', `/v1/customers/${customer.body.id}`, {
      invoice_settings: { default_payment_method: pmId },
    });
    expect(withDefault.body.invoice_settings.default_payment_method).toBe(pmId);

    // Update billing details and metadata.
    const updated = await call('POST', `/v1/payment_methods/${pmId}`, {
      billing_details: { name: 'Payer Two' },
      metadata: { nickname: 'work' },
    });
    expect(updated.body.billing_details).toMatchObject({
      name: 'Payer Two',
      email: 'payer@example.test',
    });
    expect(updated.body.metadata).toEqual({ nickname: 'work' });

    // Detach: at the provider first, permanent, default cleared.
    providerCalls.length = 0;
    const detached = await call('POST', `/v1/payment_methods/${pmId}/detach`, {});
    expect(detached.status).toBe(200);
    expect(detached.body.customer).toBeNull();
    expect(providerCalls).toEqual(['test:detachPaymentMethod:pm_stripe_saved_1']);
    const after = await call('GET', `/v1/customers/${customer.body.id}`);
    expect(after.body.invoice_settings.default_payment_method).toBeNull();
    expect(
      (await call('GET', `/v1/payment_methods?customer=${customer.body.id}`)).body.data,
    ).toEqual([]);
    // A second detach answers the detached method and calls nobody.
    providerCalls.length = 0;
    expect((await call('POST', `/v1/payment_methods/${pmId}/detach`, {})).status).toBe(200);
    expect(providerCalls).toEqual([]);
    // ...and a default can no longer name it.
    const refused = await call('POST', `/v1/customers/${customer.body.id}`, {
      invoice_settings: { default_payment_method: pmId },
    });
    expect(refused.status).toBe(400);
  });

  test('a failed attempt is recorded as last_setup_error with setup_intent.setup_failed; cancel ends it', async () => {
    const customer = await call('POST', '/v1/customers', {});
    const created = await call('POST', '/v1/setup_intents', { customer: customer.body.id });
    const providerId = [...setups.keys()].at(-1) as string;
    setups.set(providerId, {
      providerObjectId: providerId,
      status: 'requires_payment_method',
      lastSetupError: {
        type: 'card_error',
        code: 'card_declined',
        declineCode: 'insufficient_funds',
      },
    });
    expect((await deliverSetupEvent('setup_intent.setup_failed', providerId)).kind).toBe('applied');
    const failed = await call('GET', `/v1/setup_intents/${created.body.id}`);
    expect(failed.body.status).toBe('requires_payment_method');
    expect(failed.body.last_setup_error).toEqual({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'insufficient_funds',
      message: 'The card has insufficient funds.',
    });

    const canceled = await call('POST', `/v1/setup_intents/${created.body.id}/cancel`, {
      cancellation_reason: 'requested_by_customer',
    });
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({
      status: 'canceled',
      cancellation_reason: 'requested_by_customer',
    });
    const again = await call('POST', `/v1/setup_intents/${created.body.id}/cancel`, {});
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('setup_intent_unexpected_state');

    const listed = await call('GET', `/v1/setup_intents?customer=${customer.body.id}`);
    expect(listed.body.data.map((s: Json) => s.id)).toEqual([created.body.id]);
    const types = (await eventTypes(merchantId)).filter((t) => t.startsWith('setup_intent.'));
    expect(types.slice(-3)).toEqual([
      'setup_intent.created',
      'setup_intent.setup_failed',
      'setup_intent.canceled',
    ]);
  });

  test('a SetupIntent needs a customer', async () => {
    const refused = await call('POST', '/v1/setup_intents', {});
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('customer');
  });

  test('deleting a customer tombstones it and detaches every method in one commit', async () => {
    const customer = await call('POST', '/v1/customers', { email: 'leaver@example.test' });
    await call('POST', '/v1/setup_intents', { customer: customer.body.id });
    const providerId = [...setups.keys()].at(-1) as string;
    setups.set(providerId, {
      providerObjectId: providerId,
      status: 'succeeded',
      paymentMethodObjectId: 'pm_stripe_leaver',
    });
    await deliverSetupEvent('setup_intent.succeeded', providerId);
    const [pm] = (await call('GET', `/v1/payment_methods?customer=${customer.body.id}`)).body.data;
    await call('POST', `/v1/customers/${customer.body.id}`, {
      invoice_settings: { default_payment_method: pm.id },
    });

    providerCalls.length = 0;
    const deleted = await call('DELETE', `/v1/customers/${customer.body.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: customer.body.id, object: 'customer', deleted: true });
    expect(providerCalls).toEqual(['test:detachPaymentMethod:pm_stripe_leaver']);
    expect((await call('GET', `/v1/customers/${customer.body.id}`)).body.deleted).toBe(true);
    expect((await call('DELETE', `/v1/customers/${customer.body.id}`)).status).toBe(200);
    expect((await call('GET', `/v1/payment_methods/${pm.id}`)).body.customer).toBeNull();
    const list = await call('GET', '/v1/customers?email=leaver%40example.test');
    expect(list.body.data).toEqual([]);
    // A deleted customer saves nothing more.
    expect((await call('POST', '/v1/setup_intents', { customer: customer.body.id })).status).toBe(
      400,
    );
    const types = await eventTypes(merchantId);
    expect(types.slice(-2)).toEqual(['payment_method.detached', 'customer.deleted']);
  });

  test('a card payment that saved its card registers its pm_ once', async () => {
    const customer = await call('POST', '/v1/customers', { email: 'payer@example.test' });
    const { findLiveCustomerForMerchant } = await import('../../db/customers/customerRepository');
    const customerRow = await findLiveCustomerForMerchant(
      gatewayDb(),
      customer.body.id,
      merchantId,
    );
    if (!devMerchant) throw new Error('no merchant');
    const intent = await seedIntent(devMerchant, {
      rail: 'card',
      currency: 'EUR',
      amount: '2000',
    });
    await gatewayDb()
      .update(paymentIntents)
      .set({ customerId: customerRow?.id, setupFutureUsage: 'off_session' })
      .where(eq(paymentIntents.id, intent.id));
    await linkProviderObject(gatewayDb(), intent.id, 'stripe', 'pi_stripe_saver');
    await updateIntentState(gatewayDb(), intent.id, {
      from: 'requires_payment_method',
      status: 'succeeded',
    });
    payments.set('pi_stripe_saver', {
      status: 'succeeded',
      paymentMethodObjectId: 'pm_stripe_from_payment',
    });

    const succeeded = await findIntentById(gatewayDb(), intent.id);
    if (!succeeded) throw new Error('intent vanished');
    await saveIntentPaymentMethod(succeeded);
    await saveIntentPaymentMethod(succeeded);

    const saved = await findIntentById(gatewayDb(), intent.id);
    expect(saved?.paymentMethodPublicId).toMatch(/^pm_/);
    const listed = await call('GET', `/v1/payment_methods?customer=${customer.body.id}`);
    expect(listed.body.data.map((m: Json) => m.id)).toEqual([saved?.paymentMethodPublicId]);
    expect(
      providerCalls.filter((c) => c.startsWith('test:getPaymentMethod')).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test('a production credential reaches only the LIVE provider, and its objects are livemode', async () => {
    credential = { appId: APP_ID, environment: 'production' };
    const customer = await call('POST', '/v1/customers', { email: 'live@example.test' });
    expect(customer.body.livemode).toBe(true);
    const setup = await call('POST', '/v1/setup_intents', { customer: customer.body.id });
    expect(setup.status).toBe(201);
    expect(setup.body.livemode).toBe(true);
    expect(providerCalls.every((c) => c.startsWith('live:'))).toBe(true);
    expect(providerCalls.length).toBe(2);
    const types = await eventTypes(liveMerchantId);
    expect(types).toEqual(['customer.created', 'setup_intent.created']);
  });

  test('a mode with no card rail answers 503 and calls nobody', async () => {
    const restore = setStripeModes({ test: stripeModeFixture('test', { cardRail: false }) });
    try {
      const customer = await call('POST', '/v1/customers', {});
      const refused = await call('POST', '/v1/setup_intents', { customer: customer.body.id });
      expect(refused.status).toBe(503);
      expect(providerCalls).toEqual([]);
    } finally {
      restore();
      setStripeModes({ test: stripeModeFixture('test'), live: stripeModeFixture('live') });
    }
  });
});
