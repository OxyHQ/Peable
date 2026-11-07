/**
 * Risk rules and reviews (ADR 0022) over HTTP, against a real database and a
 * fake provider per mode:
 *
 * - rules as data: create, a predicate refused with its position, versions,
 *   the per-merchant limit, delete;
 * - pre-authorization: a `block` declines a server confirm and the payer's
 *   credential exactly as a declined card (402, `requires_payment_method`,
 *   `last_payment_error`, `payment_intent.payment_failed`, still payable);
 *   `allow` beats `block`; velocity facts; a read records nothing;
 * - post-authorization: `review` opens a review (events, `PaymentIntent.review`,
 *   `Charge.outcome`), holds a manual capture until approved; `block` releases a
 *   held authorization and opens a review on captured money; refuse releases or
 *   refunds; approve and refuse race to one winner;
 * - FairCoin never consults a rule, and a checkout whose card was blocked
 *   still takes FairCoin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type {
  ProviderChargeSnapshot,
  ProviderMode,
  ProviderPaymentResult,
  ProviderPaymentStatus,
} from '../../services/providers/provider';

const calls: string[] = [];
let confirmOutcome: 'succeeded' | 'authorized' | 'challenge' = 'succeeded';
let refundState: 'succeeded' | 'pending' = 'succeeded';
let riskLevel = 'normal';
let snapshotFails = false;
const providerStatus = new Map<string, ProviderPaymentStatus>();
let counter = 0;

function result(providerObjectId: string, status: ProviderPaymentStatus): ProviderPaymentResult {
  providerStatus.set(providerObjectId, status);
  return {
    providerObjectId,
    status,
    clientAction: { kind: 'client_secret', value: `${providerObjectId}_secret` },
    ...(status === 'succeeded' || status === 'requires_capture'
      ? { chargeObjectId: providerObjectId.replace(/^pi_/, 'ch_') }
      : {}),
  };
}

function confirmed(providerObjectId: string): ProviderPaymentResult {
  return result(
    providerObjectId,
    confirmOutcome === 'authorized'
      ? 'requires_capture'
      : confirmOutcome === 'challenge'
        ? 'requires_action'
        : 'succeeded',
  );
}

function fakeProviderFor(mode: ProviderMode) {
  return {
    id: 'stripe' as const,
    createPayment: async (request: Record<string, unknown>) => {
      counter += 1;
      const id = `pi_${mode}_${String(counter)}`;
      calls.push(`createPayment:${request.confirm ? 'confirm' : 'open'}`);
      return request.confirm ? confirmed(id) : result(id, 'requires_payment_method');
    },
    confirm: async (request: Record<string, unknown>) => {
      calls.push('confirm');
      return confirmed(String(request.providerObjectId));
    },
    capture: async (request: Record<string, unknown>) => {
      calls.push('capture');
      return result(String(request.providerObjectId), 'succeeded');
    },
    cancel: async (request: Record<string, unknown>) => {
      calls.push(`cancel:${String(request.cancellationReason)}`);
      return result(String(request.providerObjectId), 'canceled');
    },
    refund: async (request: Record<string, unknown>) => {
      calls.push(`refund:${String((request.amount as { amount: string }).amount)}`);
      return { providerObjectId: `re_${String(request.refundId)}`, state: refundState };
    },
    getStatus: async (providerObjectId: string) =>
      result(providerObjectId, providerStatus.get(providerObjectId) ?? 'requires_payment_method'),
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createCustomer: async (request: { customerId: string }) => ({
      providerObjectId: `cus_stripe_${request.customerId}`,
    }),
    getChargeSnapshot: async (): Promise<ProviderChargeSnapshot> => {
      if (snapshotFails) throw new Error('provider unreachable');
      return {
        outcome: {
          networkStatus: 'approved_by_network',
          riskLevel,
          riskScore: riskLevel === 'highest' ? 91 : 12,
          reason: null,
          type: 'authorized',
        },
        billingDetails: null,
        paymentMethodDetails: {
          type: 'card',
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            country: 'US',
            funding: 'credit',
          },
        },
      };
    },
  };
}

const fakes = { test: fakeProviderFor('test'), live: fakeProviderFor('live') };
const realRegistry = await import('../../services/providers/registry');
const { resolveProvider: realResolveProvider, resolveCardProvider: realResolveCardProvider } =
  realRegistry;
let useFake = false;
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFake ? fakes[mode] : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFake ? fakes[mode] : realResolveCardProvider(mode),
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createPaymentIntentsRouter } = await import('../paymentIntents');
const { createChargesRouter } = await import('../charges');
const { createCheckoutSessionsRouter } = await import('../checkoutSessions');
const { createCatalogApiRouter } = await import('../catalogRoutes');
const { RADAR_ROUTES } = await import('../radar');
const { createBillingEngineRouter } = await import('../billingEngine');
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { must } = await import('../../__tests__/helpers/must');
const { insertCustomer, insertCustomerBinding } = await import(
  '../../db/customers/customerRepository'
);
const { registerPaymentMethod } = await import('../../db/customers/paymentMethodRepository');
const { findIntentByPublicId } = await import('../../db/payments/paymentIntentRepository');
const { charges, events, radarEvaluations, reviews } = await import('../../db/schema');
const { findRefundByExternalRef, markRefundFailed } = await import(
  '../../db/refunds/refundRepository'
);
const { createRefund, emitRefundEvents } = await import('../../services/refunds/refundService');
const { syncChargeFromProvider } = await import('../../services/charges');
const { claimUnjudgedCharges } = await import('../../db/payments/chargeRepository');
const { claimReviewClose, findReviewForMerchant, holdReviewClose } = await import(
  '../../db/radar/radarRepository'
);
const { runJudgeSweep } = await import('../../services/radar/judgeSweeper');
const { eq } = await import('drizzle-orm');
const { uuidv7 } = await import('@oxy.so/db');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');
const { gateBeforeAuthorization } = await import('../../services/radar/gates');
const { evaluateRules } = await import('../../services/radar/evaluate');
const { previewPredicate } = await import('../../services/radar/rules');
const { transitionIntent } = await import('../../services/intentTransition');

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
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

/** The event types recorded about one object, in order. */
async function eventsAbout(objectId: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ type: events.type, dataObject: events.dataObject })
    .from(events)
    .where(eq(events.merchantId, merchant.id))
    .orderBy(events.id);
  return rows.filter((row) => row.dataObject.id === objectId).map((row) => row.type);
}

