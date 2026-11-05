/**
 * ADR 0021 D5 over HTTP, against a real Postgres: FairCoin pays the payee's own
 * watch-only key, so the key is REQUIRED.
 *
 * - A merchant registered without a key registers it ONCE, from its own
 *   credential (`POST /v1/merchants/me/faircoin`) or Orbit (`…/merchant/faircoin`,
 *   `money`): immutable, watch-only, the network checked, unique across every
 *   merchant and seller, testnet only outside production.
 * - A LIVE merchant without one takes no payment: a PaymentIntent, a Checkout
 *   Session (its own or a payment link visit's), a Payment Link, a subscription
 *   and an invoice finalization answer 409 `faircoin_account_required`, and the
 *   scheduler records the refusal on the draft instead of failing every pass.
 *   Test mode is not gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { uuidv7 } from '@oxy.so/db';
import { installFakeCardProvider } from '../../__tests__/helpers/fakeCardProvider';

const card = await installFakeCardProvider();
const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createGateway } = await import('../../server');
const {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedLink,
  seedMerchant,
  seedPrice,
  testXprvFor,
  testXpubFor,
  useGatewayDatabase,
} = await import('../../__tests__/helpers/gatewayTestDatabase');
const { must } = await import('../../__tests__/helpers/must');
const { stubOxyAccess } = await import('../../__tests__/helpers/oxyAccessStub');
const { findMerchantById } = await import('../../db/merchants/merchantRepository');
const { insertConnectedAccount, registerFaircoinKey } = await import(
  '../../db/accounts/connectedAccountRepository'
);
const { findInvoiceForMerchant } = await import('../../db/billingEngine/invoiceRepository');
const { invoices } = await import('../../db/schema');
const { runInvoiceStep } = await import('../../services/billingEngine/scheduler');
type MerchantRow = import('../../db/merchants/merchantRepository').MerchantRow;

// biome-ignore lint/suspicious/noExplicitAny: wire JSON read by many assertions
type Json = Record<string, any>;

/** Who a request is made as: the merchant credential names its app and environment. */
const requireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: req.header('x-test-app') ?? 'none',
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: (req.header('x-test-env') ?? 'development') as OxyServiceEnvironment,
    tier: 'external',
  };
  next();
};
const requireOxyUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = 'user_owner';
  (req as OxyAuthRequest).accessToken = 'token';
  next();
};
const access = stubOxyAccess({
  application: () => ({
    permissions: ['app:read', 'app:update', 'billing:manage'],
    ownerAccountId: 'acct',
  }),
});
const passthrough: RequestHandler = (_req, _res, next) => next();

useGatewayDatabase();
let gateway: ReturnType<typeof createGateway> | undefined;
let baseUrl = '';
let restoreModes: () => void = () => undefined;

