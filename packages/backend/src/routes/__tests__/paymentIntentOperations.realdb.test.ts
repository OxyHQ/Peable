/**
 * The card PaymentIntent API of ADR 0019, over HTTP, against a real database
 * and a fake provider per mode: create with a saved card and `confirm`, a
 * server-side `/confirm` (success, decline → 402, challenge), manual capture
 * (`requires_capture` → `/capture`, partial), `/cancel` releasing an
 * authorization, the read-only `ch_…` (retrieve, list, expand), and the
 * `payment_intent.*` events each step enqueues.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type {
  ProviderMode,
  ProviderPaymentResult,
  ProviderPaymentStatus,
} from '../../services/providers/provider';

const calls: string[] = [];
/** What the fake provider answers next for a confirm (or a create with `confirm`). */
let confirmOutcome: 'succeeded' | 'declined' | 'challenge' | 'authorized' = 'succeeded';
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
  switch (confirmOutcome) {
    case 'succeeded':
      return result(providerObjectId, 'succeeded');
    case 'authorized':
      return result(providerObjectId, 'requires_capture');
    case 'challenge':
      return result(providerObjectId, 'requires_action');
    case 'declined':
      return {
        ...result(providerObjectId, 'requires_payment_method'),
        lastPaymentError: {
          type: 'card_error',
          code: 'card_declined',
          declineCode: 'insufficient_funds',
        },
      };
  }
}

