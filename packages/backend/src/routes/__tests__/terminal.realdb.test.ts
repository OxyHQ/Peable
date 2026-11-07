/**
 * Terminal (ADR 0024) — over HTTP, against a real database, with one recording
 * fake provider PER MODE behind the registry (cards and readers in one fake,
 * as the Stripe adapter is one provider).
 *
 * What is pinned: locations and readers at the provider first; a card_present
 * PaymentIntent is a CARD payment (routing decided at create, the live gate,
 * never FairCoin, never a checkout, never a server confirm); a reader's
 * collection is claimed by CAS, acknowledged, and settled ONCE from the
 * provider's CURRENT reader (never a stale event's), with its Orbit event in
 * the same transaction; the payment moves only through the card rail's own
 * path (`payment_intent.*` provider events, reconciliation) — succeeded,
 * declined and payable again, manual capture; cancel_action; mode isolation;
 * the test helper refused in live; Orbit's collect route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import {
  ProviderError,
  TERMINAL_READER_BUSY_CODE,
  TERMINAL_UNAVAILABLE_CODE,
  type ProviderMode,
  type ProviderPaymentResult,
  type ProviderTerminalReader,
} from '../../services/providers/provider';

const calls: string[] = [];
let counter = 0;
const next = () => String(++counter);
let terminalEnabled = true;

interface FakePayment extends ProviderPaymentResult {
  readonly amount: string;
  readonly captureMethod: string;
  readonly mode: ProviderMode;
  readonly request: Record<string, unknown>;
}
const payments = new Map<string, FakePayment>();
const readers = new Map<string, ProviderTerminalReader>();
const locations = new Map<string, { displayName: string; country: string }>();

function unavailable(): ProviderError {
  return new ProviderError({
    provider: 'stripe',
    stage: 'terminal',
    message: 'Terminal is not enabled on the provider account',
    retryable: false,
    code: TERMINAL_UNAVAILABLE_CODE,
  });
}

function readerOf(id: string): ProviderTerminalReader {
  const reader = readers.get(id);
  if (!reader) throw new Error(`no reader ${id}`);
  return reader;
}

function paymentOf(id: string): FakePayment {
  const payment = payments.get(id);
  if (!payment) throw new Error(`no payment ${id}`);
  return payment;
}

function fakeProviderFor(mode: ProviderMode) {
  const record = (fn: string) => calls.push(`${mode}:${fn}`);
  const guard = () => {
    if (!terminalEnabled) throw unavailable();
  };
  return {
    id: 'stripe' as const,
    createPayment: async (request: Record<string, unknown>) => {
      record('createPayment');
      const id = `pi_${mode}_${next()}`;
      const payment: FakePayment = {
        providerObjectId: id,
        status: 'requires_payment_method',
        clientAction: { kind: 'client_secret', value: `${id}_secret` },
        amount: String((request.amount as { amount: string }).amount),
        captureMethod: String(request.captureMethod),
        mode,
        request,
      };
      payments.set(id, payment);
      return payment;
    },
    confirm: async () => {
      throw new Error('a card_present payment is never confirmed with a saved card');
    },
    capture: async (request: { providerObjectId: string }) => {
      record('capture');
      const payment = paymentOf(request.providerObjectId);
      const captured = { ...payment, status: 'succeeded' as const };
      payments.set(request.providerObjectId, captured);
      return captured;
    },
    cancel: async (request: { providerObjectId: string }) => {
      record('cancel');
      const canceled = { ...paymentOf(request.providerObjectId), status: 'canceled' as const };
      payments.set(request.providerObjectId, canceled);
      return canceled;
    },
    refund: async () => {
      throw new Error('not used');
    },
    getStatus: async (id: string) => paymentOf(id),
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createTerminalLocation: async (request: {
      displayName: string;
      address: { country: string | null };
      idempotencyKey: string;
    }) => {
      record('createTerminalLocation');
      guard();
      const id = `tml_${mode}_${next()}`;
      locations.set(id, {
        displayName: request.displayName,
        country: String(request.address.country),
      });
      return { providerObjectId: id, displayName: request.displayName, address: request.address };
    },
    updateTerminalLocation: async (request: {
      providerObjectId: string;
      displayName?: string;
      address?: { country: string | null };
    }) => {
      record('updateTerminalLocation');
      guard();
      const stored = locations.get(request.providerObjectId);
      if (!stored) throw new Error('no location');
      const displayName = request.displayName ?? stored.displayName;
      locations.set(request.providerObjectId, { ...stored, displayName });
      return {
        providerObjectId: request.providerObjectId,
        displayName,
        address: request.address ?? {
          line1: null,
          line2: null,
          city: null,
          state: null,
          postal_code: null,
          country: null,
        },
      };
    },
    deleteTerminalLocation: async (request: { providerObjectId: string }) => {
      record('deleteTerminalLocation');
      locations.delete(request.providerObjectId);
    },
    registerTerminalReader: async (request: {
      registrationCode: string;
      label?: string;
      locationObjectId: string;
    }) => {
      record('registerTerminalReader');
      guard();
      const id = `tmr_${mode}_${next()}`;
      const reader: ProviderTerminalReader = {
        providerObjectId: id,
        label: request.label ?? 'WisePOS E',
        deviceType: request.registrationCode.startsWith('simulated-')
          ? 'simulated_wisepos_e'
          : 'bbpos_wisepos_e',
        serialNumber: `SN-${id}`,
        status: 'online',
        lastSeenAt: new Date(1793750400000),
        locationObjectId: request.locationObjectId,
        action: null,
      };
      readers.set(id, reader);
      return reader;
    },
    getTerminalReader: async (id: string) => {
      record('getTerminalReader');
      return readers.get(id) ?? null;
    },
    updateTerminalReader: async (request: { providerObjectId: string; label: string }) => {
      record('updateTerminalReader');
      const updated = { ...readerOf(request.providerObjectId), label: request.label };
      readers.set(request.providerObjectId, updated);
      return updated;
    },
    deleteTerminalReader: async (request: { providerObjectId: string }) => {
      record('deleteTerminalReader');
      readers.delete(request.providerObjectId);
    },
    processTerminalPayment: async (request: {
      readerObjectId: string;
      paymentObjectId: string;
      idempotencyKey: string;
    }) => {
      record(`processTerminalPayment:${request.idempotencyKey}`);
      guard();
      const reader = readerOf(request.readerObjectId);
      if (reader.action?.status === 'in_progress') {
        throw new ProviderError({
          provider: 'stripe',
          stage: 'terminal',
          message: 'the reader is busy',
          retryable: false,
          code: TERMINAL_READER_BUSY_CODE,
        });
      }
      const updated: ProviderTerminalReader = {
        ...reader,
        action: {
          type: 'process_payment_intent',
          status: 'in_progress',
          paymentObjectId: request.paymentObjectId,
          failureCode: null,
        },
      };
      readers.set(request.readerObjectId, updated);
      return updated;
    },
    cancelTerminalReaderAction: async (request: { readerObjectId: string }) => {
      record('cancelTerminalReaderAction');
      const reader = readerOf(request.readerObjectId);
      const updated: ProviderTerminalReader = {
        ...reader,
        action: reader.action
          ? { ...reader.action, status: 'failed', failureCode: 'request_canceled' }
          : null,
      };
      readers.set(request.readerObjectId, updated);
      return updated;
    },
    createTerminalConnectionToken: async (request: { locationObjectId: string }) => {
      record(`createTerminalConnectionToken:${request.locationObjectId}`);
      guard();
      return { secret: `pst_${mode}_${next()}` };
    },
    presentTerminalPaymentMethod: async (request: { readerObjectId: string }) => {
      record('presentTerminalPaymentMethod');
      return tap(request.readerObjectId);
    },
  };
}

/**
 * What the provider does when a card is presented: amounts ending in `05` are
 * declined (as on the provider's test amounts), everything else authorized —
 * captured at once, or held for a manual capture.
 */