beforeAll(() => {
  card.enabled = true;
  restoreModes = setStripeModes({
    test: stripeModeFixture('test'),
    live: stripeModeFixture('live'),
  });
  gateway = createGateway({
    requireMerchant,
    requireOxyUser,
    access,
    optionalServiceAuth: passthrough,
    publicRateLimit: passthrough,
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  card.enabled = false;
  gateway?.httpServer.close();
  gateway?.watcher.stop();
  restoreModes();
});

async function call(
  merchant: Pick<MerchantRow, 'oxyAppId' | 'environment'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-app': merchant.oxyAppId,
      'x-test-env': merchant.environment,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function ok(
  merchant: Pick<MerchantRow, 'oxyAppId' | 'environment'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Json> {
  const answer = await call(merchant, method, path, body);
  if (answer.status >= 300) {
    throw new Error(`${method} ${path}: ${answer.status} ${JSON.stringify(answer.json)}`);
  }
  return answer.json;
}

function expectGated(answer: { status: number; json: Json }): void {
  expect(answer.status).toBe(409);
  expect(answer.json.error).toMatchObject({
    type: 'invalid_request_error',
    code: 'faircoin_account_required',
  });
  expect(answer.json.error.message).toContain('FairCoin receiving key');
}

function freshApp(): string {
  return `app_fck_${uuidv7()}`;
}

const sessionBody = (price: string) => ({
  mode: 'payment',
  line_items: [{ price, quantity: 1 }],
  success_url: 'https://shop.example/done',
});

/** A draft one-off invoice of 700 EUR cents for a new customer. */
async function draftInvoice(merchant: MerchantRow): Promise<string> {
  const customer = await ok(merchant, 'POST', '/v1/customers', { email: 'payer@example.test' });
  const invoice = await ok(merchant, 'POST', '/v1/invoices', {
    customer: customer.id,
    currency: 'EUR',
  });
  await ok(merchant, 'POST', '/v1/invoiceitems', {
    customer: customer.id,
    invoice: invoice.id,
    amount: '700',
    currency: 'EUR',
    description: 'Setup',
  });
  return invoice.id as string;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('registering the key once', () => {
  test('a keyless merchant registers its key; a second registration is refused', async () => {
    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    expect(merchant.xpub).toBeNull();
    const xpub = testXpubFor('testnet', 40);

    const first = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'testnet',
      xpub,
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ object: 'merchant', network: 'testnet', xpub });

    const second = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'testnet',
      xpub: testXpubFor('testnet', 41),
    });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('already_registered');
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).xpub).toBe(xpub);
  });

  test('a private key is refused and never stored', async () => {
    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    const xprv = testXprvFor('testnet', 42);
    expect(xprv.startsWith('xpub')).toBe(false);
    const answer = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'testnet',
      xpub: xprv,
    });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'watch_only_violation', param: 'xpub' });
    const stored = must(await findMerchantById(gatewayDb(), merchant.id));
    expect(stored.xpub).toBeNull();
    expect(stored.network).toBeNull();
  });

  test('a key for the other network is refused', async () => {
    const merchant = await seedMerchant({
      oxyAppId: freshApp(),
      environment: 'production',
      keyless: true,
    });
    const answer = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'mainnet',
      xpub: testXpubFor('testnet', 43),
    });
    expect(answer.status).toBe(400);
    expect(answer.json.error.code).toBe('watch_only_violation');
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).xpub).toBeNull();
  });

  test('a non-production merchant registers testnet only', async () => {
    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    const answer = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'mainnet',
      xpub: testXpubFor('mainnet', 44),
    });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'parameter_invalid', param: 'network' });
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).xpub).toBeNull();
  });

  test("another merchant's key, or a seller's, is refused", async () => {
    const holder = await seedMerchant({
      oxyAppId: freshApp(),
      xpub: testXpubFor('testnet', 45),
    });
    const platform = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    const seller = must(
      await insertConnectedAccount(gatewayDb(), {
        publicId: `ca_${uuidv7()}`,
        merchantId: platform.id,
        externalRef: `store_${uuidv7()}`,
        faircoin: { network: 'testnet', oxyUserId: 'user_seller' },
      }),
    );
    const sellerKey = testXpubFor('testnet', 46);
    expect((await registerFaircoinKey(gatewayDb(), seller.id, sellerKey)).ok).toBe(true);

    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    for (const xpub of [must(holder.xpub), sellerKey]) {
      const answer = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
        network: 'testnet',
        xpub,
      });
      expect(answer.status).toBe(409);
      expect(answer.json.error).toMatchObject({ code: 'key_in_use', param: 'xpub' });
    }
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).xpub).toBeNull();
  });

  test('a merchant with card payments, sessions and links already made registers its key', async () => {
    // The composite references from payment_intents, checkout_sessions and
    // payment_links name the merchant's NULL network: they must not refuse it
    // becoming a value.
    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    const price = await seedPrice(merchant, { currency: 'EUR', unitAmount: '1500' });
    await ok(merchant, 'POST', '/v1/payment_intents', {
      rail: 'card',
      amount: '1500',
      currency: 'EUR',
    });
    await ok(merchant, 'POST', '/v1/checkout_sessions', sessionBody(price.publicId));
    await seedLink(merchant);

    const answer = await call(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'testnet',
      xpub: testXpubFor('testnet', 47),
    });
    expect(answer.status).toBe(200);
    expect(answer.json.network).toBe('testnet');
  });

  test("Orbit registers it with the dashboard's money permission", async () => {
    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    const xpub = testXpubFor('testnet', 48);
    const res = await fetch(
      `${baseUrl}/v1/dashboard/applications/${merchant.oxyAppId}/merchant/faircoin?environment=development`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network: 'testnet', xpub }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).xpub).toBe(xpub);
    expect(must(await findMerchantById(gatewayDb(), merchant.id)).network).toBe('testnet');
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('a live merchant without its key', () => {
  let live: MerchantRow;
  beforeAll(async () => {
    live = await seedMerchant({ oxyAppId: freshApp(), environment: 'production', keyless: true });
  });

  test('creates no PaymentIntent, on either rail', async () => {
    expectGated(
      await call(live, 'POST', '/v1/payment_intents', {
        rail: 'card',
        amount: '1500',
        currency: 'EUR',
      }),
    );
    expectGated(await call(live, 'POST', '/v1/payment_intents', { amount: '100000000' }));
    expect(card.calls.filter((c) => c.startsWith('live:'))).toEqual([]);
  });

  test('creates no Checkout Session, no Payment Link, and a shared link starts no order', async () => {
    const price = await seedPrice(live, { currency: 'EUR', unitAmount: '1500' });
    expectGated(await call(live, 'POST', '/v1/checkout_sessions', sessionBody(price.publicId)));
    expectGated(
      await call(live, 'POST', '/v1/payment_links', {
        line_items: [{ price: price.publicId, quantity: 1 }],
      }),
    );
    // A link made before the gate existed (seeded past it).
    const link = await seedLink(live);
    expectGated(
      await call(live, 'POST', `/v1/payment_links/${link.publicId}/checkout_sessions`, {}),
    );
  });

  test('Orbit cannot create them either', async () => {
    const price = await seedPrice(live, { currency: 'EUR', unitAmount: '1500' });
    const res = await fetch(
      `${baseUrl}/v1/dashboard/applications/${live.oxyAppId}/checkout_sessions?environment=production`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionBody(price.publicId)),
      },
    );
    expectGated({ status: res.status, json: (await res.json()) as Json });
  });

  test('finalizes no invoice and creates no subscription; the scheduler records and retries', async () => {
    const invoiceId = await draftInvoice(live);
    expectGated(await call(live, 'POST', `/v1/invoices/${invoiceId}/finalize`, {}));
    expectGated(await call(live, 'POST', `/v1/invoices/${invoiceId}/pay`, {}));
    const draft = must(await findInvoiceForMerchant(gatewayDb(), invoiceId, live.id));
    expect(draft.status).toBe('draft');
    expect(draft.lastFinalizationError?.code).toBe('faircoin_account_required');

    // The scheduler's auto-finalize: refused, recorded, retried an hour later —
    // never a pass that fails every 30 seconds.
    await gatewayDb()
      .update(invoices)
      .set({
        autoAdvance: true,
        automaticallyFinalizesAt: sql`now() - interval '1 minute'`,
        nextActionAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(invoices.id, draft.id));
    await runInvoiceStep(draft.id);
    const retried = must(await findInvoiceForMerchant(gatewayDb(), invoiceId, live.id));
    expect(retried.status).toBe('draft');
    expect(must(retried.nextActionAt).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    const price = await seedPrice(live, {
      currency: 'EUR',
      unitAmount: '900',
      recurring: 'month',
    });
    const customer = await ok(live, 'POST', '/v1/customers', { email: 'sub@example.test' });
    expectGated(
      await call(live, 'POST', '/v1/subscriptions', {
        customer: customer.id,
        items: [{ price: price.publicId }],
        collection_method: 'send_invoice',
        days_until_due: 30,
      }),
    );
  });

  test('takes payments once it registers its key', async () => {
    const merchant = await seedMerchant({
      oxyAppId: freshApp(),
      environment: 'production',
      keyless: true,
    });
    expectGated(
      await call(merchant, 'POST', '/v1/payment_intents', {
        rail: 'card',
        amount: '1500',
        currency: 'EUR',
      }),
    );
    await ok(merchant, 'POST', '/v1/merchants/me/faircoin', {
      network: 'mainnet',
      xpub: testXpubFor('mainnet', 49),
    });
    const intent = await call(merchant, 'POST', '/v1/payment_intents', {
      rail: 'card',
      amount: '1500',
      currency: 'EUR',
    });
    expect(intent.status).toBe(201);
    const invoiceId = await draftInvoice(merchant);
    const finalized = await ok(merchant, 'POST', `/v1/invoices/${invoiceId}/finalize`, {});
    expect(finalized.status).toBe('open');
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('test mode is not gated', () => {
  test('a keyless test merchant creates payments, sessions, links and invoices', async () => {
    const merchant = await seedMerchant({ oxyAppId: freshApp(), keyless: true });
    const intent = await call(merchant, 'POST', '/v1/payment_intents', {
      rail: 'card',
      amount: '1500',
      currency: 'EUR',
    });
    expect(intent.status).toBe(201);
    const price = await seedPrice(merchant, { currency: 'EUR', unitAmount: '1500' });
    expect(
      (await call(merchant, 'POST', '/v1/checkout_sessions', sessionBody(price.publicId))).status,
    ).toBe(201);
    const link = await call(merchant, 'POST', '/v1/payment_links', {
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    expect(link.status).toBe(201);
    expect(
      (await call(merchant, 'POST', `/v1/payment_links/${link.json.id}/checkout_sessions`, {}))
        .status,
    ).toBe(201);
    const invoiceId = await draftInvoice(merchant);
    expect((await ok(merchant, 'POST', `/v1/invoices/${invoiceId}/finalize`, {})).status).toBe(
      'open',
    );
  });
});