function fakeProviderFor(mode: ProviderMode) {
  return {
    id: 'stripe' as const,
    createPayment: async (request: Record<string, unknown>) => {
      counter += 1;
      const id = `pi_${mode}_${String(counter)}`;
      calls.push(
        `createPayment:${String(request.captureMethod)}:${request.confirm ? 'confirm' : 'open'}`,
      );
      return request.confirm ? confirmed(id) : result(id, 'requires_payment_method');
    },
    confirm: async (request: Record<string, unknown>) => {
      calls.push(
        `confirm:${String(request.paymentMethodObjectId)}:${String(request.customerObjectId)}:${request.offSession ? 'off' : 'on'}`,
      );
      return confirmed(String(request.providerObjectId));
    },
    capture: async (request: Record<string, unknown>) => {
      calls.push(`capture:${String(request.amountToCapture)}:${String(request.idempotencyKey)}`);
      return result(String(request.providerObjectId), 'succeeded');
    },
    cancel: async (request: Record<string, unknown>) => {
      calls.push(`cancel:${String(request.cancellationReason)}`);
      return result(String(request.providerObjectId), 'canceled');
    },
    refund: async () => {
      throw new Error('not used');
    },
    getStatus: async (providerObjectId: string) =>
      result(providerObjectId, providerStatus.get(providerObjectId) ?? 'requires_payment_method'),
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createCustomer: async (request: { customerId: string }) => {
      calls.push(`createCustomer:${request.customerId}`);
      return { providerObjectId: `cus_stripe_${request.customerId}` };
    },
    getChargeSnapshot: async (chargeObjectId: string) => {
      calls.push(`getChargeSnapshot:${chargeObjectId}`);
      return {
        outcome: { networkStatus: 'approved_by_network', riskLevel: 'normal', type: 'authorized' },
        billingDetails: { address: null, email: 'jenny@example.com', name: 'Jenny', phone: null },
        paymentMethodDetails: {
          type: 'card' as const,
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            country: 'ES',
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
/** `mock.module` outlives this file in a bun run: the fake answers only while it is on. */
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
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { insertCustomer, insertCustomerBinding } = await import(
  '../../db/customers/customerRepository'
);
const { registerPaymentMethod } = await import('../../db/customers/paymentMethodRepository');
const { events } = await import('../../db/schema');
const { eq } = await import('drizzle-orm');
const { uuidv7 } = await import('@oxy.so/db');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let server: Server;
let baseUrl = '';
let restoreModes: () => void = () => undefined;

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field
type Json = any;

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function eventsFor(intentPublicId: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ type: events.type, dataObject: events.dataObject })
    .from(events)
    .where(eq(events.merchantId, merchant.id))
    .orderBy(events.id);
  return rows.filter((row) => row.dataObject.id === intentPublicId).map((row) => row.type);
}

/** A customer with a saved card, as a SetupIntent would have left them. */
async function customerWithCard() {
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
      country: 'ES',
      funding: 'credit',
    },
    billingDetails: { address: null, email: null, name: null, phone: null },
    provider: 'stripe',
    providerObjectId: `pm_stripe_${suffix}`,
  });
  return { customer, paymentMethod, suffix };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('card PaymentIntent operations (ADR 0019)', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    merchant = await seedMerchant({
      webhookUrl: 'https://merchant.example/hook',
      webhookSecret: 'whsec_operations',
    });
    const stubAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: merchant.oxyAppId,
        appName: 't',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: 'owner',
        environment: 'development',
        tier: 'external',
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({ requireMerchant: stubAuth, optionalServiceAuth: stubAuth }),
    );
    app.use(createChargesRouter({ requireMerchant: stubAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    calls.length = 0;
    confirmOutcome = 'succeeded';
  });

  afterAll(async () => {
    useFake = false;
    restoreModes();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('a card intent starts requires_payment_method and tells the merchant it exists', async () => {
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      description: 'Order 42',
      receipt_email: 'payer@example.test',
      shipping: { name: 'Ada', address: { country: 'ES', city: 'Madrid' } },
    });
    expect(created.status).toBe(201);
    const body = created.body;
    expect(body.status).toBe('requires_payment_method');
    expect(body.payment_method_types).toEqual(['card']);
    expect(body.faircoin).toBeNull();
    expect(body.latest_charge).toBeNull();
    expect(body.description).toBe('Order 42');
    expect(body.receipt_email).toBe('payer@example.test');
    expect(body.shipping.address).toEqual({
      line1: null,
      line2: null,
      city: 'Madrid',
      state: null,
      postal_code: null,
      country: 'ES',
    });
    expect(body.merchant_id).toBe(merchant.publicId);
    expect(await eventsFor(body.id)).toEqual(['payment_intent.created']);
  });

  test('create with a saved card and confirm: succeeded, with a ch_ and its snapshot', async () => {
    const { customer, paymentMethod } = await customerWithCard();
    const created = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
      off_session: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('succeeded');
    expect(created.body.amount_received).toBe('2500');
    expect(created.body.customer).toBe(customer.publicId);
    expect(created.body.payment_method).toBe(paymentMethod.publicId);
    expect(created.body.latest_charge).toMatch(/^ch_[0-9a-f]{24}$/);
    expect(calls).toContain('createPayment:automatic:confirm');
    expect(await eventsFor(created.body.id)).toEqual([
      'payment_intent.created',
      'payment_intent.succeeded',
    ]);

    // The charge: read-only, merchant-scoped, expandable from the intent.
    const charge = await call('GET', `/v1/charges/${created.body.latest_charge}`);
    expect(charge.status).toBe(200);
    expect(charge.body).toMatchObject({
      object: 'charge',
      payment_intent: created.body.id,
      amount: '2500',
      amount_captured: '2500',
      amount_refunded: '0',
      captured: true,
      refunded: false,
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      receipt_url: null,
      balance_transaction: null,
      outcome: {
        network_status: 'approved_by_network',
        risk_level: 'normal',
        type: 'authorized',
        seller_message: 'Payment complete.',
      },
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    });
    const listed = await call('GET', `/v1/charges?payment_intent=${created.body.id}`);
    expect(listed.body.data.map((row: Json) => row.id)).toEqual([created.body.latest_charge]);
    const expanded = await call(
      'GET',
      `/v1/payment_intents/${created.body.id}?expand[]=latest_charge&expand[]=customer&expand[]=payment_method`,
    );
    expect(expanded.body.latest_charge.object).toBe('charge');
    expect(expanded.body.customer.object).toBe('customer');
    expect(expanded.body.payment_method.object).toBe('payment_method');
    // A charge's `customer` and `payment_method` are spelled without `_id`, so
    // they expand like every other such reference.
    const chargeExpanded = await call(
      'GET',
      `/v1/charges/${created.body.latest_charge}?expand[]=customer&expand[]=payment_method`,
    );
    expect(chargeExpanded.status).toBe(200);
    expect(chargeExpanded.body.customer).toMatchObject({
      object: 'customer',
      id: customer.publicId,
    });
    expect(chargeExpanded.body.payment_method).toMatchObject({
      object: 'payment_method',
      id: paymentMethod.publicId,
    });
  });

  test('/confirm with a saved card; a decline answers 402 and leaves the intent payable', async () => {
    const { customer, paymentMethod } = await customerWithCard();
    const created = await call('POST', '/v1/payment_intents', {
      amount: '900',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
    });
    confirmOutcome = 'declined';
    const declined = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {
      payment_method: paymentMethod.publicId,
    });
    expect(declined.status).toBe(402);
    expect(declined.body.error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'insufficient_funds',
      message: 'The card has insufficient funds.',
    });
    expect(declined.body.error.payment_intent.status).toBe('requires_payment_method');
    expect(declined.body.error.payment_intent.last_payment_error.decline_code).toBe(
      'insufficient_funds',
    );
    // Charged through the customer the card is saved to — the binding.
    expect(
      calls.some((entry) =>
        entry.startsWith(`confirm:${paymentMethod.providerObjectId}:cus_stripe_bound_`),
      ),
    ).toBe(true);

    // The retry is a NEW attempt, and it clears the error.
    confirmOutcome = 'succeeded';
    const retried = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {});
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('succeeded');
    expect(retried.body.last_payment_error).toBeNull();
    expect(await eventsFor(created.body.id)).toEqual([
      'payment_intent.created',
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
    ]);
  });

  test('a challenge answers requires_action with use_peable_sdk, never a credential', async () => {
    const { customer, paymentMethod } = await customerWithCard();
    const created = await call('POST', '/v1/payment_intents', {
      amount: '900',
      rail: 'card',
      currency: 'EUR',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
    });
    expect(created.body.status).toBe('requires_confirmation');
    confirmOutcome = 'challenge';
    const confirmed = await call('POST', `/v1/payment_intents/${created.body.id}/confirm`, {
      return_url: 'https://merchant.example/return',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('requires_action');
    expect(confirmed.body.next_action).toEqual({ type: 'use_peable_sdk' });
    // The provider's own confirmation credential never rides on the intent.
    expect(JSON.stringify(confirmed.body)).not.toContain('pi_test_');
  });

  test('a card that belongs to another customer is refused, naming the field', async () => {
    const { paymentMethod } = await customerWithCard();
    const { customer: other } = await customerWithCard();
    const created = await call('POST', '/v1/payment_intents', {
      amount: '900',
      rail: 'card',
      currency: 'EUR',
      customer: other.publicId,
      payment_method: paymentMethod.publicId,
    });
    expect(created.status).toBe(400);
    expect(created.body.error.param).toBe('customer');
  });

  test('manual capture: authorized, then captured in part', async () => {
    const { customer, paymentMethod } = await customerWithCard();
    confirmOutcome = 'authorized';
    const created = await call('POST', '/v1/payment_intents', {
      amount: '5000',
      rail: 'card',
      currency: 'EUR',
      capture_method: 'manual',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
    });
    expect(created.body.status).toBe('requires_capture');
    expect(created.body.amount_capturable).toBe('5000');
    expect(created.body.amount_received).toBe('0');
    expect(calls).toContain('createPayment:manual:confirm');
    const held = await call('GET', `/v1/charges/${created.body.latest_charge}`);
    expect(held.body).toMatchObject({ captured: false, amount_captured: '0', refunded: false });

    const tooMuch = await call('POST', `/v1/payment_intents/${created.body.id}/capture`, {
      amount_to_capture: '5001',
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.param).toBe('amount_to_capture');

    const captured = await call('POST', `/v1/payment_intents/${created.body.id}/capture`, {
      amount_to_capture: '3000',
    });
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe('succeeded');
    expect(captured.body.amount_received).toBe('3000');
    expect(captured.body.amount_capturable).toBe('0');
    expect(calls).toContain(`capture:3000:capture:${created.body.id}`);
    const charge = await call('GET', `/v1/charges/${created.body.latest_charge}`);
    expect(charge.body).toMatchObject({ captured: true, amount_captured: '3000' });
    expect(await eventsFor(created.body.id)).toEqual([
      'payment_intent.created',
      'payment_intent.amount_capturable_updated',
      'payment_intent.succeeded',
    ]);

    // Captured once: a second capture is the wrong state.
    const again = await call('POST', `/v1/payment_intents/${created.body.id}/capture`, {});
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('payment_intent_unexpected_state');
  });

  test('cancelling a held authorization releases it, with the reason', async () => {
    const { customer, paymentMethod } = await customerWithCard();
    confirmOutcome = 'authorized';
    const created = await call('POST', '/v1/payment_intents', {
      amount: '5000',
      rail: 'card',
      currency: 'EUR',
      capture_method: 'manual',
      customer: customer.publicId,
      payment_method: paymentMethod.publicId,
      confirm: true,
    });
    const canceled = await call('POST', `/v1/payment_intents/${created.body.id}/cancel`, {
      cancellation_reason: 'requested_by_customer',
    });
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
    expect(canceled.body.cancellation_reason).toBe('requested_by_customer');
    expect(calls).toContain('cancel:requested_by_customer');
    const charge = await call('GET', `/v1/charges/${created.body.latest_charge}`);
    expect(charge.body).toMatchObject({ captured: false, refunded: true, amount_refunded: '5000' });
  });

  test('a FairCoin payment refuses the card-only fields, naming each', async () => {
    for (const [field, value] of [
      ['payment_method', 'pm_x'],
      ['setup_future_usage', 'off_session'],
      ['statement_descriptor_suffix', 'ORDER'],
    ] as const) {
      const res = await call('POST', '/v1/payment_intents', {
        amount: '100000000',
        network: 'testnet',
        [field]: value,
      });
      expect([field, res.status, res.body.error?.param]).toEqual([field, 400, field]);
    }
  });

  test('a charge of another merchant is not found', async () => {
    const res = await call('GET', '/v1/charges/ch_000000000000000000000000');
    expect(res.status).toBe(404);
  });
});