function tap(readerObjectId: string): ProviderTerminalReader {
  const reader = readerOf(readerObjectId);
  const paymentId = reader.action?.paymentObjectId;
  if (!paymentId) throw new Error('nothing to present a card to');
  const payment = paymentOf(paymentId);
  const declined = payment.amount.endsWith('05');
  payments.set(
    paymentId,
    declined
      ? {
          ...payment,
          status: 'requires_payment_method',
          lastPaymentError: {
            type: 'card_error',
            code: 'card_declined',
            declineCode: 'generic_decline',
          },
        }
      : {
          ...payment,
          status: payment.captureMethod === 'manual' ? 'requires_capture' : 'succeeded',
          chargeObjectId: paymentId.replace(/^pi_/, 'ch_'),
        },
  );
  const updated: ProviderTerminalReader = {
    ...reader,
    action: {
      type: 'process_payment_intent',
      status: declined ? 'failed' : 'succeeded',
      paymentObjectId: paymentId,
      failureCode: declined ? 'card_declined' : null,
    },
  };
  readers.set(readerObjectId, updated);
  return updated;
}

const fakes = { test: fakeProviderFor('test'), live: fakeProviderFor('live') };

const realRegistry = await import('../../services/providers/registry');
const { resolveProvider: realResolveProvider, resolveCardProvider: realResolveCardProvider } =
  realRegistry;
