/**
 * ADR 0002's network gate, closed again after it was opened (ADR 0021 D5,
 * amended 2026-11-06): while the deployment says `testnet`, an open mainnet
 * FairCoin payment nobody has broadcast to is never offered — a payer read
 * retires it `faircoin_network_closed`, the sweep retires what no payer read
 * saw, and the order wrapping it stays open, answering `faircoin_network_closed`
 * on the next confirm instead of a payable address. A broadcast payment is left
 * to settle. Over HTTP through the real gateway and database, the Oxy
 * credential and identity keys stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import type { NetworkType } from '@fairco.in/core';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { config } from '../../config';
import { must } from '../../__tests__/helpers/must';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { testIdentityPublicKey } from '../../__tests__/setup/identityKeys';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { useIdentityKeyResolver } from '../../services/socialReceive';
import {
  forgetRecentIdentityKeys,
  resetRecipientKeySweep,
  runRecipientKeySweep,
} from '../../services/faircoin/keyBinding';
import { reportFaircoinBroadcast } from '../../services/faircoinBroadcast';
import { useAddressUsageReader } from '../../services/faircoin/addressPool';
import type { AddressUsage } from '../../services/explorer';

type Json = Record<string, unknown>;

const APP_ID = 'app_network_gate';
const OWNER = 'owner_network_gate';
let gateway: Gateway | undefined;
let baseUrl = '';

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 'network gate',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: OWNER,
    environment: 'production',
    tier: 'external',
  };
  next();
};

/** Open or close ADR 0002's gate, as `PEABLE_SOCIAL_PAY_NETWORK` would. */
function gate(network: NetworkType): void {
  (config as { socialPayNetwork: NetworkType }).socialPayNetwork = network;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

async function openSession(): Promise<{ id: string; secret: Record<string, string> }> {
  const session = await call('POST', '/v1/checkout_sessions', {
    line_items: [
      {
        price_data: { currency: 'FAIR', unit_amount: '100000000', product_data: { name: 'Item' } },
        quantity: 1,
      },
    ],
    success_url: 'https://shop.example/ok',
  });
  expect(session.status).toBe(201);
  const id = String(session.json.id);
  const secret = {
    'X-Peable-Client-Secret': decodeURIComponent(String(session.json.url).split('#cs=')[1] ?? ''),
  };
  const filled = await call(
    'POST',
    `/v1/checkout_sessions/${id}/public`,
    { customer_details: { email: 'p@example.com' } },
    secret,
  );
  expect(filled.status).toBe(200);
  return { id, secret };
}

async function createApiIntent(): Promise<Json> {
  const created = await call('POST', '/v1/payment_intents', {
    amount: '100000000',
    network: 'mainnet',
  });
  expect(created.status).toBe(201);
  return created.json;
}

useGatewayDatabase();

let previousResolver: ReturnType<typeof useIdentityKeyResolver> = null;
const previousGate = config.socialPayNetwork;

beforeAll(() => {
  previousResolver = useIdentityKeyResolver(async (accountId) => testIdentityPublicKey(accountId));
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (req, res, next) =>
      req.query.client_secret === undefined ? stubRequireMerchant(req, res, next) : next(),
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  useIdentityKeyResolver(previousResolver);
  gateway?.io.close();
  gateway?.httpServer.close();
});

/** What the Explorer says about every address; the preload's `unknown` is restored after each test. */
let chain: AddressUsage = 'unused';
const chainAsked: string[] = [];
let previousUsageReader: ReturnType<typeof useAddressUsageReader> | null = null;

beforeEach(() => {
  chain = 'unused';
  chainAsked.length = 0;
  previousUsageReader = useAddressUsageReader(async (address) => {
    chainAsked.push(address);
    return chain;
  });
});

afterEach(() => {
  gate(previousGate);
  if (previousUsageReader) useAddressUsageReader(previousUsageReader);
  previousUsageReader = null;
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('closing the mainnet gate retires open payments', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    forgetRecentIdentityKeys();
    resetRecipientKeySweep();
    gate('mainnet');
    await seedMerchant({ oxyAppId: APP_ID, ownerAccountId: OWNER, network: 'mainnet' });
  });

  test("the session's payer read retires the payment; the session stays open and its confirm says the network is closed", async () => {
    const { id, secret } = await openSession();
    const confirmed = await call('POST', `/v1/checkout_sessions/${id}/public/confirm`, {}, secret);
    expect(confirmed.status).toBe(200);
    const payment = must(confirmed.json.payment_intent as Json | null);
    expect(payment.status).toBe('requires_action');

    gate('testnet');
    const read = await call('GET', `/v1/checkout_sessions/${id}/public`, undefined, secret);
    expect(read.status).toBe(200);
    expect(read.json.status).toBe('open');
    expect(read.json.payment_intent).toBeNull();
    expect(must(await findIntentByPublicId(gatewayDb(), String(payment.id)))).toMatchObject({
      status: 'canceled',
      cancellationReason: 'faircoin_network_closed',
    });

    const again = await call('POST', `/v1/checkout_sessions/${id}/public/confirm`, {}, secret);
    expect(again.status).toBe(409);
    expect((again.json.error as Json).code).toBe('faircoin_network_closed');

    // Opened again: the same session takes a fresh payment, never the retired one.
    gate('mainnet');
    const reopened = await call('POST', `/v1/checkout_sessions/${id}/public/confirm`, {}, secret);
    expect(reopened.status).toBe(200);
    const fresh = must(reopened.json.payment_intent as Json | null);
    expect(fresh.status).toBe('requires_action');
    expect(fresh.id).not.toBe(payment.id);
  });

  test("the intent's payer read retires it too", async () => {
    const created = await createApiIntent();
    gate('testnet');
    const read = await call(
      'GET',
      `/v1/payment_intents/${String(created.id)}?client_secret=${encodeURIComponent(String(created.client_secret))}`,
    );
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      status: 'canceled',
      cancellation_reason: 'faircoin_network_closed',
      next_action: null,
    });
  });

  // Round-3 review: "nobody broadcast" meant "nobody reported a txid". A payer
  // whose wallet broadcast without reporting yet was canceled, and the coins
  // reached the recipient while the order went unpaid.
  test('a payment whose address the chain shows paid is not retired, by a payer read or the sweep', async () => {
    const { id, secret } = await openSession();
    const confirmed = await call('POST', `/v1/checkout_sessions/${id}/public/confirm`, {}, secret);
    const payment = must(confirmed.json.payment_intent as Json | null);
    const row = must(await findIntentByPublicId(gatewayDb(), String(payment.id)));

    gate('testnet');
    chain = 'used';
    const read = await call('GET', `/v1/checkout_sessions/${id}/public`, undefined, secret);
    expect(read.status).toBe(200);
    expect((read.json.payment_intent as Json | null)?.id).toBe(payment.id);
    expect(chainAsked).toEqual([must(row.address)]);
    const sweep = await runRecipientKeySweep();
    expect(sweep).toMatchObject({ retired: 0, held: 1 });
    expect(must(await findIntentByPublicId(gatewayDb(), String(payment.id))).status).toBe(
      'requires_action',
    );

    // The payer reports the txid it broadcast: the payment is there to take it.
    const reported = await reportFaircoinBroadcast(
      must(await findIntentByPublicId(gatewayDb(), String(payment.id))),
      'b'.repeat(64),
    );
    expect(reported.kind).toBe('updated');
  });

  test('on mainnet an Explorer that cannot tell retires nothing; the next sweep that can, does', async () => {
    const created = await createApiIntent();
    gate('testnet');
    chain = 'unknown';
    const read = await call(
      'GET',
      `/v1/payment_intents/${String(created.id)}?client_secret=${encodeURIComponent(String(created.client_secret))}`,
    );
    expect(read.json.status).toBe('requires_action');
    expect(await runRecipientKeySweep()).toMatchObject({ retired: 0, held: 1 });

    chain = 'unused';
    expect(await runRecipientKeySweep()).toMatchObject({ retired: 1, held: 0 });
    expect(must(await findIntentByPublicId(gatewayDb(), String(created.id)))).toMatchObject({
      status: 'canceled',
      cancellationReason: 'faircoin_network_closed',
    });
  });

  test('the sweep retires what no payer read saw, with no key read; a broadcast payment is left to settle', async () => {
    const open = await createApiIntent();
    const broadcast = await createApiIntent();
    const broadcastRow = must(await findIntentByPublicId(gatewayDb(), String(broadcast.id)));
    await reportFaircoinBroadcast(broadcastRow, 'a'.repeat(64));

    // While the gate is open nothing is retired.
    expect((await runRecipientKeySweep()).retired).toBe(0);

    gate('testnet');
    let keyReads = 0;
    const sweep = await runRecipientKeySweep({
      readKey: async (accountId) => {
        keyReads += 1;
        return Buffer.from(testIdentityPublicKey(accountId)).toString('hex');
      },
    });
    expect(sweep.retired).toBe(1);
    // Only the broadcast payment needed its key read.
    expect(keyReads).toBe(1);
    expect(must(await findIntentByPublicId(gatewayDb(), String(open.id)))).toMatchObject({
      status: 'canceled',
      cancellationReason: 'faircoin_network_closed',
    });
    expect(must(await findIntentByPublicId(gatewayDb(), String(broadcast.id))).status).toBe(
      'processing',
    );
  });
});
