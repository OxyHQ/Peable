/**
 * Test and live in one deployment (ADR 0017) — end to end, over HTTP.
 *
 * ## What isolates money
 *
 * `merchants` is unique on `(oxy_app_id, environment)` and `resolveMerchant`
 * resolves by both, so a development credential and a production one address
 * different merchant rows. That is isolation of DATA. Isolation of MONEY is
 * which provider key a call is sent with, and a deployment now holds a test key
 * and a live key side by side. The credential's environment selects
 * (`environmentGuard.ts`: production ⟺ live), and an operation on a stored
 * object uses the mode of the row.
 *
 * ## What this file drives
 *
 * The real routers, mounted on a real express app, against a real database,
 * with BOTH modes configured and one recording fake provider PER MODE injected
 * through the registry. The assertion that matters is the negative one: a
 * development credential's operations reach the TEST fake, and the live fake is
 * never called — not before, not after, not for a refund of a stored payment.
 * A production credential is the mirror image. A mode with no key is a rail
 * that is off: 503, and nothing reaches either fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProviderMode } from '../../services/providers/provider';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';

/** Every provider call, prefixed with the mode of the fake that received it. */
const providerCalls: string[] = [];
/** Provider object ids are unique for the life of the file, as Stripe's are. */
let objectCounter = 0;
const nextObject = () => String(++objectCounter);

function fakeProviderFor(mode: ProviderMode) {
  const record = (fn: string) => providerCalls.push(`${mode}:${fn}`);
  return {
    id: 'stripe' as const,
    createPayment: async () => {
      record('createPayment');
      return {
        providerObjectId: `pi_${mode}_${nextObject()}`,
        status: 'created' as const,
        clientAction: { kind: 'client_secret' as const, value: `secret_${mode}` },
      };
    },
    capture: async () => {
      record('capture');
      throw new Error('not used');
    },
    cancel: async () => {
      record('cancel');
      throw new Error('not used');
    },
    refund: async () => {
      record('refund');
      return {
        providerObjectId: `re_${mode}_${nextObject()}`,
        status: 'partially_refunded' as const,
        state: 'succeeded' as const,
      };
    },
    getStatus: async () => {
      record('getStatus');
      throw new Error('not used');
    },
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createTransfer: async () => {
      record('createTransfer');
      throw new Error('not used');
    },
    reverseTransfer: async () => {
      record('reverseTransfer');
      throw new Error('not used');
    },
    createAccount: async () => {
      record('createAccount');
      return {
        providerAccountId: `acct_${mode}_${nextObject()}`,
        payoutsEnabled: false,
        chargesEnabled: false,
        transfersCapability: 'pending' as const,
        cardPaymentsCapability: 'pending' as const,
        currentlyDue: [],
        eventuallyDue: [],
        pastDue: [],
        pendingVerification: [],
        disabledReason: null,
      };
    },
    accountLink: async () => {
      record('accountLink');
      throw new Error('not used');
    },
    getAccount: async () => {
      record('getAccount');
      throw new Error('not used');
    },
  };
}

const fakes = { test: fakeProviderFor('test'), live: fakeProviderFor('live') };

/**
 * The registry, faked — but inert outside this file, and still honest about
 * which modes are configured: a mode whose card rail the config does not hold
 * answers `undefined`, exactly as the real registry would.
 *
 * `mock.module` is process-global in bun and survives `mock.restore()`, so the
 * delegation flag keeps it local (the idiom `cardCreate.realdb.test.ts`
 * documents).
 */