let useFake = false;
const { config } = await import('../../config');
function fakeFor(mode: ProviderMode) {
  return config.stripe[mode]?.cardRail ? fakes[mode] : undefined;
}
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFake ? fakeFor(mode) : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFake ? fakeFor(mode) : realResolveCardProvider(mode),
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createTerminalRouter, mountTerminalDashboardRoutes } = await import('../terminal');
const { createPaymentIntentsRouter } = await import('../paymentIntents');
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { insertProviderEvent, findProviderEventById } = await import(
  '../../db/providers/providerEventRepository'
);
const { processProviderEvent } = await import('../../services/providers/eventProcessor');
const { findTerminalReaderForMerchant } = await import('../../db/terminal/terminalRepository');
const { reconcileReader } = await import('../../services/terminal/terminal');
const { applyAccountSnapshot, insertMerchantAccount } = await import(
  '../../db/accounts/connectedAccountRepository'
);
const { createCheckoutSessionParams } = await import('@peable.to/contracts');
const { events, terminalReaders } = await import('../../db/schema');
const { eq } = await import('drizzle-orm');
const { wrap } = await import('../../lib/http');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');
const { must } = await import('../../__tests__/helpers/must');

let credential: { appId: string; environment: OxyServiceEnvironment } = {
  appId: 'app_terminal',
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
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Json,
  };
}

async function eventTypes(merchantId: string, prefix: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ type: events.type })
    .from(events)
    .where(eq(events.merchantId, merchantId))
    .orderBy(events.createdAt, events.id);
  return rows.map((row) => row.type).filter((type) => type.startsWith(prefix));
}

async function deliver(
  type: string,
  objectIds: Record<string, string>,
  livemode = false,
  payload: Record<string, unknown> = {},
) {
  const n = next();
  const id = await insertProviderEvent(gatewayDb(), {
    provider: 'stripe',
    providerEventId: `evt_terminal_${n}`,
    providerAccountId: null,
    type,
    livemode,
    apiVersion: '2026-07-29.dahlia',
    objectIds,
    payload: { id: `evt_terminal_${n}`, object: 'event', ...payload },
  });
  const row = id ? await findProviderEventById(gatewayDb(), id) : null;
  if (!row) throw new Error('event not stored');
  return processProviderEvent(row);
}

const ADDRESS = {
  line1: '1272 Valencia Street',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94110',
  country: 'US',
};

async function newLocation(): Promise<Json> {
  const created = await call('POST', '/v1/terminal/locations', {
    display_name: 'Valencia Street',
    address: ADDRESS,
  });
  expect(created.status).toBe(201);
  return created.body;
}

async function newReader(location: string, label = 'Front counter'): Promise<Json> {
  const created = await call('POST', '/v1/terminal/readers', {
    registration_code: 'simulated-wpe',
    location,
    label,
  });
  expect(created.status).toBe(201);
  return created.body;
}

async function cardPresentIntent(amount: string, captureMethod = 'automatic'): Promise<Json> {
  const created = await call('POST', '/v1/payment_intents', {
    amount,
    rail: 'card',
    currency: 'USD',
    payment_method_types: ['card_present'],
    capture_method: captureMethod,
  });
  expect(created.status).toBe(201);
  return created.body;
}

