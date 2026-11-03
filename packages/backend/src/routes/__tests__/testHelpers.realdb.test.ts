/**
 * `/v1/test_helpers/*` over HTTP, through the real gateway and database, with
 * only the Oxy credential stubbed: a simulated FairCoin payment moves through
 * the real state machine with its real events (`processing`, then
 * `succeeded`; or `payment_failed` + `canceled` when underpaid), a retried
 * helper replays, a card payment and a live credential are refused, and an
 * expired checkout session cancels its payment as the expiry sweep would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { findIntentForMerchant } from '../../db/payments/paymentIntentRepository';
import { must } from '../../__tests__/helpers/must';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_test_helpers';
let appId = APP_ID;
let environment: OxyServiceEnvironment = 'development';
let gateway: Gateway | undefined;
let baseUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId,
    appName: 'helpers',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment,
    tier: 'external',
  };
  next();
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Json,
    headers: response.headers,
  };
}

async function createFaircoinIntent(): Promise<string> {
  const created = await call('POST', '/v1/payment_intents', {
    amount: '100000000',
    network: 'testnet',
  });
  expect(created.status).toBe(201);
  expect(created.json.status).toBe('requires_action');
  return String(created.json.id);
}

const simulate = (id: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  call('POST', `/v1/test_helpers/payment_intents/${id}/simulate_faircoin_payment`, body, headers);

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: stubRequireMerchant,
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('simulate_faircoin_payment', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    appId = APP_ID;
    environment = 'development';
    merchant = await seedMerchant({ oxyAppId: APP_ID, requiredConfirmations: 3 });
  });

  test('requires_action → processing → succeeded, with the real events', async () => {
    const id = await createFaircoinIntent();
    const simulated = await simulate(id);
    expect(simulated.status).toBe(200);
    expect(simulated.json).toMatchObject({ id, status: 'succeeded' });
    expect(simulated.json.faircoin).toMatchObject({ confirmations: 3 });
    expect(String((simulated.json.faircoin as Json).txid)).toMatch(/^[0-9a-f]{64}$/);

    const intent = must(await findIntentForMerchant(gatewayDb(), id, merchant.id));
    const types = (await storedEvents({ paymentIntentId: intent.id })).map(({ row }) => row.type);
    expect(types).toEqual([
      'payment_intent.created',
      'payment_intent.processing',
      'payment_intent.succeeded',
    ]);
  });

  test('underpaid ends canceled (underpaid), as the watcher would', async () => {
    const id = await createFaircoinIntent();
    const simulated = await simulate(id, { outcome: 'underpaid' });
    expect(simulated.status).toBe(200);
    expect(simulated.json).toMatchObject({ status: 'canceled', cancellation_reason: 'underpaid' });
    const intent = must(await findIntentForMerchant(gatewayDb(), id, merchant.id));
    const types = (await storedEvents({ paymentIntentId: intent.id })).map(({ row }) => row.type);
    expect(types.slice(-3)).toEqual([
      'payment_intent.processing',
      'payment_intent.payment_failed',
      'payment_intent.canceled',
    ]);
  });

  test('a retry with the same Idempotency-Key replays; without one a settled payment is a 409', async () => {
    const id = await createFaircoinIntent();
    const first = await simulate(id, {}, { 'Idempotency-Key': 'sim-1' });
    const again = await simulate(id, {}, { 'Idempotency-Key': 'sim-1' });
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(again.json).toEqual(first.json);
    const fresh = await simulate(id);
    expect(fresh.status).toBe(409);
  });

  test('a card payment is refused (400), an unknown one is a 404, a bad outcome a 400', async () => {
    const card = await seedIntent(merchant, { rail: 'card', currency: 'EUR', amount: '1000' });
    const refused = await simulate(card.publicId);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatchObject({ code: 'rail_mismatch' });
    expect((await simulate('pi_missing')).status).toBe(404);
    const id = await createFaircoinIntent();
    const invalid = await simulate(id, { outcome: 'paid_twice' });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error).toMatchObject({ param: 'outcome' });
  });

  test('a live credential is refused with 403 test_mode_only, before anything is read', async () => {
    appId = 'app_test_helpers_live';
    environment = 'production';
    await seedMerchant({ oxyAppId: appId, environment: 'production', network: 'mainnet' });
    const refused = await simulate('pi_whatever');
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatchObject({ type: 'permission_error', code: 'test_mode_only' });
    const expire = await call('POST', '/v1/test_helpers/checkout_sessions/cs_whatever/expire', {});
    expect(expire.status).toBe(403);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('checkout_sessions/:id/expire', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    appId = APP_ID;
    environment = 'development';
    merchant = await seedMerchant({ oxyAppId: APP_ID });
  });

  test("cancels the session's payment as abandoned, with payment_intent.canceled", async () => {
    const session = await call('POST', '/v1/checkout_sessions', {
      amount: '100000000',
      network: 'testnet',
    });
    expect(session.status).toBe(201);
    const expired = await call(
      'POST',
      `/v1/test_helpers/checkout_sessions/${String(session.json.id)}/expire`,
      {},
    );
    expect(expired.status).toBe(200);
    expect(expired.json).toMatchObject({ id: session.json.id, object: 'checkout_session' });

    const intent = await call('GET', `/v1/payment_intents/${String(session.json.payment_intent)}`);
    expect(intent.json).toMatchObject({ status: 'canceled', cancellation_reason: 'abandoned' });
    const row = must(
      await findIntentForMerchant(gatewayDb(), String(session.json.payment_intent), merchant.id),
    );
    const types = (await storedEvents({ paymentIntentId: row.id })).map(({ row: e }) => e.type);
    expect(types.at(-1)).toBe('payment_intent.canceled');

    // A canceled payment cannot expire again.
    const twice = await call(
      'POST',
      `/v1/test_helpers/checkout_sessions/${String(session.json.id)}/expire`,
      {},
    );
    expect(twice.status).toBe(409);
  });

  test('a session whose payment is already processing cannot expire', async () => {
    const session = await call('POST', '/v1/checkout_sessions', {
      amount: '100000000',
      network: 'testnet',
    });
    // Broadcast only: what a real payer pressing send does.
    const intent = must(
      await findIntentForMerchant(gatewayDb(), String(session.json.payment_intent), merchant.id),
    );
    const submitted = await call('POST', `/v1/payment_intents/${intent.publicId}/submit_tx`, {
      client_secret: intent.clientSecret,
      txid: 'a'.repeat(64),
    });
    expect(submitted.json.status).toBe('processing');
    const expired = await call(
      'POST',
      `/v1/test_helpers/checkout_sessions/${String(session.json.id)}/expire`,
      {},
    );
    expect(expired.status).toBe(409);
    expect(
      (await call('POST', '/v1/test_helpers/checkout_sessions/cs_nope/expire', {})).status,
    ).toBe(404);
  });
});
