/**
 * FairCoin connected accounts through the SDK (ADR 0012): the Stripe-named
 * `accounts` / `accountLinks` namespaces, payments ON BEHALF OF a seller, and
 * the typed event a platform receives for one.
 *
 * These assert ROUTES and BODIES — the half an integrator would otherwise have
 * to guess — and that nothing in the SDK can carry a seller's key: the
 * platform never supplies one.
 */
import { describe, expect, test } from 'bun:test';
import {
  canExpire,
  signWebhook,
  type ConnectedAccount,
  type PaymentIntent,
  type WebhookEvent,
} from '@peable.to/shared-types';
import { Peable } from '../../src';
import {
  AccountLinksResource,
  ConnectedAccountsResource,
} from '../../src/resources/connectedAccounts';
import { CheckoutSessionsResource } from '../../src/resources/checkoutSessions';
import { PaymentIntentsResource } from '../../src/resources/paymentIntents';
import { WebhooksResource } from '../../src/resources/webhooks';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const SELLER: ConnectedAccount = {
  id: 'ca_seller',
  object: 'connected_account',
  externalRef: 'store_42',
  rails: ['faircoin'],
  faircoin: {
    network: 'testnet',
    status: 'pending',
    oxyUserId: 'user_seller',
    registeredAt: null,
  },
  country: null,
  defaultCurrency: null,
  payable: false,
  payoutsEnabled: false,
  chargesEnabled: false,
  transfersCapability: null,
  cardPaymentsCapability: null,
  requirements: { currentlyDue: 0, eventuallyDue: 0, pastDue: 0, pendingVerification: 0 },
  disabledReasonCodes: [],
  lastSyncedAt: null,
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

const ON_BEHALF: PaymentIntent = {
  id: 'pi_onbehalf',
  object: 'payment_intent',
  status: 'created',
  rail: 'faircoin',
  amount: '250000000',
  currency: 'FAIR',
  network: 'testnet',
  address: 'tFairSellerAddress',
  merchantId: 'merch_platform',
  connectedAccountId: 'ca_seller',
  txid: null,
  confirmations: 0,
  clientSecret: 'pi_onbehalf_secret_x',
  metadata: { order: 'o_1' },
  expiresAt: '2026-10-16T00:15:00.000Z',
  canExpire: true,
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

function gateway(body: unknown, status = 200) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status, json: body };
  });
}

function callOf(requests: CapturedRequest[]): CapturedRequest {
  const call = requests.find((r) => !r.url.includes('/auth/service-token'));
  if (!call) throw new Error('no gateway call was made');
  return call;
}

function bodyOf(request: CapturedRequest): unknown {
  return request.body === undefined ? undefined : JSON.parse(request.body);
}

describe('Peable — the Stripe-named Connect namespaces', () => {
  test('`accounts` IS `connectedAccounts`, and `accountLinks` exists', () => {
    const peable = new Peable({ publicKey: 'oxy_dk_test', secret: 'sk_test' });
    expect(peable.accounts).toBe(peable.connectedAccounts);
    expect(peable.accountLinks).toBeInstanceOf(AccountLinksResource);
  });
});