async function evaluationCount(): Promise<number> {
  return (
    await gatewayDb()
      .select({ id: radarEvaluations.id })
      .from(radarEvaluations)
      .where(eq(radarEvaluations.merchantId, merchant.id))
  ).length;
}

async function customerWithCard(country = 'ES') {
  const suffix = uuidv7().slice(-12);
  const customer = await insertCustomer(gatewayDb(), {
    publicId: `cus_${suffix}`,
    merchantId: merchant.id,
    metadata: {},
    email: `payer_${suffix}@example.test`,
  });
  await insertCustomerBinding(gatewayDb(), {
    customerId: customer.id,
    provider: 'stripe',
    providerObjectId: `cus_stripe_bound_${suffix}`,
  });
  const { row: paymentMethod } = await registerPaymentMethod(gatewayDb(), {
    publicId: `pm_${suffix}`,
    merchantId: merchant.id,
    customerId: customer.id,
    card: {
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: 2030,
      country,
      funding: 'credit',
    },
    billingDetails: { address: null, email: null, name: null, phone: null },
    provider: 'stripe',
    providerObjectId: `pm_stripe_${suffix}`,
  });
  return { customer, paymentMethod };
}

async function rule(action: string, predicate: string): Promise<Json> {
  const created = await call('POST', '/v1/radar/rules', { action, predicate });
  expect(created.status).toBe(200);
  return created.body;
}

