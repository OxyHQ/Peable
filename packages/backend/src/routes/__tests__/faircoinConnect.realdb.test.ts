/**
 * FairCoin connected accounts end to end over HTTP (ADR 0012), against a real
 * database: a CARD-ONLY platform (Mercaria's shape) opens a seller, mints an
 * onboarding link, the SELLER registers their key in their own Oxy session, and
 * the platform takes FairCoin payments on the seller's behalf.
 *
 * What is defended here, beyond each step working:
 * - the platform never supplies, and never sees, the seller's key;
 * - only the Oxy user the account names can register it, once;
 * - the payer's address derives from the SELLER's key, on the seller's counter;
 * - the platform receives every event, tagged with the seller;
 * - none of it reaches the card provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { and, eq } from 'drizzle-orm';
import { getNetwork } from '@fairco.in/core';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { uuidv7 } from '@oxy.so/db';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  testXprvFor,
  testXpubFor,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { insertMerchant, type MerchantRow } from '../../db/merchants/merchantRepository';
import { connectedAccountLinks, connectedAccounts, webhookDeliveries } from '../../db/schema';
import { findAccountByPublicId } from '../../db/accounts/connectedAccountRepository';
import { createFaircoinAccountLink } from '../../services/accounts/faircoinOnboarding';
import { config } from '../../config';
import { deriveIntentAddress } from '../../services/derivation';
import { transitionIntent } from '../../services/intentTransition';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { createCheckoutSessionsRouter } from '../checkoutSessions';
import { createConnectRouter } from '../connect';
import { createConnectedAccountsRouter } from '../connectedAccounts';
import { createMerchantsRouter } from '../merchants';
import { createPaymentIntentsRouter } from '../paymentIntents';

const SELLER = 'user_seller_42';
const STRANGER = 'user_someone_else';

let server: Server | undefined;
let baseUrl = '';
let platform: MerchantRow;
let actingApp = '';
let actingEnvironment: OxyServiceEnvironment = 'development';

type Json = Record<string, unknown>;

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
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Json) : {} };
}

/** As the seller, in their own Oxy session. */
function asUser(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

function tokenOf(url: string): string {
  return must(url.split('/').pop());
}

async function seedCardOnlyPlatform(
  environment: OxyServiceEnvironment = 'development',
): Promise<MerchantRow> {
  const id = uuidv7();
  return must(
    await insertMerchant(gatewayDb(), {
      publicId: `merch_${id}`,
      oxyAppId: `app_${id}`,
      environment,
      webhookUrl: 'https://platform.example/peable',
      webhookSecret: 'whsec_platform',
    }),
  );
}

/** Open a FairCoin seller, mint a link, and have the seller register `xpub`. */
async function onboardSeller(externalRef: string, account: number): Promise<Json> {
  const created = await call('POST', '/v1/connected_accounts', {
    externalRef,
    faircoin: { network: 'testnet', oxyUserId: SELLER },
  });
  expect(created.status).toBe(201);
  const link = await call(
    'POST',
    `/v1/connected_accounts/${String(created.json.id)}/account_links`,
    {
      rail: 'faircoin',
      returnUrl: 'https://platform.example/sell/done',
      refreshUrl: 'https://platform.example/sell/refresh',
    },
  );
  expect(link.status).toBe(201);
  const registered = await call(
    'POST',
    `/v1/connect/onboarding/${tokenOf(String(link.json.url))}/faircoin`,
    { xpub: testXpubFor('testnet', account) },
    asUser(SELLER),
  );
  expect(registered.status).toBe(200);
  return created.json;
}

async function deliveriesFor(merchantId: string, eventType: string) {
  return gatewayDb()
    .select({ payload: webhookDeliveries.payload, intentId: webhookDeliveries.paymentIntentId })
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.merchantId, merchantId), eq(webhookDeliveries.eventType, eventType)),
    );
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('FairCoin connected accounts over HTTP', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    platform = await seedCardOnlyPlatform();
    actingApp = platform.oxyAppId;

    const stubMerchantAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: actingApp,
        appName: 'platform',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: 'acct_platform',
        environment: actingEnvironment,
        tier: 'external',
      };
      next();
    };
    const stubUserAuth: RequestHandler = (req, res, next) => {
      const userId = req.header('X-Test-User-Id');
      if (!userId) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      (req as OxyAuthRequest).userId = userId;
      next();
    };
    const passThrough: RequestHandler = (_req, _res, next) => {
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: stubMerchantAuth }));
    app.use(createConnectedAccountsRouter({ requireMerchant: stubMerchantAuth }));
    app.use(createConnectRouter({ requireOxyUser: stubUserAuth }));
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubMerchantAuth,
        optionalServiceAuth: stubMerchantAuth,
      }),
    );
    app.use(
      createCheckoutSessionsRouter({
        requireMerchant: stubMerchantAuth,
        publicRateLimit: passThrough,
      }),
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    actingApp = platform.oxyAppId;
    actingEnvironment = 'development';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        resolve();
      });
    });
  });

  // ── the platform ─────────────────────────────────────────────────────────

  test('a card-only platform reads back a null network and xpub', async () => {
    const { status, json } = await call('GET', '/v1/merchants/me');
    expect(status).toBe(200);
    expect(json.network).toBeNull();
    expect(json.xpub).toBeNull();
  });

  test('opens a FairCoin-only seller: no card half, no key, pending', async () => {
    const { status, json } = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_open',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    });
    expect(status).toBe(201);
    expect(json.rails).toEqual(['faircoin']);
    expect(json.country).toBeNull();
    expect(json.payable).toBe(false);
    expect(json.faircoin).toEqual({
      network: 'testnet',
      status: 'pending',
      oxyUserId: SELLER,
      registeredAt: null,
    });
  });

  test('converges on a repeat, and refuses one that changes the network or the seller', async () => {
    const body = {
      externalRef: 'store_repeat',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    };
    const first = await call('POST', '/v1/connected_accounts', body);
    const again = await call('POST', '/v1/connected_accounts', body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);

    const otherUser = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_repeat',
      faircoin: { network: 'testnet', oxyUserId: STRANGER },
    });
    expect(otherUser.status).toBe(409);
  });

  test('refuses a body that opens no rail, half a card, or carries a key', async () => {
    expect((await call('POST', '/v1/connected_accounts', { externalRef: 'x1' })).status).toBe(422);
    expect(
      (await call('POST', '/v1/connected_accounts', { externalRef: 'x2', country: 'ES' })).status,
    ).toBe(422);
    // The platform can NEVER supply the seller's key (ADR 0012 D3).
    const withKey = await call('POST', '/v1/connected_accounts', {
      externalRef: 'x3',
      faircoin: { network: 'testnet', oxyUserId: SELLER, xpub: testXpubFor('testnet', 20) },
    });
    expect(withKey.status).toBe(422);
  });

  test('a non-production platform cannot open a mainnet seller', async () => {
    const { status } = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_mainnet',
      faircoin: { network: 'mainnet', oxyUserId: SELLER },
    });
    expect(status).toBe(422);
  });

  test('a production platform opens a mainnet seller without touching the card key mode', async () => {
    const prod = await seedCardOnlyPlatform('production');
    actingApp = prod.oxyAppId;
    actingEnvironment = 'production';
    const { status, json } = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_prod',
      faircoin: { network: 'mainnet', oxyUserId: SELLER },
    });
    // The deployment's card key is test mode; a FairCoin-only seller never
    // reaches the provider, so the key-mode guard does not apply.
    expect(status).toBe(201);
    expect((json.faircoin as Json).network).toBe('mainnet');
  });

  test('a card onboarding link for a FairCoin-only seller is a 409', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_cardlink',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    });
    const link = await call(
      'POST',
      `/v1/connected_accounts/${String(created.json.id)}/account_links`,
      {
        returnUrl: 'https://platform.example/r',
        refreshUrl: 'https://platform.example/f',
      },
    );
    expect(link.status).toBe(409);
  });

  // ── the seller ──────────────────────────────────────────────────────────

  test('onboards a seller in their own Oxy session, once', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_onboard',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    });
    const accountId = String(created.json.id);
    const link = await call('POST', `/v1/connected_accounts/${accountId}/account_links`, {
      rail: 'faircoin',
      returnUrl: 'https://platform.example/sell/done',
      refreshUrl: 'https://platform.example/sell/refresh',
    });
    expect(link.status).toBe(201);
    expect(String(link.json.url).startsWith(`${config.connectOnboardingBaseUrl}/`)).toBe(true);
    const token = tokenOf(String(link.json.url));

    // No session at all: the token alone opens nothing.
    expect((await call('GET', `/v1/connect/onboarding/${token}`)).status).toBe(401);
    // Someone else's session: refused, and the link is NOT used up.
    const stranger = await call(
      'GET',
      `/v1/connect/onboarding/${token}`,
      undefined,
      asUser(STRANGER),
    );
    expect(stranger.status).toBe(403);
    expect((stranger.json.error as Json).code).toBe('wrong_seller');
    const strangerPost = await call(
      'POST',
      `/v1/connect/onboarding/${token}/faircoin`,
      { xpub: testXpubFor('testnet', 30) },
      asUser(STRANGER),
    );
    expect(strangerPost.status).toBe(403);

    const described = await call(
      'GET',
      `/v1/connect/onboarding/${token}`,
      undefined,
      asUser(SELLER),
    );
    expect(described.status).toBe(200);
    expect(described.json.accountId).toBe(accountId);
    expect(described.json.network).toBe('testnet');
    expect(described.json.returnUrl).toBe('https://platform.example/sell/done');
    expect(typeof (described.json.platform as Json).name).toBe('string');

    // A private key is refused and nothing is stored or consumed.
    const xprv = await call(
      'POST',
      `/v1/connect/onboarding/${token}/faircoin`,
      { xpub: testXprvFor('testnet', 31) },
      asUser(SELLER),
    );
    expect(xprv.status).toBe(422);
    expect((xprv.json.error as Json).code).toBe('watch_only_violation');

    const key = testXpubFor('testnet', 32);
    const done = await call(
      'POST',
      `/v1/connect/onboarding/${token}/faircoin`,
      { xpub: key },
      asUser(SELLER),
    );
    expect(done.status).toBe(200);
    expect(done.json).toEqual({
      object: 'connect_onboarding',
      accountId,
      status: 'active',
      returnUrl: 'https://platform.example/sell/done',
    });

    // Single-use: the same link is now gone, with the platform's refresh URL.
    const replay = await call(
      'POST',
      `/v1/connect/onboarding/${token}/faircoin`,
      { xpub: testXpubFor('testnet', 33) },
      asUser(SELLER),
    );
    expect(replay.status).toBe(410);
    expect((replay.json.error as Json).refreshUrl).toBe('https://platform.example/sell/refresh');

    // The platform sees the seller active — and never the key.
    const read = await call('GET', `/v1/connected_accounts/${accountId}`);
    expect((read.json.faircoin as Json).status).toBe('active');
    expect(JSON.stringify(read.json)).not.toContain(key);
    const listed = await call('GET', '/v1/connected_accounts');
    expect(JSON.stringify(listed.json)).not.toContain(key);

    // ...and was told, in one transaction with the key, with the seller named.
    const events = await deliveriesFor(platform.id, 'connected_account.updated');
    const event = must(
      events.find((row) => (row.payload.account as string | undefined) === accountId),
    );
    expect(event.intentId).toBeNull();
    expect(((event.payload.data as Json).object as Json).faircoin).toMatchObject({
      status: 'active',
    });

    // A fresh link for an active seller has nothing to onboard.
    const again = await call('POST', `/v1/connected_accounts/${accountId}/account_links`, {
      rail: 'faircoin',
      returnUrl: 'https://platform.example/r',
      refreshUrl: 'https://platform.example/f',
    });
    expect(again.status).toBe(409);
  });

  test('stores only the hash of a token, and an unknown token is a 404', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_hash',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    });
    const link = await call(
      'POST',
      `/v1/connected_accounts/${String(created.json.id)}/account_links`,
      {
        rail: 'faircoin',
        returnUrl: 'https://platform.example/r',
        refreshUrl: 'https://platform.example/f',
      },
    );
    const token = tokenOf(String(link.json.url));
    const stored = await gatewayDb()
      .select({ tokenHash: connectedAccountLinks.tokenHash })
      .from(connectedAccountLinks)
      .innerJoin(
        connectedAccounts,
        eq(connectedAccounts.id, connectedAccountLinks.connectedAccountId),
      )
      .where(eq(connectedAccounts.publicId, String(created.json.id)));
    expect(stored).toEqual([{ tokenHash: createHash('sha256').update(token).digest('hex') }]);
    expect(JSON.stringify(stored)).not.toContain(token);

    const res = await call(
      'GET',
      '/v1/connect/onboarding/not-a-real-token',
      undefined,
      asUser(SELLER),
    );
    expect(res.status).toBe(404);
  });

  test('an expired link answers 410 with where to get a fresh one', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_expired',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    });
    const account = must(
      await findAccountByPublicId(gatewayDb(), platform.id, String(created.json.id)),
    );
    // Minted an hour and a minute ago — past its 60-minute life.
    const { url } = await createFaircoinAccountLink({
      account,
      returnUrl: 'https://platform.example/r',
      refreshUrl: 'https://platform.example/refresh-me',
      now: new Date(Date.now() - 61 * 60 * 1000),
    });
    const res = await call(
      'GET',
      `/v1/connect/onboarding/${tokenOf(url)}`,
      undefined,
      asUser(SELLER),
    );
    expect(res.status).toBe(410);
    expect((res.json.error as Json).refreshUrl).toBe('https://platform.example/refresh-me');
  });

  // ── payments on behalf ──────────────────────────────────────────────────

  test('refuses a payment for a seller who has not registered yet', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      externalRef: 'store_pending_pay',
      faircoin: { network: 'testnet', oxyUserId: SELLER },
    });
    const res = await call(
      'POST',
      '/v1/payment_intents',
      {
        amount: '100000000',
        rail: 'faircoin',
        network: 'testnet',
        connectedAccount: created.json.id,
      },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(res.status).toBe(409);
    expect((res.json.error as Json).code).toBe('account_not_ready');
  });

  test("derives the payer's address from the SELLER's key, on the seller's counter", async () => {
    const seller = await onboardSeller('store_pay', 40);
    const key = testXpubFor('testnet', 40);
    const network = getNetwork('testnet');

    const first = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '250000000', rail: 'faircoin', network: 'testnet', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(first.status).toBe(201);
    expect(first.json.address).toBe(deriveIntentAddress(key, 0, 0, network));
    expect(first.json.connectedAccountId).toBe(seller.id);
    expect(first.json.network).toBe('testnet');
    expect(first.json.canExpire).toBe(true);

    // `rail` omitted: still FairCoin, and the next index on the SAME key.
    const second = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1', network: 'testnet', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(second.status).toBe(201);
    expect(second.json.rail).toBe('faircoin');
    expect(second.json.address).toBe(deriveIntentAddress(key, 0, 1, network));

    // Only this seller's payments, when the platform asks for them.
    const listed = await call('GET', `/v1/payment_intents?connected_account=${String(seller.id)}`);
    const ids = (listed.json.data as Json[]).map((intent) => intent.id);
    expect(ids.sort()).toEqual([first.json.id, second.json.id].sort());
  });

  test('refuses an on-behalf CARD payment, a wrong network, and a foreign seller', async () => {
    const seller = await onboardSeller('store_refusals', 41);
    const card = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1000', rail: 'card', currency: 'EUR', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(card.status).toBe(422);

    const wrongNetwork = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1000', network: 'mainnet', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(wrongNetwork.status).toBe(422);

    // Another platform's seller is indistinguishable from no seller at all.
    const other = await seedMerchant();
    actingApp = other.oxyAppId;
    const foreign = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1000', network: 'testnet', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(foreign.status).toBe(404);
  });

  test('an Idempotency-Key replayed for another seller is a 409, never their payment', async () => {
    const a = await onboardSeller('store_idem_a', 42);
    const b = await onboardSeller('store_idem_b', 43);
    const key = `idem_${uuidv7()}`;
    const first = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connectedAccount: a.id },
      { 'Idempotency-Key': key },
    );
    expect(first.status).toBe(201);
    const replay = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connectedAccount: a.id },
      { 'Idempotency-Key': key },
    );
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(first.json.id);
    const other = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connectedAccount: b.id },
      { 'Idempotency-Key': key },
    );
    expect(other.status).toBe(409);
  });

  test('opens a hosted checkout on behalf of a seller', async () => {
    const seller = await onboardSeller('store_checkout', 44);
    const res = await call('POST', '/v1/checkout_sessions', {
      amount: '300000000',
      rail: 'faircoin',
      network: 'testnet',
      connectedAccount: seller.id,
      successUrl: 'https://platform.example/ok',
    });
    expect(res.status).toBe(201);
    expect(res.json.connectedAccountId).toBe(seller.id);
    expect(res.json.network).toBe('testnet');
    const intent = must(await findIntentByPublicId(gatewayDb(), String(res.json.paymentIntentId)));
    expect(intent.address).toBe(
      deriveIntentAddress(testXpubFor('testnet', 44), 0, 0, getNetwork('testnet')),
    );
  });

  test("delivers the payment's events to the PLATFORM, tagged with the seller", async () => {
    const seller = await onboardSeller('store_events', 45);
    const created = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '7000', network: 'testnet', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    const intent = must(await findIntentByPublicId(gatewayDb(), String(created.json.id)));
    const result = await transitionIntent(intent.id, { from: 'created', status: 'expired' });
    expect(result.kind).toBe('updated');

    const events = await deliveriesFor(platform.id, 'payment_intent.expired');
    const event = must(events.find((row) => row.intentId === intent.id));
    expect(event.payload.account).toBe(seller.id);
    const object = (event.payload.data as Json).object as Json;
    expect(object.connectedAccountId).toBe(seller.id);
    expect(object.canExpire).toBe(false);
  });

  test('a broadcast payment can no longer expire, and says so', async () => {
    const seller = await onboardSeller('store_broadcast', 46);
    const created = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '7000', network: 'testnet', connectedAccount: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    const intent = must(await findIntentByPublicId(gatewayDb(), String(created.json.id)));
    await transitionIntent(intent.id, {
      from: 'created',
      status: 'broadcast',
      txid: 'a'.repeat(64),
    });
    const read = await call('GET', `/v1/payment_intents/${String(created.json.id)}`);
    expect(read.json.status).toBe('broadcast');
    expect(read.json.canExpire).toBe(false);
  });

  test("the seller's key is stored once and never on the platform's own merchant row", async () => {
    const seller = await onboardSeller('store_row', 47);
    const [row] = await gatewayDb()
      .select({ xpub: connectedAccounts.xpub, next: connectedAccounts.nextDerivationIndex })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.publicId, String(seller.id)));
    expect(row?.xpub).toBe(testXpubFor('testnet', 47));
    expect(row?.next).toBe(0);
    const me = await call('GET', '/v1/merchants/me');
    expect(me.json.xpub).toBeNull();
  });
});