describe('accounts', () => {
  test('opens a FairCoin-only seller: network and Oxy user, no key and no card fields', async () => {
    const { fetch: fetchImpl, requests } = gateway(SELLER, 201);
    const accounts = new ConnectedAccountsResource(buildTestClient(fetchImpl));

    const account = await accounts.create({
      externalRef: 'store_42',
      faircoin: { network: 'testnet', oxyUserId: 'user_seller' },
    });

    expect(account.faircoin?.status).toBe('pending');
    const request = callOf(requests);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${TEST_GATEWAY_URL}/v1/connected_accounts`);
    expect(bodyOf(request)).toEqual({
      externalRef: 'store_42',
      faircoin: { network: 'testnet', oxyUserId: 'user_seller' },
    });
  });

  test('retrieves and lists', async () => {
    const one = gateway(SELLER);
    await new ConnectedAccountsResource(buildTestClient(one.fetch)).retrieve('ca_seller');
    expect(callOf(one.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/connected_accounts/ca_seller`);

    const page = gateway({ object: 'list', data: [SELLER], has_more: false });
    const list = await new ConnectedAccountsResource(buildTestClient(page.fetch)).list({
      limit: 10,
    });
    expect(list.data[0]?.rails).toEqual(['faircoin']);
    expect(callOf(page.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/connected_accounts?limit=10`);
  });
});

describe('accountLinks', () => {
  test('mints a FairCoin onboarding link for a seller, naming the rail', async () => {
    const link = {
      object: 'account_link',
      url: 'https://peable.to/connect/tok',
      expiresAt: '2026-10-16T01:00:00.000Z',
    };
    const { fetch: fetchImpl, requests } = gateway(link, 201);
    const links = new AccountLinksResource(
      new ConnectedAccountsResource(buildTestClient(fetchImpl)),
    );

    const created = await links.create({
      account: 'ca_seller',
      rail: 'faircoin',
      returnUrl: 'https://mercaria.co/sell/payments/done',
      refreshUrl: 'https://mercaria.co/sell/payments/refresh',
    });

    expect(created.url).toBe('https://peable.to/connect/tok');
    const request = callOf(requests);
    expect(request.url).toBe(`${TEST_GATEWAY_URL}/v1/connected_accounts/ca_seller/account_links`);
    // The account goes in the PATH; it is not repeated in the body.
    expect(bodyOf(request)).toEqual({
      rail: 'faircoin',
      returnUrl: 'https://mercaria.co/sell/payments/done',
      refreshUrl: 'https://mercaria.co/sell/payments/refresh',
    });
  });
});

describe('payments on behalf of a seller', () => {
  test('paymentIntents.create sends connectedAccount and an explicit FairCoin rail', async () => {
    const { fetch: fetchImpl, requests } = gateway(ON_BEHALF, 201);
    const intents = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const intent = await intents.create(
      {
        amount: '250000000',
        rail: 'faircoin',
        network: 'testnet',
        connectedAccount: 'ca_seller',
        metadata: { order: 'o_1' },
      },
      { idempotencyKey: 'order_o_1' },
    );

    expect(intent.connectedAccountId).toBe('ca_seller');
    const request = callOf(requests);
    expect(request.headers.get('Idempotency-Key')).toBe('order_o_1');
    expect(bodyOf(request)).toMatchObject({ rail: 'faircoin', connectedAccount: 'ca_seller' });
  });

  test("lists one seller's payments", async () => {
    const { fetch: fetchImpl, requests } = gateway({ object: 'list', data: [], has_more: false });
    await new PaymentIntentsResource(buildTestClient(fetchImpl)).list({
      connected_account: 'ca_seller',
    });
    expect(callOf(requests).url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_intents?connected_account=ca_seller`,
    );
  });

  test('checkout.sessions.create sends connectedAccount', async () => {
    const { fetch: fetchImpl, requests } = gateway(
      { id: 'cs_1', connectedAccountId: 'ca_seller' },
      201,
    );
    await new CheckoutSessionsResource(buildTestClient(fetchImpl)).create({
      amount: '1',
      network: 'testnet',
      connectedAccount: 'ca_seller',
    });
    expect(bodyOf(callOf(requests))).toMatchObject({ connectedAccount: 'ca_seller' });
  });

  test("an unready seller surfaces the gateway's code, so a platform can branch on it", async () => {
    const { fetch: fetchImpl } = gateway(
      {
        error: {
          type: 'invalid_request_error',
          code: 'account_not_ready',
          message: 'this seller has not registered their FairCoin key yet',
        },
      },
      409,
    );
    const intents = new PaymentIntentsResource(buildTestClient(fetchImpl));
    const error = await intents
      .create(
        { amount: '1', network: 'testnet', connectedAccount: 'ca_seller' },
        { idempotencyKey: 'k' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PeableInvalidRequestError);
    expect((error as PeableInvalidRequestError).code).toBe('account_not_ready');
    expect((error as PeableInvalidRequestError).statusCode).toBe(409);
  });
});

describe('the platform webhook for an on-behalf payment', () => {
  test('is typed, carries the seller on `event.account`, and says whether it can still expire', () => {
    const event: WebhookEvent<'payment_intent.confirming'> = {
      id: 'evt_1',
      object: 'event',
      type: 'payment_intent.confirming',
      created: '2026-10-16T00:05:00.000Z',
      account: 'ca_seller',
      data: { object: { ...ON_BEHALF, status: 'confirming', canExpire: false } },
    };
    const raw = JSON.stringify(event);
    const header = signWebhook('whsec_platform', raw, 1_760_000_000);

    const parsed = new WebhooksResource().constructEvent(raw, header, 'whsec_platform', {
      toleranceSec: Number.MAX_SAFE_INTEGER,
    });

    expect(parsed.account).toBe('ca_seller');
    if (parsed.type === 'payment_intent.confirming') {
      expect(parsed.data.object.connectedAccountId).toBe('ca_seller');
      // A broadcast/confirming payment NEVER expires: never cancel the order for it.
      expect(parsed.data.object.canExpire).toBe(false);
      expect(canExpire(parsed.data.object.status)).toBe(false);
    } else {
      throw new Error(`unexpected event type ${parsed.type}`);
    }
  });
});