async function paidByCard(options: { manual?: boolean; amount?: string } = {}) {
  const { customer, paymentMethod } = await customerWithCard();
  const created = await call('POST', '/v1/payment_intents', {
    amount: options.amount ?? '2500',
    rail: 'card',
    currency: 'EUR',
    customer: customer.publicId,
    payment_method: paymentMethod.publicId,
    ...(options.manual ? { capture_method: 'manual' } : {}),
    confirm: true,
  });
  expect(created.status).toBe(201);
  return created.body;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('risk rules and reviews (ADR 0022)', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    const stubAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: merchant.oxyAppId,
        appName: 't',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: merchant.ownerAccountId ?? 'owner',
        environment: 'development',
        tier: 'external',
      };
      next();
    };
    const passThrough: RequestHandler = (_req, _res, next) => next();
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubAuth,
        // A request marked `X-Payer` is the payer's: no service credential.
        optionalServiceAuth: (req, res, next) =>
          req.header('X-Payer') ? next() : stubAuth(req, res, next),
      }),
    );
    app.use(createChargesRouter({ requireMerchant: stubAuth }));
    app.use(
      createCheckoutSessionsRouter({ requireMerchant: stubAuth, publicRateLimit: passThrough }),
    );
    app.use(createCatalogApiRouter(RADAR_ROUTES, { requireMerchant: stubAuth }));
    app.use(createBillingEngineRouter({ requireMerchant: stubAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  // Every test starts with a merchant of its own: rules are per merchant.
  beforeEach(async () => {
    merchant = await seedMerchant({});
    calls.length = 0;
    confirmOutcome = 'succeeded';
    refundState = 'succeeded';
    riskLevel = 'normal';
    snapshotFails = false;
  });

  afterAll(async () => {
    useFake = false;
    restoreModes();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ── rules are data ───────────────────────────────────────────────────────

  test('a rule is created, versioned on a new predicate or action only, listed and deleted', async () => {
    const created = await rule('block', ":card_country: not in ('ES', 'FR')");
    expect(created).toMatchObject({
      object: 'radar.rule',
      livemode: false,
      action: 'block',
      enabled: true,
      version: 1,
      description: null,
    });
    expect(created.id).toMatch(/^rule_[0-9a-f]{24}$/);

    const disabled = await call('POST', `/v1/radar/rules/${created.id}`, {
      enabled: false,
      description: 'Foreign cards',
    });
    expect(disabled.body).toMatchObject({
      enabled: false,
      version: 1,
      description: 'Foreign cards',
    });
    const same = await call('POST', `/v1/radar/rules/${created.id}`, {
      predicate: ":card_country: not in ('ES', 'FR')",
    });
    expect(same.body.version).toBe(1);
    const moved = await call('POST', `/v1/radar/rules/${created.id}`, { action: 'review' });
    expect(moved.body).toMatchObject({ action: 'review', version: 2 });
    const cleared = await call('POST', `/v1/radar/rules/${created.id}`, { description: '' });
    expect(cleared.body.description).toBeNull();

    const listed = await call('GET', '/v1/radar/rules?enabled=false');
    expect(listed.body.data.map((row: Json) => row.id)).toEqual([created.id]);
    expect((await call('GET', '/v1/radar/rules?enabled=true')).body.data).toEqual([]);

    const deleted = await call('DELETE', `/v1/radar/rules/${created.id}`);
    expect(deleted.body).toEqual({ id: created.id, object: 'radar.rule', deleted: true });
    expect((await call('GET', `/v1/radar/rules/${created.id}`)).status).toBe(404);
  });

  test('a predicate that does not parse is a 400 naming predicate and the position', async () => {
    const refused = await call('POST', '/v1/radar/rules', {
      action: 'block',
      predicate: ':amount: > 1 and :ip_country: = 1',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'parameter_invalid', param: 'predicate' });
    expect(refused.body.error.message).toContain('unknown fact :ip_country:');
    expect(refused.body.error.message).toContain('position 17');
    const unknownAction = await call('POST', '/v1/radar/rules', {
      action: 'quarantine',
      predicate: ':amount: > 1',
    });
    expect(unknownAction.status).toBe(400);
  });

  test('a merchant holds at most fifty rules', async () => {
    for (let i = 0; i < 50; i += 1) await rule('review', `:amount: > ${String(i)}`);
    const refused = await call('POST', '/v1/radar/rules', {
      action: 'review',
      predicate: ':amount: > 99',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('rule_limit_reached');
  });

  // ── before authorization ─────────────────────────────────────────────────

  test('a block at confirm is a declined attempt: 402, payable, explained, never sent to the provider', async () => {
    const blocking = await rule('block', ":card_country: = 'ES' and :amount: > 1000");
    const { customer, paymentMethod } = await customerWithCard('ES');
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
    });
    const declined = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {
      payment_method: paymentMethod.publicId,
    });
    expect(declined.status).toBe(402);
    expect(declined.body.error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'blocked_by_rule',
      message: 'The payment was declined.',
    });
    expect(declined.body.error.payment_intent).toMatchObject({
      status: 'requires_payment_method',
      last_payment_error: { decline_code: 'blocked_by_rule' },
    });
    expect(calls).not.toContain('confirm');
    expect(await eventsAbout(created.body.id)).toEqual([
      'payment_intent.created',
      'payment_intent.payment_failed',
    ]);

    // Explained: which rule, which version, the facts it named — and only those.
    const evaluations = await call(
      'GET',
      `/v1/radar/evaluations?payment_intent=${created.body.id}`,
    );
    expect(evaluations.body.data).toHaveLength(1);
    expect(evaluations.body.data[0]).toMatchObject({
      object: 'radar.evaluation',
      payment_intent: created.body.id,
      phase: 'pre_authorization',
      decision: 'block',
      rule: { id: blocking.id, version: 1, action: 'block' },
      facts: { amount: '2500', card_country: 'ES' },
    });

    // Still payable: once the rule is off, the same payment confirms.
    await call('POST', `/v1/radar/rules/${blocking.id}`, { enabled: false });
    const retried = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {
      payment_method: paymentMethod.publicId,
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'succeeded', last_payment_error: null });
  });

  test('allow beats block', async () => {
    const { customer, paymentMethod } = await customerWithCard('ES');
    await rule('block', ":card_country: = 'ES'");
    await rule('allow', `:customer: = '${customer.publicId}'`);
    await rule('review', ':amount: > 0');
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
    });
    expect(created.body.status).toBe('succeeded');
    // After authorization the allow still wins: no review is opened.
    expect(created.body.review).toBeNull();
    const evaluations = await call(
      'GET',
      `/v1/radar/evaluations?payment_intent=${created.body.id}`,
    );
    expect(evaluations.body.data.map((row: Json) => [row.phase, row.decision])).toEqual([
      ['post_authorization', 'allow'],
    ]);
  });

  test('a create with confirm that a rule blocks answers 402 and hands out no credential', async () => {
    await rule('block', ':amount: >= 2000');
    const { customer, paymentMethod } = await customerWithCard();
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
    });
    expect(created.status).toBe(402);
    expect(created.body.error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'blocked_by_rule',
    });
    expect(created.body.error.payment_intent).toMatchObject({
      status: 'requires_payment_method',
      last_payment_error: { decline_code: 'blocked_by_rule' },
    });
    // No credential: the payer cannot confirm around the rule at the provider.
    expect(JSON.stringify(created.body)).not.toContain('client_action');
    expect(calls).toEqual(['createPayment:open']);
  });

  test("handing out the payer's credential is gated; the merchant's read records nothing", async () => {
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
    });
    // The rule arrives after the payment was created.
    await rule('block', ":amount: >= 1000 and :currency: = 'EUR'");
    const intent = must(await findIntentByPublicId(gatewayDb(), created.body.id));

    const read = await call('GET', `/v1/payment_intents/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.client_action).toBeUndefined();
    expect(await eventsAbout(created.body.id)).toEqual(['payment_intent.created']);

    const asked = await call(
      'POST',
      `/v1/payment_intents/${created.body.id}/client_action`,
      undefined,
      {
        'X-Peable-Client-Secret': intent.clientSecret,
      },
    );
    expect(asked.status).toBe(402);
    // The payer learns of a plain decline: no rule, no decline code.
    expect(asked.body.error).toMatchObject({ type: 'card_error', code: 'card_declined' });
    expect(asked.body.error.decline_code).toBeUndefined();
    expect(asked.body.error.payment_intent.last_payment_error).toEqual({
      type: 'card_error',
      code: 'card_declined',
      decline_code: null,
      message: 'The card was declined.',
    });
    // The provider's confirmation credential was never read, let alone sent.
    expect(JSON.stringify(asked.body)).not.toContain('pi_test_');
    expect(JSON.stringify(asked.body)).not.toContain('blocked_by_rule');

    // Asking again is not another attempt: nothing new is recorded.
    const again = await call(
      'POST',
      `/v1/payment_intents/${created.body.id}/client_action`,
      undefined,
      { 'X-Peable-Client-Secret': intent.clientSecret },
    );
    expect(again.status).toBe(402);
    expect(await eventsAbout(created.body.id)).toEqual([
      'payment_intent.created',
      'payment_intent.payment_failed',
    ]);
    expect(await evaluationCount()).toBe(1);

    // The payer's own read says the same; the merchant's keeps the reason.
    const payerRead = await call('GET', `/v1/payment_intents/${created.body.id}`, undefined, {
      'X-Payer': '1',
      'X-Peable-Client-Secret': intent.clientSecret,
    });
    expect(payerRead.status).toBe(200);
    expect(payerRead.body.last_payment_error.decline_code).toBeNull();
    const merchantRead = await call('GET', `/v1/payment_intents/${created.body.id}`);
    expect(merchantRead.body.last_payment_error.decline_code).toBe('blocked_by_rule');
  });

  test('is_missing over a fact the phase cannot know is unknown, not true', async () => {
    // Before any card is entered the card is unknown: this must not decline every payer…
    await rule('block', 'is_missing(:card_country:)');
    // …and the provider's risk is unknown before authorization: this must not allow everything.
    await rule('allow', 'is_missing(:risk_level:)');
    await rule('block', ':amount: >= 5000');
    const small = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
    });
    expect(small.body.client_action).toMatchObject({ kind: 'client_secret' });
    expect(small.body.last_payment_error).toBeNull();
    const large = await call('POST', '/v1/payment_intents', {
      amount: '9000',
      rail: 'card',
      currency: 'EUR',
    });
    expect(large.body.client_action).toBeUndefined();
    expect(large.body.last_payment_error.decline_code).toBe('blocked_by_rule');
  });

  test('mid-3DS: the payer is never declined; a new server confirm is judged with its card', async () => {
    const { customer, paymentMethod } = await customerWithCard('ES');
    confirmOutcome = 'challenge';
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
    });
    expect(created.body.status).toBe('requires_action');
    await rule('block', ":card_country: = 'ES'");
    const intent = must(await findIntentByPublicId(gatewayDb(), created.body.id));
    // The payer finishing the challenge gets the credential: 3DS is in flight.
    const asked = await call(
      'POST',
      `/v1/payment_intents/${created.body.id}/client_action`,
      undefined,
      {
        'X-Peable-Client-Secret': intent.clientSecret,
      },
    );
    expect(asked.status).toBe(200);
    // A NEW confirm the gateway makes with a card is a new attempt: judged, 402,
    // the row as it was, the provider never asked.
    calls.length = 0;
    const confirmed = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {
      payment_method: paymentMethod.publicId,
    });
    expect(confirmed.status).toBe(402);
    expect(confirmed.body.error.decline_code).toBe('blocked_by_rule');
    expect(confirmed.body.error.payment_intent.status).toBe('requires_action');
    expect(calls).not.toContain('confirm');
    expect(await eventsAbout(created.body.id)).not.toContain('payment_intent.payment_failed');
  });

  test('an invoice collection retrying a payment mid-3DS is judged with the card it charges', async () => {
    const { customer, paymentMethod } = await customerWithCard('ES');
    const invoice = await call('POST', '/v1/invoices', {
      customer: customer.publicId,
      currency: 'EUR',
      collection_method: 'charge_automatically',
    });
    expect(invoice.status).toBe(200);
    await call('POST', '/v1/invoiceitems', {
      customer: customer.publicId,
      invoice: invoice.body.id,
      amount: '2500',
      currency: 'EUR',
    });
    expect((await call('POST', `/v1/invoices/${invoice.body.id}/finalize`, {})).status).toBe(200);
    confirmOutcome = 'challenge';
    await call('POST', `/v1/invoices/${invoice.body.id}/pay`, {
      payment_method: paymentMethod.publicId,
    });
    const before = (await call('GET', `/v1/invoices/${invoice.body.id}`)).body;
    const pi = must(before.payment_intent);
    expect((await call('GET', `/v1/payment_intents/${pi}`)).body.status).toBe('requires_action');

    await rule('block', ":card_country: = 'ES'");
    confirmOutcome = 'succeeded';
    calls.length = 0;
    await call('POST', `/v1/invoices/${invoice.body.id}/pay`, {
      payment_method: paymentMethod.publicId,
    });
    expect(calls).not.toContain('confirm');
    const after = (await call('GET', `/v1/invoices/${invoice.body.id}`)).body;
    expect(after.status).toBe('open');
    expect(after.attempt_count).toBe(before.attempt_count + 1);
    expect((await call('GET', `/v1/payment_intents/${pi}`)).body.status).toBe('requires_action');
  });

  test('a create hands out no credential a rule blocks: the attempt is declined', async () => {
    await rule('block', ':amount: >= 1000');
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
    });
    expect(created.status).toBe(201);
    expect(created.body.client_action).toBeUndefined();
    expect(created.body).toMatchObject({
      status: 'requires_payment_method',
      last_payment_error: { decline_code: 'blocked_by_rule' },
    });
    const allowed = await call('POST', '/v1/payment_intents', {
      amount: '500',
      rail: 'card',
      currency: 'EUR',
    });
    expect(allowed.body.client_action).toMatchObject({ kind: 'client_secret' });
  });

  test('velocity: the customer’s other card payments in the window, in this currency', async () => {
    const { customer, paymentMethod } = await customerWithCard();
    for (const currency of ['EUR', 'EUR', 'USD']) {
      await call('POST', '/v1/payment_intents', {
        amount: '1000',
        rail: 'card',
        currency,
        customer: customer.publicId,
      });
    }
    await rule(
      'block',
      ':payments_per_customer_hourly: >= 3 and :amount_per_customer_daily: >= 2000',
    );
    const created = await call('POST', '/v1/payment_intents', {
      amount: '500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
    });
    expect(created.status).toBe(402);
    expect(created.body.error.payment_intent.status).toBe('requires_payment_method');
    const evaluations = await call(
      'GET',
      `/v1/radar/evaluations?payment_intent=${created.body.error.payment_intent.id}`,
    );
    expect(evaluations.body.data[0].facts).toEqual({
      amount_per_customer_daily: '2000',
      payments_per_customer_hourly: '3',
    });
  });

  // ── after authorization ──────────────────────────────────────────────────

  test('a review rule opens a review; the payment and its charge name it; approve closes it', async () => {
    const reviewing = await rule('review', ":risk_level: = 'elevated' or :card_country: = 'US'");
    const paid = await paidByCard();
    expect(paid.status).toBe('succeeded');
    const intent = (await call('GET', `/v1/payment_intents/${paid.id}`)).body;
    expect(intent.review).toMatch(/^prv_[0-9a-f]{24}$/);

    const charge = (await call('GET', `/v1/charges/${paid.latest_charge}`)).body;
    expect(charge.review).toBe(intent.review);
    expect(charge.outcome).toMatchObject({
      type: 'manual_review',
      reason: 'rule',
      risk_level: 'normal',
      risk_score: 12,
      rule: { id: reviewing.id, action: 'review', version: 1 },
      seller_message: 'The payment is held for review.',
    });

    const review = (await call('GET', `/v1/reviews/${intent.review}`)).body;
    expect(review).toMatchObject({
      object: 'review',
      open: true,
      reason: 'rule',
      opened_reason: 'rule',
      closed_reason: null,
      payment_intent: paid.id,
      charge: paid.latest_charge,
      rule: { id: reviewing.id, action: 'review' },
    });
    expect(
      (await call('GET', '/v1/reviews?open=true')).body.data.map((row: Json) => row.id),
    ).toEqual([review.id]);

    const approved = await call('POST', `/v1/reviews/${review.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      open: false,
      reason: 'approved',
      closed_reason: 'approved',
    });
    expect(await eventsAbout(review.id)).toEqual(['review.opened', 'review.closed']);
    const again = await call('POST', `/v1/reviews/${review.id}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('review_not_open');
  });

  test('a review holds a manual capture until it is approved', async () => {
    await rule('review', ':risk_score: < 50');
    confirmOutcome = 'authorized';
    const held = await paidByCard({ manual: true });
    expect(held.status).toBe('requires_capture');
    const review = must((await call('GET', `/v1/payment_intents/${held.id}`)).body.review);

    const refused = await call('POST', `/v1/payment_intents/${held.id}/capture`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('payment_intent_unexpected_state');
    expect(refused.body.error.message).toContain(review);
    expect(calls).not.toContain('capture');

    await call('POST', `/v1/reviews/${review}/approve`, {});
    const captured = await call('POST', `/v1/payment_intents/${held.id}/capture`, {});
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe('succeeded');
  });

  test('refusing an uncaptured payment releases the authorization', async () => {
    await rule('review', ":card_brand: = 'visa'");
    confirmOutcome = 'authorized';
    const held = await paidByCard({ manual: true });
    const review = must((await call('GET', `/v1/payment_intents/${held.id}`)).body.review);
    const refused = await call('POST', `/v1/reviews/${review}/refuse`, { reason: 'fraudulent' });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ open: false, closed_reason: 'canceled' });
    expect(calls).toContain('cancel:fraudulent');
    const intent = (await call('GET', `/v1/payment_intents/${held.id}`)).body;
    expect(intent).toMatchObject({ status: 'canceled', cancellation_reason: 'fraudulent' });
    expect(await eventsAbout(review)).toEqual(['review.opened', 'review.closed']);
  });

  test('refusing a captured payment refunds it in full, as fraud when told', async () => {
    await rule('review', ":card_funding: = 'credit'");
    const paid = await paidByCard({ amount: '4200' });
    const review = must((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review);
    const refused = await call('POST', `/v1/reviews/${review}/refuse`, { reason: 'fraudulent' });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ open: false, closed_reason: 'refunded_as_fraud' });
    expect(calls).toContain('refund:4200');
    const intent = (await call('GET', `/v1/payment_intents/${paid.id}`)).body;
    expect(intent).toMatchObject({ status: 'succeeded', amount_refunded: '4200' });
    expect(await eventsAbout(review)).toEqual(['review.opened', 'review.closed']);
  });

  test('a post-authorization block releases a held authorization', async () => {
    await rule('block', ":risk_level: = 'highest'");
    riskLevel = 'highest';
    confirmOutcome = 'authorized';
    const held = await paidByCard({ manual: true });
    const intent = (await call('GET', `/v1/payment_intents/${held.id}`)).body;
    expect(intent).toMatchObject({
      status: 'canceled',
      cancellation_reason: 'fraudulent',
      review: null,
    });
    expect(calls).toContain('cancel:fraudulent');
    const charge = (await call('GET', `/v1/charges/${held.latest_charge}`)).body;
    expect(charge.outcome).toMatchObject({ type: 'blocked', reason: 'rule', risk_score: 91 });
  });

  test('a post-authorization block on captured money opens a review, never a silent refund', async () => {
    await rule('block', ":risk_level: = 'highest'");
    riskLevel = 'highest';
    const paid = await paidByCard();
    const intent = (await call('GET', `/v1/payment_intents/${paid.id}`)).body;
    expect(intent.status).toBe('succeeded');
    expect(intent.review).toMatch(/^prv_/);
    expect(calls.some((entry) => entry.startsWith('refund'))).toBe(false);
    const charge = (await call('GET', `/v1/charges/${paid.latest_charge}`)).body;
    expect(charge.outcome).toMatchObject({ type: 'manual_review', reason: 'rule' });
  });

  test('a capture waits for the rules: an unreadable snapshot is a 503, nothing captured', async () => {
    await rule('review', ':risk_score: > 80');
    snapshotFails = true;
    confirmOutcome = 'authorized';
    const held = await paidByCard({ manual: true });
    const refused = await call('POST', `/v1/payment_intents/${held.id}/capture`, {});
    expect(refused.status).toBe(503);
    expect(calls).not.toContain('capture');
    snapshotFails = false;
    const captured = await call('POST', `/v1/payment_intents/${held.id}/capture`, {});
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe('succeeded');
  });

  test('approve and refuse race: exactly one wins', async () => {
    await rule('review', ':amount: > 0');
    confirmOutcome = 'authorized';
    const held = await paidByCard({ manual: true });
    const review = must((await call('GET', `/v1/payment_intents/${held.id}`)).body.review);
    const [approved, refused] = await Promise.all([
      call('POST', `/v1/reviews/${review}/approve`, {}),
      call('POST', `/v1/reviews/${review}/refuse`, {}),
    ]);
    const winners = [approved, refused].filter((answer) => answer.status === 200);
    expect(winners).toHaveLength(1);
    const final = (await call('GET', `/v1/reviews/${review}`)).body;
    const intent = (await call('GET', `/v1/payment_intents/${held.id}`)).body;
    if (final.closed_reason === 'approved') expect(intent.status).toBe('requires_capture');
    else expect([final.closed_reason, intent.status]).toEqual(['canceled', 'canceled']);
    expect(await eventsAbout(review)).toEqual(['review.opened', 'review.closed']);
  });

  test('a cancellation elsewhere closes the open review, and approve then answers 409', async () => {
    await rule('review', ':amount: > 0');
    confirmOutcome = 'authorized';
    const held = await paidByCard({ manual: true });
    const review = must((await call('GET', `/v1/payment_intents/${held.id}`)).body.review);
    const intent = must(await findIntentByPublicId(gatewayDb(), held.id));
    // The provider's own word (an expired authorization): one transition.
    const moved = await transitionIntent(intent.id, {
      from: 'requires_capture',
      status: 'canceled',
      cancellationReason: 'automatic',
    });
    expect(moved.kind).toBe('updated');
    const answer = await call('POST', `/v1/reviews/${review}/approve`, {});
    expect(answer.status).toBe(409);
    expect((await call('GET', `/v1/reviews/${review}`)).body.closed_reason).toBe('canceled');
  });

  test('preview judges a predicate against recent card payments without saving it', async () => {
    await paidByCard({ amount: '9000' });
    await paidByCard({ amount: '100' });
    const preview = await previewPredicate(merchant, ':amount: > 5000');
    expect(preview.evaluated).toBe(2);
    expect(preview.matched.map((match) => match.amount)).toEqual(['9000']);
    expect(await evaluationCount()).toBe(0);
  });

  test('a refusal waiting on a pending refund holds the review; a failed refund lets it go', async () => {
    await rule('review', ':amount: > 0');
    const paid = await paidByCard({ amount: '3000' });
    const review = must((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review);
    refundState = 'pending';
    const refused = await call('POST', `/v1/reviews/${review}/refuse`, {});
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ open: true, closed_reason: null });
    const blocked = await call('POST', `/v1/reviews/${review}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('resource_conflict');

    // The bank rejects the refund: the claim is let go, the review is open again.
    const refund = must(
      await findRefundByExternalRef(gatewayDb(), merchant.id, `review:${review}`),
    );
    const intent = must(await findIntentByPublicId(gatewayDb(), paid.id));
    await gatewayDb().transaction(async (tx) => {
      const failed = must(await markRefundFailed(tx, refund.id, 'bank_rejected'));
      await emitRefundEvents(tx, intent, failed, refund.status);
    });
    const approved = await call('POST', `/v1/reviews/${review}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.closed_reason).toBe('approved');
  });

  test("a refusal's claim is a lease: a crashed refusal does not lock the review", async () => {
    await rule('review', ':amount: > 0');
    const paid = await paidByCard();
    const reviewId = must((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review);
    const review = must(await findReviewForMerchant(gatewayDb(), reviewId, merchant.id));
    expect(await claimReviewClose(gatewayDb(), review.id, 'refunded')).toBe(true);
    expect((await call('POST', `/v1/reviews/${reviewId}/approve`, {})).status).toBe(409);
    await gatewayDb()
      .update(reviews)
      .set({ pendingClosedUntil: new Date(Date.now() - 1000) })
      .where(eq(reviews.id, review.id));
    const approved = await call('POST', `/v1/reviews/${reviewId}/approve`, {});
    expect(approved.status).toBe(200);
  });

  test('a judgment that could not run is retried by the sweep', async () => {
    await rule('review', ':amount: > 0');
    snapshotFails = true;
    const paid = await paidByCard();
    expect((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review).toBeNull();
    snapshotFails = false;
    const intent = must(await findIntentByPublicId(gatewayDb(), paid.id));
    await gatewayDb()
      .update(charges)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(charges.paymentIntentId, intent.id));
    expect(await runJudgeSweep()).toBeGreaterThanOrEqual(1);
    expect((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review).toMatch(/^prv_/);
  });

  test('a saved card attached at create is judged when its credential is handed out', async () => {
    await rule('block', ":amount: >= 2000 and :card_country: = 'ES'");
    const { customer, paymentMethod } = await customerWithCard('ES');
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('requires_confirmation');
    expect(created.body.client_action).toBeUndefined();
    const intent = must(await findIntentByPublicId(gatewayDb(), created.body.id));
    const asked = await call(
      'POST',
      `/v1/payment_intents/${created.body.id}/client_action`,
      undefined,
      {
        'X-Peable-Client-Secret': intent.clientSecret,
      },
    );
    expect(asked.status).toBe(402);
    expect(asked.body.error.decline_code).toBeUndefined();
    expect(JSON.stringify(asked.body)).not.toContain('pi_test_');
    expect(
      (await call('GET', `/v1/payment_intents/${created.body.id}`)).body.client_action,
    ).toBeUndefined();

    // The server confirm declines too — and leaves the payment (and the
    // provider's, which still holds the card) as it was: nothing confirmed.
    const confirmed = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {});
    expect(confirmed.status).toBe(402);
    expect(confirmed.body.error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'blocked_by_rule',
    });
    expect(confirmed.body.error.payment_intent.status).toBe('requires_confirmation');
    expect(calls).not.toContain('confirm');
    expect(await eventsAbout(created.body.id)).toEqual(['payment_intent.created']);
    // One decision, recorded once however often it was asked.
    expect(await evaluationCount()).toBe(1);
  });

  test('a judgment never opens a review on a payment refunded while it was judged', async () => {
    await rule('review', ':amount: > 0');
    snapshotFails = true;
    const paid = await paidByCard({ amount: '1500' });
    const intent = must(await findIntentByPublicId(gatewayDb(), paid.id));
    await createRefund({ merchantId: merchant.id, intent, externalRef: 'full', amount: '1500' });
    snapshotFails = false;
    await syncChargeFromProvider(must(await findIntentByPublicId(gatewayDb(), paid.id)));
    expect((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review).toBeNull();
    expect(await evaluationCount()).toBe(1);
  });

  test("another refund failing does not free a refusal's claim", async () => {
    await rule('review', ':amount: > 0');
    const paid = await paidByCard({ amount: '4000' });
    const reviewId = must((await call('GET', `/v1/payment_intents/${paid.id}`)).body.review);
    const review = must(await findReviewForMerchant(gatewayDb(), reviewId, merchant.id));
    expect(await claimReviewClose(gatewayDb(), review.id, 'refunded')).toBe(true);
    await holdReviewClose(gatewayDb(), review.id, 'refunded');
    refundState = 'pending';
    const intent = must(await findIntentByPublicId(gatewayDb(), paid.id));
    const { refund } = await createRefund({
      merchantId: merchant.id,
      intent,
      externalRef: 'merchant_partial',
      amount: '1000',
    });
    await gatewayDb().transaction(async (tx) => {
      const failed = must(await markRefundFailed(tx, refund.id, 'bank_rejected'));
      await emitRefundEvents(tx, intent, failed, refund.status);
    });
    expect((await call('POST', `/v1/reviews/${reviewId}/approve`, {})).status).toBe(409);
  });

  test('the judge sweep backs off a charge it just tried', async () => {
    await rule('review', ':amount: > 0');
    snapshotFails = true;
    const paid = await paidByCard();
    const intent = must(await findIntentByPublicId(gatewayDb(), paid.id));
    await gatewayDb()
      .update(charges)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(charges.paymentIntentId, intent.id));
    const first = await claimUnjudgedCharges(gatewayDb(), 50);
    expect(first.map((row) => row.paymentIntentId)).toContain(intent.id);
    const again = await claimUnjudgedCharges(gatewayDb(), 50);
    expect(again.map((row) => row.paymentIntentId)).not.toContain(intent.id);
  });

  // ── FairCoin is never touched (ADR 0022 D6) ──────────────────────────────

  test('a FairCoin payment never consults a rule', async () => {
    await rule('block', ':amount: >= 0');
    const created = await call('POST', '/v1/payment_intents', {
      amount: '700000000',
      network: 'testnet',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      rail: 'faircoin',
      status: 'requires_action',
      review: null,
    });
    const intent = must(await findIntentByPublicId(gatewayDb(), created.body.id));
    expect(await evaluateRules(intent, 'pre_authorization', {})).toBeNull();
    expect(await evaluateRules(intent, 'post_authorization', {})).toBeNull();
    expect(
      await gateBeforeAuthorization(intent, {}, { record: true, point: 'credential' }),
    ).toEqual({
      kind: 'proceed',
    });
    expect(await evaluationCount()).toBe(0);
    expect(await eventsAbout(created.body.id)).toEqual(['payment_intent.created']);
  });

  test('a checkout whose card a rule blocked still takes FairCoin', async () => {
    await rule('block', ':amount: >= 1');
    const session = await call('POST', '/v1/checkout_sessions', {
      line_items: [
        {
          price_data: { currency: 'USD', unit_amount: '1000', product_data: { name: 'Lamp' } },
          quantity: 1,
        },
      ],
      customer_email: 'b@example.com',
      success_url: 'https://merchant.example/ok',
    });
    expect(session.status).toBe(201);
    expect(session.body.payment_method_types).toEqual(['card', 'faircoin']);
    const secret = {
      'X-Peable-Client-Secret': decodeURIComponent(String(session.body.url).split('#cs=')[1] ?? ''),
    };
    const byCard = await call(
      'POST',
      `/v1/checkout_sessions/${session.body.id}/public/confirm`,
      { payment_method_type: 'card' },
      secret,
    );
    expect(byCard.status).toBe(200);
    const card = must(await findIntentByPublicId(gatewayDb(), byCard.body.payment_intent.id));
    const credential = await call(
      'POST',
      `/v1/payment_intents/${card.publicId}/client_action`,
      undefined,
      {
        'X-Peable-Client-Secret': card.clientSecret,
      },
    );
    expect(credential.status).toBe(402);

    const view = await call(
      'GET',
      `/v1/checkout_sessions/${session.body.id}/public`,
      undefined,
      secret,
    );
    expect(view.body.status).toBe('open');
    expect(view.body.payment_method_types).toContain('faircoin');
    const byFaircoin = await call(
      'POST',
      `/v1/checkout_sessions/${session.body.id}/public/confirm`,
      { payment_method_type: 'faircoin' },
      secret,
    );
    expect(byFaircoin.status).toBe(200);
    const faircoin = must(
      await findIntentByPublicId(gatewayDb(), byFaircoin.body.payment_intent.id),
    );
    expect(faircoin).toMatchObject({ rail: 'faircoin', status: 'requires_action' });
  });
});
