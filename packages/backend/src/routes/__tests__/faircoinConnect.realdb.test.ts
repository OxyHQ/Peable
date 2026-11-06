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
import { eq } from 'drizzle-orm';
import { deriveSocialReceiveAddress, getNetwork } from '@fairco.in/core';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { uuidv7 } from '@oxy.so/db';
import type { WebhookEventType } from '@peable.to/shared-types';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  seedWebhookEndpoint,
  storedEvents,
  testXpubFor,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { insertMerchant, type MerchantRow } from '../../db/merchants/merchantRepository';
import {
  balanceTransactions,
  connectedAccountLinks,
  connectedAccounts,
  idempotencyKeys,
} from '../../db/schema';
import { findAccountByPublicId } from '../../db/accounts/connectedAccountRepository';
import { createFaircoinAccountLink } from '../../services/accounts/faircoinOnboarding';
import { config } from '../../config';
import { testIdentityPublicKey } from '../../__tests__/setup/identityKeys';
import { transitionIntent } from '../../services/intentTransition';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { reportFaircoinBroadcast } from '../../services/faircoinBroadcast';
import { createCheckoutSessionsRouter } from '../checkoutSessions';
import { sendError } from '../../lib/http';
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
  const merchant = must(
    await insertMerchant(gatewayDb(), {
      publicId: `merch_${id}`,
      oxyAppId: `app_${id}`,
      environment,
    }),
  );
  await seedWebhookEndpoint(merchant, { url: 'https://platform.example/peable' });
  return merchant;
}

/** The Oxy account of seller number `n`: its own Peable wallet (a deterministic test key). */
function sellerUser(n: number): string {
  return `user_seller_${String(n)}`;
}

/** The `index`th address of seller `n`'s own Peable wallet (ADR 0021 D5, ADR 0002). */
function sellerAddress(n: number, index: number): string {
  return deriveSocialReceiveAddress(
    testIdentityPublicKey(sellerUser(n)),
    index,
    getNetwork('testnet'),
  );
}

/** Open a FairCoin seller, mint a link, and have the seller confirm from their own session. */
async function onboardSeller(externalRef: string, account: number): Promise<Json> {
  const created = await call('POST', '/v1/connected_accounts', {
    external_ref: externalRef,
    faircoin: { network: 'testnet', oxy_user_id: sellerUser(account) },
  });
  expect(created.status).toBe(201);
  const link = await call(
    'POST',
    `/v1/connected_accounts/${String(created.json.id)}/account_links`,
    {
      rail: 'faircoin',
      return_url: 'https://platform.example/sell/done',
      refresh_url: 'https://platform.example/sell/refresh',
    },
  );
  expect(link.status).toBe(201);
  const registered = await call(
    'POST',
    `/v1/connect/onboarding/${tokenOf(String(link.json.url))}/faircoin`,
    {},
    asUser(sellerUser(account)),
  );
  expect(registered.status).toBe(200);
  return created.json;
}