async function providerReaderIdOf(publicId: string, merchantId: string): Promise<string> {
  return must(await findTerminalReaderForMerchant(gatewayDb(), publicId, merchantId))
    .providerObjectId;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('Terminal (ADR 0024)', () => {
  useGatewayDatabase();

  let merchantId = '';
  let liveMerchantId = '';

  beforeAll(async () => {
    useFake = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    const merchant = await seedMerchant({ oxyAppId: 'app_terminal', environment: 'development' });
    merchantId = merchant.id;
    const live = await seedMerchant({
      oxyAppId: 'app_terminal',
      environment: 'production',
      network: 'mainnet',
    });
    liveMerchantId = live.id;

    const app = express();
    app.use(express.json());
    app.use(createTerminalRouter({ requireMerchant: stubRequireMerchant }));
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubRequireMerchant,
        optionalServiceAuth: stubRequireMerchant,
      }),
    );
    // Orbit's surface, behind a gate that admits the development merchant.
    const dashboard = express.Router();
    mountTerminalDashboardRoutes(dashboard, {
      base: '/v1/dashboard/applications/:applicationId',
      requireOxyUser: (_req, _res, nextHandler) => nextHandler(),
      gate: (_action, core) =>
        wrap(async (req, res) => {
          await core(req, res, merchant, {} as never);
        }),
    });
    app.use(dashboard);
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
        res.status(500).json({ error: { type: 'api_error', message: error.message } });
      },
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    calls.length = 0;
    credential = { appId: 'app_terminal', environment: 'development' };
    terminalEnabled = true;
    config.orbit.thirdPartyLivePayments = false;
  });

  afterAll(async () => {
    restoreModes();
    useFake = false;
    config.orbit.thirdPartyLivePayments = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('locations: created at the provider first, read, updated, listed, deleted once empty', async () => {
    const location = await newLocation();
    expect(location.id).toMatch(/^tml_/);
    expect(location.object).toBe('terminal.location');
    expect(location.livemode).toBe(false);
    expect(location.address).toEqual({ ...ADDRESS, line2: null });
    expect(calls).toEqual(['test:createTerminalLocation']);
    expect(JSON.stringify(location)).not.toContain('tml_test_');

    const updated = await call('POST', `/v1/terminal/locations/${location.id}`, {
      display_name: 'Valencia Street shop',
      metadata: { store: '7' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.display_name).toBe('Valencia Street shop');
    expect(updated.body.metadata).toEqual({ store: '7' });

    const listed = await call('GET', '/v1/terminal/locations');
    expect(listed.body.data.map((row: Json) => row.id)).toContain(location.id);
    expect((await call('GET', `/v1/terminal/locations/${location.id}`)).body.display_name).toBe(
      'Valencia Street shop',
    );

    const reader = await newReader(location.id);
    const refused = await call('DELETE', `/v1/terminal/locations/${location.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('terminal_location_in_use');
    expect((await call('DELETE', `/v1/terminal/readers/${reader.id}`)).body).toEqual({
      id: reader.id,
      object: 'terminal.reader',
      deleted: true,
    });
    const deleted = await call('DELETE', `/v1/terminal/locations/${location.id}`);
    expect(deleted.body).toEqual({ id: location.id, object: 'terminal.location', deleted: true });
    expect((await call('GET', `/v1/terminal/locations/${location.id}`)).status).toBe(404);
  });

  test('readers: registered with a code at a location of this merchant; label, status, expand, list', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    expect(reader).toMatchObject({
      object: 'terminal.reader',
      label: 'Front counter',
      device_type: 'simulated_wisepos_e',
      status: 'online',
      location: location.id,
      action: null,
      livemode: false,
    });
    expect(reader.id).toMatch(/^tmr_/);

    const expanded = await call('GET', `/v1/terminal/readers/${reader.id}?expand[]=location`);
    expect(expanded.body.location.display_name).toBe('Valencia Street');

    const relabeled = await call('POST', `/v1/terminal/readers/${reader.id}`, {
      label: 'Back bar',
    });
    expect(relabeled.body.label).toBe('Back bar');

    const listed = await call('GET', `/v1/terminal/readers?location=${location.id}`);
    expect(listed.body.data.map((row: Json) => row.id)).toEqual([reader.id]);

    const unknown = await call('POST', '/v1/terminal/readers', {
      registration_code: 'simulated-wpe',
      location: 'tml_nope',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.param).toBe('location');
  });

  test('a card_present payment is a card payment collected by a reader, never FairCoin, a checkout or a server confirm', async () => {
    const intent = await cardPresentIntent('2500');
    expect(intent.rail).toBe('card');
    expect(intent.payment_method_types).toEqual(['card_present']);
    expect(intent.status).toBe('requires_payment_method');
    const sent = [...payments.values()].find((p) => p.mode === 'test' && p.amount === '2500');
    expect(must(sent).request.paymentMethodTypes).toEqual(['card_present']);

    const mixed = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'USD',
      payment_method_types: ['card_present', 'card'],
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.param).toBe('payment_method_types');

    const faircoin = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      network: 'testnet',
      payment_method_types: ['card_present'],
    });
    expect(faircoin.status).toBe(400);
    expect(faircoin.body.error.param).toBe('payment_method_types');

    const saving = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'USD',
      payment_method_types: ['card_present'],
      setup_future_usage: 'off_session',
    });
    expect(saving.status).toBe(400);

    const confirm = await call('POST', `/v1/payment_intents/${intent.id}/confirm`, {
      payment_method: 'pm_anything',
    });
    expect(confirm.status).toBe(400);
    expect(confirm.body.error.message).toContain('reader');

    // A checkout session offers card and FairCoin; card_present is not a method it knows.
    expect(
      createCheckoutSessionParams.safeParse({
        mode: 'payment',
        line_items: [{ price: 'price_x', quantity: 1 }],
        payment_method_types: ['card_present', 'faircoin'],
      }).success,
    ).toBe(false);
  });

  test('collect: claimed, acknowledged, then the tap settles the reader once and the payment succeeds on the card path', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const intent = await cardPresentIntent('4200');

    const processing = await call(
      'POST',
      `/v1/terminal/readers/${reader.id}/process_payment_intent`,
      { payment_intent: intent.id, process_config: { enable_customer_cancellation: true } },
    );
    expect(processing.status).toBe(200);
    expect(processing.body.action).toEqual({
      type: 'process_payment_intent',
      status: 'in_progress',
      failure_code: null,
      failure_message: null,
      process_payment_intent: {
        payment_intent: intent.id,
        process_config: { enable_customer_cancellation: true, skip_tipping: true },
      },
    });

    // A second collection on the busy reader is refused before the provider is asked.
    const other = await cardPresentIntent('1000');
    calls.length = 0;
    const busy = await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: other.id,
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('terminal_reader_busy');
    expect(calls.some((c) => c.includes('processTerminalPayment'))).toBe(false);

    const tapped = await call(
      'POST',
      `/v1/test_helpers/terminal/readers/${reader.id}/present_payment_method`,
      {},
    );
    expect(tapped.status).toBe(200);
    expect(tapped.body.action.status).toBe('succeeded');

    const paid = await call('GET', `/v1/payment_intents/${intent.id}`);
    expect(paid.body.status).toBe('succeeded');
    expect(paid.body.amount_received).toBe('4200');
    expect(paid.body.latest_charge).toMatch(/^ch_/);

    // The provider's events arrive afterwards: nothing is told twice.
    const providerReader = await providerReaderIdOf(reader.id, merchantId);
    await deliver('terminal.reader.action_succeeded', { 'terminal.reader': providerReader });
    const pi = must([...payments.values()].find((p) => p.amount === '4200')).providerObjectId;
    await deliver('payment_intent.succeeded', { payment_intent: pi });
    expect(await eventTypes(merchantId, 'terminal.')).toEqual(['terminal.reader.action_succeeded']);
    const intentEvents = (await eventTypes(merchantId, 'payment_intent.')).filter(Boolean);
    expect(intentEvents.filter((type) => type === 'payment_intent.succeeded')).toHaveLength(1);

    // The reader is free again.
    const again = await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: other.id,
    });
    expect(again.status).toBe(200);
    await call('POST', `/v1/terminal/readers/${reader.id}/cancel_action`, {});
  });

  test('a declined tap: the reader action fails, the payment returns to requires_payment_method with its error and is collectable again', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const intent = await cardPresentIntent('1005');
    await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    const tapped = await call(
      'POST',
      `/v1/test_helpers/terminal/readers/${reader.id}/present_payment_method`,
      {},
    );
    expect(tapped.body.action.status).toBe('failed');
    expect(tapped.body.action.failure_code).toBe('card_declined');
    expect(tapped.body.action.failure_message).toBe('The card was declined.');

    // The decline's payment_failed comes with the provider's own event.
    const pi = must([...payments.values()].find((p) => p.amount === '1005')).providerObjectId;
    await deliver('payment_intent.payment_failed', { payment_intent: pi }, false, {
      data: { object: { last_payment_error: { type: 'card_error', code: 'card_declined' } } },
    });
    const declined = await call('GET', `/v1/payment_intents/${intent.id}`);
    expect(declined.body.status).toBe('requires_payment_method');
    expect(declined.body.last_payment_error).not.toBeNull();

    // Payable again, on the same reader.
    payments.set(pi, {
      ...paymentOf(pi),
      amount: '1000',
      lastPaymentError: undefined,
    } as FakePayment);
    const retry = await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.action.status).toBe('in_progress');
    await call('POST', `/v1/test_helpers/terminal/readers/${reader.id}/present_payment_method`, {});
    expect((await call('GET', `/v1/payment_intents/${intent.id}`)).body.status).toBe('succeeded');
    expect(await eventTypes(merchantId, 'terminal.')).toContain('terminal.reader.action_failed');
  });

  test('manual capture: the tap authorizes, the merchant captures through the PaymentIntent', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const intent = await cardPresentIntent('3000', 'manual');
    await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    await call('POST', `/v1/test_helpers/terminal/readers/${reader.id}/present_payment_method`, {});
    const held = await call('GET', `/v1/payment_intents/${intent.id}`);
    expect(held.body.status).toBe('requires_capture');
    expect(held.body.amount_capturable).toBe('3000');
    const captured = await call('POST', `/v1/payment_intents/${intent.id}/capture`, {});
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe('succeeded');
  });

  test('cancel_action: the reader stops, the payment stays payable', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const intent = await cardPresentIntent('2000');
    await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    const canceled = await call('POST', `/v1/terminal/readers/${reader.id}/cancel_action`, {});
    expect(canceled.status).toBe(200);
    expect(canceled.body.action.status).toBe('failed');
    expect(canceled.body.action.failure_code).toBe('request_canceled');
    expect((await call('GET', `/v1/payment_intents/${intent.id}`)).body.status).toBe(
      'requires_payment_method',
    );
  });

  test('CAS: a stale reader read cannot settle a newer attempt, and two settlements of one attempt record one event', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const intent = await cardPresentIntent('2100');
    const providerReader = await providerReaderIdOf(reader.id, merchantId);

    // Attempt 1 is canceled.
    await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    await call('POST', `/v1/terminal/readers/${reader.id}/cancel_action`, {});
    // Attempt 2 is claimed but not yet acknowledged by the provider: the
    // provider still shows attempt 1's failure, and an event read now must
    // not settle attempt 2 with it.
    const row = must(await findTerminalReaderForMerchant(gatewayDb(), reader.id, merchantId));
    await gatewayDb()
      .update(terminalReaders)
      .set({
        actionStatus: 'in_progress',
        actionFailureCode: null,
        actionStartedAt: new Date(),
        actionAcknowledgedAt: null,
      })
      .where(eq(terminalReaders.id, row.id));
    const before = (await eventTypes(merchantId, 'terminal.')).length;
    await deliver('terminal.reader.action_failed', { 'terminal.reader': providerReader });
    const still = must(await findTerminalReaderForMerchant(gatewayDb(), reader.id, merchantId));
    expect(still.action?.status).toBe('in_progress');
    expect((await eventTypes(merchantId, 'terminal.')).length).toBe(before);

    // Acknowledged, the provider's failure settles it — ONCE, however many
    // readers of the provider race.
    await gatewayDb()
      .update(terminalReaders)
      .set({ actionAcknowledgedAt: new Date() })
      .where(eq(terminalReaders.id, row.id));
    const acknowledged = must(
      await findTerminalReaderForMerchant(gatewayDb(), reader.id, merchantId),
    );
    await Promise.all([
      reconcileReader(acknowledged),
      reconcileReader(acknowledged),
      deliver('terminal.reader.action_failed', { 'terminal.reader': providerReader }),
    ]);
    expect((await eventTypes(merchantId, 'terminal.')).length).toBe(before + 1);
    expect((await call('GET', `/v1/payment_intents/${intent.id}`)).body.status).toBe(
      'requires_payment_method',
    );
  });

  test('a reader action and a PaymentIntent cancel race: the payment ends once, on the card path', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const intent = await cardPresentIntent('2200');
    await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    const canceled = await call('POST', `/v1/payment_intents/${intent.id}/cancel`, {});
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
    // The reader's success arriving late cannot move a canceled payment.
    const providerReader = await providerReaderIdOf(reader.id, merchantId);
    tap(providerReader);
    await deliver('terminal.reader.action_succeeded', { 'terminal.reader': providerReader });
    expect((await call('GET', `/v1/payment_intents/${intent.id}`)).body.status).toBe('canceled');
    const told = await gatewayDb()
      .select({ type: events.type, dataObject: events.dataObject })
      .from(events)
      .where(eq(events.merchantId, merchantId));
    expect(
      told.filter((row) => row.dataObject.id === intent.id).map((row) => row.type),
    ).not.toContain('payment_intent.succeeded');
  });

  test('a collection refuses a payment that is not card_present, or not waiting for a payment method', async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const online = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'USD',
      payment_method_types: ['card'],
    });
    const refused = await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: online.body.id,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('payment_intent');

    const intent = await cardPresentIntent('2300');
    await call('POST', `/v1/payment_intents/${intent.id}/cancel`, {});
    const ended = await call('POST', `/v1/terminal/readers/${reader.id}/process_payment_intent`, {
      payment_intent: intent.id,
    });
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe('payment_intent_unexpected_state');
  });

  test('connection tokens: minted fresh, never stored, scoped to a location of this merchant', async () => {
    const location = await newLocation();
    const token = await call('POST', '/v1/terminal/connection_tokens', { location: location.id });
    expect(token.status).toBe(201);
    expect(token.body.object).toBe('terminal.connection_token');
    expect(token.body.secret).toMatch(/^pst_test_/);
    expect(token.body.location).toBe(location.id);
    expect(token.headers.get('cache-control')).toBe('no-store');
    expect(calls.at(-1)).toMatch(/^test:createTerminalConnectionToken:tml_test_/);
    const unknown = await call('POST', '/v1/terminal/connection_tokens', { location: 'tml_nope' });
    expect(unknown.status).toBe(400);
    // Never unscoped: a token without a location would reach every merchant's readers.
    calls.length = 0;
    const unscoped = await call('POST', '/v1/terminal/connection_tokens', {});
    expect(unscoped.status).toBe(400);
    expect(unscoped.body.error.param).toBe('location');
    // Another merchant's location is not this merchant's.
    credential = { appId: 'app_terminal', environment: 'production' };
    const foreign = await call('POST', '/v1/terminal/connection_tokens', { location: location.id });
    expect(foreign.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('mode isolation: a live merchant acts through the live key only; no Terminal is 503; simulated codes and the test helper are refused in live', async () => {
    credential = { appId: 'app_terminal', environment: 'production' };
    const location = await call('POST', '/v1/terminal/locations', {
      display_name: 'Live shop',
      address: ADDRESS,
    });
    expect(location.status).toBe(201);
    expect(location.body.livemode).toBe(true);
    expect(calls).toEqual(['live:createTerminalLocation']);

    const simulated = await call('POST', '/v1/terminal/readers', {
      registration_code: 'simulated-wpe',
      location: location.body.id,
    });
    expect(simulated.status).toBe(400);
    expect(simulated.body.error.param).toBe('registration_code');

    const real = await call('POST', '/v1/terminal/readers', {
      registration_code: 'sepia-cerulean-aqua',
      location: location.body.id,
    });
    expect(real.status).toBe(201);
    const helper = await call(
      'POST',
      `/v1/test_helpers/terminal/readers/${real.body.id}/present_payment_method`,
      {},
    );
    expect(helper.status).toBe(403);
    expect(helper.body.error.code).toBe('test_mode_only');
    expect(calls.some((c) => c.startsWith('test:'))).toBe(false);

    // The test merchant's reader is not the live merchant's.
    credential = { appId: 'app_terminal', environment: 'development' };
    expect((await call('GET', `/v1/terminal/readers/${real.body.id}`)).status).toBe(404);

    terminalEnabled = false;
    const off = await call('POST', '/v1/terminal/locations', {
      display_name: 'Nope',
      address: ADDRESS,
    });
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('terminal_unavailable');

    terminalEnabled = true;
    const keyless = setStripeModes({ test: undefined, live: stripeModeFixture('live') });
    try {
      const none = await call('POST', '/v1/terminal/locations', {
        display_name: 'Nope',
        address: ADDRESS,
      });
      expect(none.status).toBe(503);
      expect(none.body.error.code).toBe('terminal_unavailable');
    } finally {
      keyless();
    }
    // The drain refuses an event naming the other mode's reader.
    const liveReader = await providerReaderIdOf(real.body.id, liveMerchantId);
    const crossed = await deliver('terminal.reader.action_succeeded', {
      'terminal.reader': liveReader,
    });
    expect(crossed.kind).toBe('failed');
  });

  test('charge routing and the live gate apply to card_present as to every card payment', async () => {
    // A merchant with its own onboarded account: a destination charge, on its behalf, with the fee.
    credential = { appId: 'app_terminal_own', environment: 'development' };
    const merchant = await seedMerchant({
      oxyAppId: 'app_terminal_own',
      environment: 'development',
    });
    const account = must(
      await insertMerchantAccount(gatewayDb(), {
        publicId: `ca_own_${next()}`,
        merchantId: merchant.id,
        provider: 'stripe',
        providerAccountId: 'acct_own_terminal',
        country: 'US',
      }),
    );
    await applyAccountSnapshot(gatewayDb(), account.id, {
      payoutsEnabled: true,
      chargesEnabled: true,
      transfersCapability: 'active',
      cardPaymentsCapability: 'active',
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      disabledReasonCodes: [],
      defaultCurrency: 'USD',
      businessProfile: {} as never,
      settings: {} as never,
    });
    await cardPresentIntent('10000');
    const sent = must([...payments.values()].find((p) => p.amount === '10000')).request;
    expect(sent.transferDestination).toBe('acct_own_terminal');
    expect(sent.onBehalfOf).toBe('acct_own_terminal');

    // The same merchant in live mode, not an Oxy product: gated until the flag opens.
    credential = { appId: 'app_terminal_own', environment: 'production' };
    const live = await seedMerchant({
      oxyAppId: 'app_terminal_own',
      environment: 'production',
      network: 'mainnet',
    });
    const liveAccount = must(
      await insertMerchantAccount(gatewayDb(), {
        publicId: `ca_own_${next()}`,
        merchantId: live.id,
        provider: 'stripe',
        providerAccountId: 'acct_own_terminal_live',
        country: 'US',
      }),
    );
    await applyAccountSnapshot(gatewayDb(), liveAccount.id, {
      payoutsEnabled: true,
      chargesEnabled: true,
      transfersCapability: 'active',
      cardPaymentsCapability: 'active',
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      disabledReasonCodes: [],
      defaultCurrency: 'USD',
      businessProfile: {} as never,
      settings: {} as never,
    });
    calls.length = 0;
    const gated = await call('POST', '/v1/payment_intents', {
      amount: '10000',
      rail: 'card',
      currency: 'USD',
      payment_method_types: ['card_present'],
    });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe('live_payments_gated');
    expect(calls).toEqual([]);
  });

  test("Orbit's collect: one request creates the card_present payment and hands it to the reader", async () => {
    const location = await newLocation();
    const reader = await newReader(location.id);
    const collected = await call(
      'POST',
      `/v1/dashboard/applications/app_terminal/terminal/readers/${reader.id}/collect`,
      { amount: '1250', currency: 'USD', description: 'Coffee' },
    );
    expect(collected.status).toBe(200);
    expect(collected.body.reader.action.status).toBe('in_progress');
    expect(collected.body.payment_intent.payment_method_types).toEqual(['card_present']);
    expect(collected.body.payment_intent.amount).toBe('1250');
    const tapped = await call(
      'POST',
      `/v1/dashboard/applications/app_terminal/test_helpers/terminal/readers/${reader.id}/present_payment_method`,
      {},
    );
    expect(tapped.body.action.status).toBe('succeeded');
    expect(
      (await call('GET', `/v1/payment_intents/${collected.body.payment_intent.id}`)).body.status,
    ).toBe('succeeded');
  });
});