const realRegistry = await import('../../services/providers/registry');
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = realRegistry;
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
  resetProviders: () => {
    realResetProviders();
  },
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createPaymentIntentsRouter } = await import('../paymentIntents');
const { createRefundsRouter } = await import('../refunds');
const { createConnectedAccountsRouter } = await import('../connectedAccounts');
const { createCheckoutSessionsRouter } = await import('../checkoutSessions');
const { gatewayDb, seedIntent, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { linkProviderObject, updateIntentState } = await import(
  '../../db/payments/paymentIntentRepository'
);
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');

const APP_ID = 'app_environment_isolation';

/** Which credential environment the next request carries. */
let credentialEnvironment: OxyServiceEnvironment = 'development';

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: credentialEnvironment,
    tier: 'external',
  };
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();

let server: Server;
let baseUrl: string;
let restoreModes: () => void = () => undefined;

interface Body {
  readonly livemode?: boolean;
  readonly error?: { readonly type: string; readonly message: string };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    body: (await response.json()) as { data?: readonly { livemode: boolean }[] },
  };
}

/** A settled card payment of this credential's merchant, linked at the provider. */
async function settledCardPayment(environment: OxyServiceEnvironment, publicId: string) {
  const merchant = await seedMerchant({ oxyAppId: APP_ID, environment });
  const intent = await seedIntent(merchant, { publicId, rail: 'card', amount: '5000' });
  await linkProviderObject(gatewayDb(), intent.id, 'stripe', `pi_stripe_${publicId}`);
  await updateIntentState(gatewayDb(), intent.id, { from: 'created', status: 'settled' });
  return intent;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('test and live in one deployment', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFakeRegistry = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    await settledCardPayment('development', 'pi_env_dev');
    await settledCardPayment('production', 'pi_env_prod');

    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubRequireMerchant,
        optionalServiceAuth: passthrough,
      }),
    );
    app.use(createRefundsRouter({ requireMerchant: stubRequireMerchant }));
    app.use(createConnectedAccountsRouter({ requireMerchant: stubRequireMerchant }));
    app.use(
      createCheckoutSessionsRouter({
        requireMerchant: stubRequireMerchant,
        publicRateLimit: passthrough,
      }),
    );
    // A thrown error answers as JSON naming it, so a failure reads as a cause
    // rather than as express's HTML page.
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: { type: 'api_error', message: error.message } });
      },
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    credentialEnvironment = 'development';
    setStripeModes({ test: stripeModeFixture('test'), live: stripeModeFixture('live') });
  });

  afterAll(async () => {
    restoreModes();
    useFakeRegistry = false;
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  describe('a development credential reaches the TEST client and never the live one', () => {
    test('creating a card payment intent', async () => {
      const { status, body } = await post(
        '/v1/payment_intents',
        { amount: '5000', rail: 'card', currency: 'EUR' },
        { 'Idempotency-Key': 'env-dev-1' },
      );
      expect(status).toBe(201);
      expect(body.livemode).toBe(false);
      expect(providerCalls).toEqual(['test:createPayment']);
    });

    test('creating a card checkout session', async () => {
      const { status, body } = await post('/v1/checkout_sessions', {
        amount: '5000',
        rail: 'card',
        currency: 'EUR',
      });
      expect(status).toBe(201);
      expect(body.livemode).toBe(false);
      expect(providerCalls).toEqual(['test:createPayment']);
    });

    test('opening a connected account', async () => {
      // The least recoverable mistake on this surface: a connected account
      // cannot be deleted, so one opened live by a development credential would
      // be a real account left behind forever.
      const { status, body } = await post('/v1/connected_accounts', {
        external_ref: 'seller-dev',
        country: 'ES',
        business_type: 'individual',
      });
      expect(status).toBe(201);
      expect(body.livemode).toBe(false);
      expect(providerCalls).toEqual(['test:createAccount']);
    });

    test('refunding a stored payment', async () => {
      const { status, body } = await post('/v1/refunds', {
        payment_intent: 'pi_env_dev',
        external_ref: 'refund-dev',
        amount: '100',
      });
      expect(status).toBe(201);
      expect(body.livemode).toBe(false);
      expect(providerCalls).toEqual(['test:refund']);
    });
  });

  describe('a production credential reaches the LIVE client and never the test one', () => {
    beforeEach(() => {
      credentialEnvironment = 'production';
    });

    test('creating a card payment intent', async () => {
      const { status, body } = await post(
        '/v1/payment_intents',
        { amount: '5000', rail: 'card', currency: 'EUR' },
        { 'Idempotency-Key': 'env-prod-1' },
      );
      expect(status).toBe(201);
      expect(body.livemode).toBe(true);
      expect(providerCalls).toEqual(['live:createPayment']);
    });

    test('refunding a stored payment', async () => {
      const { status, body } = await post('/v1/refunds', {
        payment_intent: 'pi_env_prod',
        external_ref: 'refund-prod',
        amount: '100',
      });
      expect(status).toBe(201);
      expect(body.livemode).toBe(true);
      expect(providerCalls).toEqual(['live:refund']);
    });
  });

  /**
   * The list and retrieve surfaces read rows back, so they say which world
   * each object belongs to — derived from the row's merchant, the same source
   * the provider client was selected by.
   */
  test("lists report every object in the credential's own mode", async () => {
    const dev = await get('/v1/refunds');
    expect(dev.status).toBe(200);
    expect(dev.body.data?.length).toBeGreaterThan(0);
    expect(dev.body.data?.every((refund) => refund.livemode === false)).toBe(true);
    const devSessions = await get('/v1/checkout_sessions');
    expect(devSessions.body.data?.length).toBeGreaterThan(0);
    expect(devSessions.body.data?.every((session) => session.livemode === false)).toBe(true);

    credentialEnvironment = 'production';
    const prod = await get('/v1/refunds');
    expect(prod.body.data?.length).toBeGreaterThan(0);
    expect(prod.body.data?.every((refund) => refund.livemode === true)).toBe(true);
    expect(providerCalls).toEqual([]);
  });

  describe('a mode with no key is a card rail that is off', () => {
    test('a production credential is answered 503 when only the test key is held', async () => {
      setStripeModes({ test: stripeModeFixture('test') });
      credentialEnvironment = 'production';
      const { status, body } = await post(
        '/v1/payment_intents',
        { amount: '5000', rail: 'card', currency: 'EUR' },
        { 'Idempotency-Key': 'env-prod-no-live' },
      );
      expect(status).toBe(503);
      expect(body.error?.message).toContain('live mode');
      // And never falls through to the key that IS held.
      expect(providerCalls).toEqual([]);
    });

    test('a development credential is answered 503 when only the live key is held', async () => {
      setStripeModes({ live: stripeModeFixture('live') });
      const { status } = await post(
        '/v1/payment_intents',
        { amount: '5000', rail: 'card', currency: 'EUR' },
        { 'Idempotency-Key': 'env-dev-no-test' },
      );
      expect(status).toBe(503);
      expect(providerCalls).toEqual([]);
    });

    test('a stored payment cannot be refunded through the other mode', async () => {
      setStripeModes({ test: stripeModeFixture('test') });
      credentialEnvironment = 'production';
      const { status } = await post('/v1/refunds', {
        payment_intent: 'pi_env_prod',
        external_ref: 'refund-prod-no-live',
        amount: '100',
      });
      expect(status).toBe(503);
      expect(providerCalls).toEqual([]);
    });
  });

  /**
   * The chain rail has no provider, no key and no mode — a testnet payment is
   * already a different network, enforced by the merchant's own `network`
   * column. Holding neither Stripe key must not stop it.
   */
  test('a FairCoin intent mints with no Stripe key at all', async () => {
    setStripeModes({});
    const { status, body } = await post(
      '/v1/payment_intents',
      { amount: '100000000', network: 'testnet' },
      { 'Idempotency-Key': 'env-faircoin' },
    );
    expect(status).toBe(201);
    expect(body.livemode).toBe(false);
    expect(providerCalls).toEqual([]);
  });
});