/** The merchant's stored events of one type, rendered as their deliveries carry them. */
async function deliveriesFor(merchantId: string, eventType: WebhookEventType) {
  return (await storedEvents({ merchantId, type: eventType })).map(({ row, event }) => ({
    payload: event as unknown as Json,
    intentId: row.paymentIntentId,
  }));
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
        // The error envelope every route answers with (ADR 0014 D1).
        sendError(res, 401, 'authentication_error', 'sign in as the seller');
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

  test('a platform holds no key: its network is its environment’s (ADR 0021 D5)', async () => {
    const { status, json } = await call('GET', '/v1/merchants/me');
    expect(status).toBe(200);
    expect(json.network).toBe('testnet');
    expect('xpub' in json).toBe(false);
  });

  test('opens a FairCoin-only seller: no card half, no key, pending', async () => {
    const { status, json } = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_open',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
    });
    expect(status).toBe(201);
    expect(json.rails).toEqual(['faircoin']);
    expect(json.country).toBeNull();
    expect(json.payable).toBe(false);
    expect(json.faircoin).toEqual({
      network: 'testnet',
      status: 'pending',
      oxy_user_id: SELLER,
      registered_at: null,
    });
  });

  test('converges on a repeat, and refuses one that changes the network or the seller', async () => {
    const body = {
      external_ref: 'store_repeat',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
    };
    const first = await call('POST', '/v1/connected_accounts', body);
    const again = await call('POST', '/v1/connected_accounts', body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(first.json.id);

    const otherUser = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_repeat',
      faircoin: { network: 'testnet', oxy_user_id: STRANGER },
    });
    expect(otherUser.status).toBe(409);
  });

  test('refuses a body that opens no rail, half a card, or carries a key', async () => {
    expect((await call('POST', '/v1/connected_accounts', { external_ref: 'x1' })).status).toBe(400);
    expect(
      (await call('POST', '/v1/connected_accounts', { external_ref: 'x2', country: 'ES' })).status,
    ).toBe(400);
    // The platform can NEVER supply the seller's key (ADR 0012 D3).
    const withKey = await call('POST', '/v1/connected_accounts', {
      external_ref: 'x3',
      faircoin: { network: 'testnet', oxy_user_id: SELLER, xpub: testXpubFor('testnet', 20) },
    });
    expect(withKey.status).toBe(400);
  });

  test('a non-production platform cannot open a mainnet seller', async () => {
    const { status } = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_mainnet',
      faircoin: { network: 'mainnet', oxy_user_id: SELLER },
    });
    expect(status).toBe(400);
  });

  test('a production platform opens a mainnet seller without touching the card key mode', async () => {
    const prod = await seedCardOnlyPlatform('production');
    actingApp = prod.oxyAppId;
    actingEnvironment = 'production';
    const { status, json } = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_prod',
      faircoin: { network: 'mainnet', oxy_user_id: SELLER },
    });
    // The deployment's card key is test mode; a FairCoin-only seller never
    // reaches the provider, so the key-mode guard does not apply.
    expect(status).toBe(201);
    expect((json.faircoin as Json).network).toBe('mainnet');
  });

  test('a card onboarding link for a FairCoin-only seller is a 409', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_cardlink',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
    });
    const link = await call(
      'POST',
      `/v1/connected_accounts/${String(created.json.id)}/account_links`,
      {
        return_url: 'https://platform.example/r',
        refresh_url: 'https://platform.example/f',
      },
    );
    expect(link.status).toBe(409);
  });

  // ── the seller ──────────────────────────────────────────────────────────

  test('onboards a seller in their own Oxy session, once', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_onboard',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
    });
    const accountId = String(created.json.id);
    const link = await call('POST', `/v1/connected_accounts/${accountId}/account_links`, {
      rail: 'faircoin',
      return_url: 'https://platform.example/sell/done',
      refresh_url: 'https://platform.example/sell/refresh',
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
      {},
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
    expect(described.json.account_id).toBe(accountId);
    expect(described.json.network).toBe('testnet');
    expect(described.json.return_url).toBe('https://platform.example/sell/done');
    expect(typeof (described.json.platform as Json).name).toBe('string');

    const done = await call('POST', `/v1/connect/onboarding/${token}/faircoin`, {}, asUser(SELLER));
    expect(done.status).toBe(200);
    expect(done.json).toEqual({
      object: 'connect_onboarding',
      account_id: accountId,
      status: 'active',
      return_url: 'https://platform.example/sell/done',
    });

    // Single-use: the same link is now gone, with the platform's refresh URL.
    const replay = await call(
      'POST',
      `/v1/connect/onboarding/${token}/faircoin`,
      {},
      asUser(SELLER),
    );
    expect(replay.status).toBe(410);
    expect((replay.json.error as Json).refresh_url).toBe('https://platform.example/sell/refresh');

    // The platform sees the seller active.
    const read = await call('GET', `/v1/connected_accounts/${accountId}`);
    expect((read.json.faircoin as Json).status).toBe('active');

    // ...and was told, in one transaction with the confirmation, the seller named.
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
      return_url: 'https://platform.example/r',
      refresh_url: 'https://platform.example/f',
    });
    expect(again.status).toBe(409);
  });

  test('stores only the hash of a token, and an unknown token is a 404', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_hash',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
    });
    const link = await call(
      'POST',
      `/v1/connected_accounts/${String(created.json.id)}/account_links`,
      {
        rail: 'faircoin',
        return_url: 'https://platform.example/r',
        refresh_url: 'https://platform.example/f',
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
      external_ref: 'store_expired',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
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
    expect((res.json.error as Json).refresh_url).toBe('https://platform.example/refresh-me');
  });

  // ── payments on behalf ──────────────────────────────────────────────────

  test('refuses a payment for a seller who has not registered yet', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_pending_pay',
      faircoin: { network: 'testnet', oxy_user_id: SELLER },
    });
    const res = await call(
      'POST',
      '/v1/payment_intents',
      {
        amount: '100000000',
        rail: 'faircoin',
        network: 'testnet',
        connected_account: created.json.id,
      },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(res.status).toBe(409);
    expect((res.json.error as Json).code).toBe('account_not_ready');
  });

  test("pays the SELLER's own Peable wallet, on the seller's cursor", async () => {
    const seller = await onboardSeller('store_pay', 40);

    const first = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '250000000', rail: 'faircoin', network: 'testnet', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(first.status).toBe(201);
    expect((first.json.faircoin as Json).address).toBe(sellerAddress(40, 1));
    expect(first.json.connected_account).toBe(seller.id);
    expect((first.json.faircoin as Json).network).toBe('testnet');
    expect(first.json.can_expire).toBe(true);

    // `rail` omitted: still FairCoin, and the next address of the SAME wallet.
    const second = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1', network: 'testnet', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(second.status).toBe(201);
    expect(second.json.rail).toBe('faircoin');
    expect((second.json.faircoin as Json).address).toBe(sellerAddress(40, 2));

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
      { amount: '1000', rail: 'card', currency: 'EUR', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(card.status).toBe(400);

    const wrongNetwork = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1000', network: 'mainnet', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(wrongNetwork.status).toBe(400);

    // Another platform's seller is indistinguishable from no seller at all.
    const other = await seedMerchant();
    actingApp = other.oxyAppId;
    const foreign = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '1000', network: 'testnet', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    expect(foreign.status).toBe(404);
  });

  test('an Idempotency-Key replayed for another seller is refused, never their payment', async () => {
    const a = await onboardSeller('store_idem_a', 42);
    const b = await onboardSeller('store_idem_b', 43);
    const key = `idem_${uuidv7()}`;
    const first = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connected_account: a.id },
      { 'Idempotency-Key': key },
    );
    expect(first.status).toBe(201);
    const replay = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connected_account: a.id },
      { 'Idempotency-Key': key },
    );
    expect(replay.status).toBe(201);
    expect(replay.json.id).toBe(first.json.id);
    const other = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connected_account: b.id },
      { 'Idempotency-Key': key },
    );
    expect(other.status).toBe(400);
    expect((other.json.error as Record<string, string>).code).toBe('idempotency_error');

    // The business layer refuses it too, once the generic one has forgotten
    // the key: the intent's own key names seller A's payment.
    await gatewayDb().delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    const afterExpiry = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '5000', network: 'testnet', connected_account: b.id },
      { 'Idempotency-Key': key },
    );
    expect(afterExpiry.status).toBe(400);
    expect((afterExpiry.json.error as Record<string, string>).code).toBe('idempotency_error');
    expect(String((afterExpiry.json.error as Record<string, string>).message)).toContain(
      String(a.id),
    );
  });

  test('opens a hosted checkout on behalf of a seller', async () => {
    const seller = await onboardSeller('store_checkout', 44);
    const res = await call('POST', '/v1/checkout_sessions', {
      line_items: [
        {
          price_data: {
            currency: 'FAIR',
            unit_amount: '300000000',
            product_data: { name: 'Plant' },
          },
          quantity: 1,
        },
      ],
      connected_account: seller.id,
      success_url: 'https://platform.example/ok',
    });
    expect(res.status).toBe(201);
    expect(res.json.connected_account).toBe(seller.id);
    expect(res.json.success_url).toBe('https://platform.example/ok');
    expect(res.json.network).toBe('testnet');
    // The payer confirms: the payment's address derives from the SELLER's key.
    const secret = {
      'X-Peable-Client-Secret': decodeURIComponent(String(res.json.url).split('#cs=')[1] ?? ''),
    };
    await call(
      'POST',
      `/v1/checkout_sessions/${res.json.id}/public`,
      { customer_details: { email: 'b@example.com' } },
      secret,
    );
    const confirmed = await call(
      'POST',
      `/v1/checkout_sessions/${res.json.id}/public/confirm`,
      {},
      secret,
    );
    expect(confirmed.status).toBe(200);
    const pi = (confirmed.json.payment_intent as { id: string }).id;
    const intent = must(await findIntentByPublicId(gatewayDb(), pi));
    expect(intent.address).toBe(sellerAddress(44, 1));
  });

  test("a FIAT order on behalf of a seller: FairCoin pays the seller's key, quoted (ADR 0021 D5)", async () => {
    const seller = await onboardSeller('store_fiat_checkout', 60);
    const res = await call('POST', '/v1/checkout_sessions', {
      line_items: [
        {
          price_data: { currency: 'USD', unit_amount: '1000', product_data: { name: 'Lamp' } },
          quantity: 1,
        },
      ],
      connected_account: seller.id,
      customer_email: 'b@example.com',
      success_url: 'https://platform.example/ok',
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      rail: 'card',
      network: 'testnet',
      connected_account: seller.id,
      payment_method_types: ['card', 'faircoin'],
    });
    const secret = {
      'X-Peable-Client-Secret': decodeURIComponent(String(res.json.url).split('#cs=')[1] ?? ''),
    };
    const confirmed = await call(
      'POST',
      `/v1/checkout_sessions/${String(res.json.id)}/public/confirm`,
      { payment_method_type: 'faircoin' },
      secret,
    );
    expect(confirmed.status).toBe(200);
    const pi = (confirmed.json.payment_intent as { id: string }).id;
    const intent = must(await findIntentByPublicId(gatewayDb(), pi));
    // 10.00 USD at the test price of 0.5 USD/FAIR: 20 FAIR, to the SELLER's key.
    expect(intent).toMatchObject({ rail: 'faircoin', currency: 'FAIR', amount: '2000000000' });
    expect(intent.connectedAccountPublicId).toBe(String(seller.id));
    expect(intent.address).toBe(sellerAddress(60, 1));
    expect(intent.faircoinQuote).toMatchObject({ currency: 'USD', amount: '1000', rate: '0.5' });
  });

  test('a FairCoin-only USD order for a seller: the card is off, FairCoin pays the seller (ADR 0021 D1)', async () => {
    const seller = await onboardSeller('store_fair_only', 61);
    const res = await call('POST', '/v1/checkout_sessions', {
      line_items: [
        {
          price_data: { currency: 'USD', unit_amount: '1000', product_data: { name: 'Mug' } },
          quantity: 1,
        },
      ],
      connected_account: seller.id,
      payment_method_types: ['faircoin'],
      customer_email: 'b@example.com',
      success_url: 'https://platform.example/ok',
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ currency: 'USD', payment_method_types: ['faircoin'] });
    const secret = {
      'X-Peable-Client-Secret': decodeURIComponent(String(res.json.url).split('#cs=')[1] ?? ''),
    };
    const publicView = await call(
      'GET',
      `/v1/checkout_sessions/${String(res.json.id)}/public`,
      undefined,
      secret,
    );
    expect(publicView.json).toMatchObject({
      payment_method_types: ['faircoin'],
      publishable_key: null,
    });
    const byCard = await call(
      'POST',
      `/v1/checkout_sessions/${String(res.json.id)}/public/confirm`,
      { payment_method_type: 'card' },
      secret,
    );
    expect(byCard.status).toBe(400);
    // No choice named: a FairCoin-only order confirms in FairCoin.
    const confirmed = await call(
      'POST',
      `/v1/checkout_sessions/${String(res.json.id)}/public/confirm`,
      {},
      secret,
    );
    expect(confirmed.status).toBe(200);
    const intent = must(
      await findIntentByPublicId(gatewayDb(), (confirmed.json.payment_intent as { id: string }).id),
    );
    expect(intent).toMatchObject({ rail: 'faircoin', amount: '2000000000' });
    expect(intent.address).toBe(sellerAddress(61, 1));
    expect(intent.faircoinQuote).toMatchObject({ currency: 'USD', amount: '1000' });
  });

  test('a FAIR order cannot offer the card, and FairCoin cannot be left out', async () => {
    const seller = await onboardSeller('store_fair_rules', 62);
    const lines = (currency: string, amount: string) => [
      { price_data: { currency, unit_amount: amount, product_data: { name: 'X' } }, quantity: 1 },
    ];
    const cardOnFair = await call('POST', '/v1/checkout_sessions', {
      line_items: lines('FAIR', '100000000'),
      connected_account: seller.id,
      payment_method_types: ['card', 'faircoin'],
      success_url: 'https://platform.example/ok',
    });
    expect(cardOnFair.status).toBe(400);
    const noFaircoin = await call('POST', '/v1/checkout_sessions', {
      line_items: lines('USD', '1000'),
      payment_method_types: ['card'],
      success_url: 'https://platform.example/ok',
    });
    expect(noFaircoin.status).toBe(400);
    expect((noFaircoin.json.error as Json).code).toBe('payment_method_locked');
  });

  test("delivers the payment's events to the PLATFORM, tagged with the seller", async () => {
    const seller = await onboardSeller('store_events', 45);
    const created = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '7000', network: 'testnet', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    const intent = must(await findIntentByPublicId(gatewayDb(), String(created.json.id)));
    const result = await transitionIntent(intent.id, {
      from: 'requires_action',
      status: 'canceled',
      cancellationReason: 'abandoned',
    });
    expect(result.kind).toBe('updated');

    const events = await deliveriesFor(platform.id, 'payment_intent.canceled');
    const event = must(events.find((row) => row.intentId === intent.id));
    expect(event.payload.account).toBe(seller.id);
    const object = (event.payload.data as Json).object as Json;
    expect(object.connected_account).toBe(seller.id);
    expect(object.can_expire).toBe(false);
  });

  test('a broadcast payment can no longer expire, and says so', async () => {
    const seller = await onboardSeller('store_broadcast', 46);
    const created = await call(
      'POST',
      '/v1/payment_intents',
      { amount: '7000', network: 'testnet', connected_account: seller.id },
      { 'Idempotency-Key': `idem_${uuidv7()}` },
    );
    const intent = must(await findIntentByPublicId(gatewayDb(), String(created.json.id)));
    await transitionIntent(intent.id, {
      from: 'requires_action',
      status: 'processing',
      txid: 'a'.repeat(64),
    });
    const read = await call('GET', `/v1/payment_intents/${String(created.json.id)}`);
    expect(read.json.status).toBe('processing');
    expect(read.json.can_expire).toBe(false);
  });

  test('the seller confirms into their own wallet; no key is stored anywhere', async () => {
    const seller = await onboardSeller('store_row', 47);
    const [row] = await gatewayDb()
      .select({ confirmed: connectedAccounts.faircoinRegisteredAt })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.publicId, String(seller.id)));
    expect(row?.confirmed).toBeInstanceOf(Date);
    expect((await call('GET', `/v1/connected_accounts/${String(seller.id)}`)).json).toMatchObject({
      faircoin: { status: 'active', oxy_user_id: sellerUser(47) },
    });
  });

  test('a seller whose account has no Peable wallet cannot confirm yet (409)', async () => {
    const created = await call('POST', '/v1/connected_accounts', {
      external_ref: 'store_keyless',
      faircoin: { network: 'testnet', oxy_user_id: 'keyless_seller' },
    });
    const link = await call(
      'POST',
      `/v1/connected_accounts/${String(created.json.id)}/account_links`,
      {
        rail: 'faircoin',
        return_url: 'https://platform.example/sell/done',
        refresh_url: 'https://platform.example/sell/refresh',
      },
    );
    const refused = await call(
      'POST',
      `/v1/connect/onboarding/${tokenOf(String(link.json.url))}/faircoin`,
      {},
      asUser('keyless_seller'),
    );
    expect(refused.status).toBe(409);
    expect((refused.json.error as Json).code).toBe('faircoin_wallet_missing');
  });

  describe('a multi-seller order (ADR 0021 D6)', () => {
    const usd = (unit: string, name: string, seller?: unknown) => ({
      price_data: { currency: 'USD', unit_amount: unit, product_data: { name } },
      quantity: 1,
      ...(seller ? { connected_account: seller } : {}),
    });
    const secretOf = (session: Json) => ({
      'X-Peable-Client-Secret': decodeURIComponent(String(session.url).split('#cs=')[1] ?? ''),
    });
    const platformAddress = (index: number) =>
      deriveSocialReceiveAddress(testIdentityPublicKey('acct_platform'), index, getNetwork('testnet'));

    async function multiSellerOrder(a: number, b: number) {
      const sellerA = await onboardSeller(`store_split_a_${String(a)}`, a);
      const sellerB = await onboardSeller(`store_split_b_${String(b)}`, b);
      const res = await call('POST', '/v1/checkout_sessions', {
        // Seller A sells 30.00 + 10.00, seller B 10.00: weights 4:1.
        line_items: [usd('3000', 'Lamp', sellerA.id), usd('1000', 'Mug', sellerB.id), usd('1000', 'Shade', sellerA.id)],
        payment_intent_data: { metadata: { mercaria_payment_id: `pay_${String(a)}` } },
        customer_email: 'b@example.com',
        success_url: 'https://platform.example/ok',
      });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ connected_account: null, payment_method_types: ['card', 'faircoin'] });
      return { sellerA, sellerB, session: res.json };
    }

    test('ONE FairCoin payment pays every seller its share, from its own wallet tree', async () => {
      const { sellerA, sellerB, session } = await multiSellerOrder(80, 81);
      const view = await call('GET', `/v1/checkout_sessions/${String(session.id)}/public`, undefined, secretOf(session));
      expect(view.json.faircoin).toMatchObject({ available: true, unavailable_reason: null });

      const confirmed = await call(
        'POST',
        `/v1/checkout_sessions/${String(session.id)}/public/confirm`,
        { payment_method_type: 'faircoin' },
        secretOf(session),
      );
      expect(confirmed.status).toBe(200);
      const wire = confirmed.json.payment_intent as Json;
      // 50.00 USD at 0.5 USD/FAIR: 100 FAIR, split 4:1 by subtotal.
      expect(wire).toMatchObject({
        rail: 'faircoin',
        amount: '10000000000',
        connected_account: null,
        metadata: { mercaria_payment_id: 'pay_80' },
      });
      const outputs = [
        { address: sellerAddress(80, 1), amount: '8000000000' },
        { address: sellerAddress(81, 1), amount: '2000000000' },
      ];
      expect(wire.next_action).toEqual({
        type: 'faircoin_payment',
        faircoin_payment: {
          address: null,
          network: 'testnet',
          amount: '10000000000',
          currency: 'FAIR',
          uri: null,
          outputs,
        },
      });
      expect((wire.faircoin as Json).address).toBeNull();
      expect((wire.faircoin as Json).outputs).toEqual([
        { ...outputs[0], connected_account: sellerA.id },
        { ...outputs[1], connected_account: sellerB.id },
      ]);

      // The payer broadcasts; the watcher verifies EVERY output.
      const row = must(await findIntentByPublicId(gatewayDb(), String(wire.id)));
      const txid = 'c'.repeat(64);
      expect((await reportFaircoinBroadcast(row, txid)).kind).toBe('updated');
      const { SettlementWatcher } = await import('../../services/settlementWatcher');
      const changed: string[] = [];
      const watcher = new SettlementWatcher({
        getTransaction: async (id) =>
          id === txid
            ? {
                txid,
                confirmations: 99,
                outputs: [
                  { address: outputs[0].address, valueSat: 8_000_000_000n },
                  { address: outputs[1].address, valueSat: 2_000_000_000n },
                  { address: 'TChangeChangeChange', valueSat: 1n },
                ],
              }
            : null,
        onChange: (intent) => {
          changed.push(intent.publicId);
        },
      });
      await watcher.check();
      expect(changed).toContain(String(wire.id));
      const settled = must(await findIntentByPublicId(gatewayDb(), String(wire.id)));
      expect(settled.status).toBe('succeeded');

      // The informational ledger: one entry per seller, never the platform's.
      const entries = await gatewayDb()
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.paymentIntentId, settled.id));
      expect(
        entries
          .map((entry) => [entry.connectedAccountId, entry.amount, entry.fee])
          .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
      ).toEqual([
        [must(await findAccountByPublicId(gatewayDb(), platform.id, String(sellerB.id))).id, '2000000000', '0'],
        [must(await findAccountByPublicId(gatewayDb(), platform.id, String(sellerA.id))).id, '8000000000', '0'],
      ]);
    });

    test('one output short cancels the whole payment as underpaid', async () => {
      const { session } = await multiSellerOrder(82, 83);
      const confirmed = await call(
        'POST',
        `/v1/checkout_sessions/${String(session.id)}/public/confirm`,
        { payment_method_type: 'faircoin' },
        secretOf(session),
      );
      const id = String((confirmed.json.payment_intent as Json).id);
      const row = must(await findIntentByPublicId(gatewayDb(), id));
      const txid = 'd'.repeat(64);
      await reportFaircoinBroadcast(row, txid);
      const { SettlementWatcher } = await import('../../services/settlementWatcher');
      const watcher = new SettlementWatcher({
        getTransaction: async (requested) =>
          requested === txid
            ? {
                txid,
                confirmations: 99,
                // Seller A overpaid, seller B one unit short: not a payment.
                outputs: [
                  { address: sellerAddress(82, 1), valueSat: 9_000_000_000n },
                  { address: sellerAddress(83, 1), valueSat: 1_999_999_999n },
                ],
              }
            : null,
        onChange: () => undefined,
      });
      await watcher.check();
      expect(must(await findIntentByPublicId(gatewayDb(), id))).toMatchObject({
        status: 'canceled',
        cancellationReason: 'underpaid',
      });
    });

    test("the merchant's own lines pay its owner's wallet beside the sellers", async () => {
      const seller = await onboardSeller('store_split_mixed', 84);
      const res = await call('POST', '/v1/checkout_sessions', {
        line_items: [usd('1000', 'Own', undefined), usd('3000', 'Theirs', seller.id)],
        customer_email: 'b@example.com',
        success_url: 'https://platform.example/ok',
      });
      const confirmed = await call(
        'POST',
        `/v1/checkout_sessions/${String(res.json.id)}/public/confirm`,
        { payment_method_type: 'faircoin' },
        secretOf(res.json),
      );
      expect(confirmed.json.error).toBeUndefined();
      expect(confirmed.status).toBe(200);
      const faircoin = (confirmed.json.payment_intent as Json).faircoin as Json;
      const outputs = faircoin.outputs as Json[];
      expect(outputs.map((o) => [o.amount, o.connected_account])).toEqual([
        ['2000000000', null],
        ['6000000000', seller.id],
      ]);
      expect(outputs[1]?.address).toBe(sellerAddress(84, 1));
      expect(String(outputs[0]?.address)).not.toBe(String(outputs[1]?.address));
      // The owner's address is on the owner's own cursor.
      const ownerAddresses = [1, 2, 3, 4, 5, 6, 7, 8].map(platformAddress);
      expect(ownerAddresses).toContain(String(outputs[0]?.address));
    });

    test('a seller not ready for FairCoin makes FairCoin unavailable, never refuses the order', async () => {
      const ready = await onboardSeller('store_split_ready', 85);
      const pending = await call('POST', '/v1/connected_accounts', {
        external_ref: 'store_split_pending',
        faircoin: { network: 'testnet', oxy_user_id: sellerUser(86) },
      });
      const res = await call('POST', '/v1/checkout_sessions', {
        line_items: [usd('1000', 'A', ready.id), usd('1000', 'B', pending.json.id)],
        success_url: 'https://platform.example/ok',
      });
      expect(res.status).toBe(201);
      const view = await call('GET', `/v1/checkout_sessions/${String(res.json.id)}/public`, undefined, secretOf(res.json));
      expect(view.json.faircoin).toMatchObject({
        available: false,
        unavailable_reason: 'faircoin_wallet_missing',
      });
    });

    test('a line seller is one of THIS merchant’s, and exclusive with the session seller', async () => {
      const seller = await onboardSeller('store_split_excl', 87);
      const both = await call('POST', '/v1/checkout_sessions', {
        line_items: [usd('1000', 'A', seller.id)],
        connected_account: seller.id,
        success_url: 'https://platform.example/ok',
      });
      expect(both.status).toBe(400);
      expect((both.json.error as Json).param).toBe('connected_account');
      const unknown = await call('POST', '/v1/checkout_sessions', {
        line_items: [usd('1000', 'A', 'ca_nobody')],
        success_url: 'https://platform.example/ok',
      });
      expect(unknown.status).toBe(400);
      expect(unknown.json.error).toMatchObject({
        code: 'resource_missing',
        param: 'line_items[0][connected_account]',
      });
    });
  });
});
