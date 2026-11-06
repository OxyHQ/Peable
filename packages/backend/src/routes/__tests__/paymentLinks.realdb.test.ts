/**
 * Payment Links v2 (Orbit Phase 3), against a real Postgres: links over
 * catalog prices, their options, the payer visit that creates a Checkout
 * Session (never a payment), `restrictions.completed_sessions`, and a
 * contribution link expressed on the same model.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { uuidv7 } from '@oxy.so/db';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { createContributionLink } from '../../db/payments/contributionRepository';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { paymentIntents } from '../../db/schema';
import { newId } from '../../lib/ids';
import { requestIdMiddleware } from '../../lib/requestId';
import { simulateFaircoinPayment } from '../../services/testHelpers';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  seedPrice,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createCheckoutSessionsRouter } from '../checkoutSessions';
import { createPaymentLinksRouter } from '../paymentLinks';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read structurally by the assertions
type Json = Record<string, any>;

const APP_ID = 'app_links_v2';
let server: Server;
let baseUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'development',
    tier: 'external',
  };
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

useGatewayDatabase();

beforeAll(async () => {
  if (!POSTGRES_TESTS_ENABLED) return;
  merchant = await seedMerchant({ oxyAppId: APP_ID, network: 'testnet' });
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    createPaymentLinksRouter({
      requireMerchant: stubRequireMerchant,
      publicRateLimit: passthrough,
    }),
  );
  app.use(
    createCheckoutSessionsRouter({
      requireMerchant: stubRequireMerchant,
      publicRateLimit: passthrough,
    }),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('merchant', () => {
  test('creates a link over prices, with its options, and records payment_link.created', async () => {
    const a = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '100', name: 'Mug' });
    const b = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '250', name: 'Tee' });
    const { status, body } = await call('POST', '/v1/payment_links', {
      line_items: [
        { price: a.publicId, quantity: 2, adjustable_quantity: { enabled: true, maximum: 10 } },
        { price: b.publicId, quantity: 1 },
      ],
      allow_promotion_codes: true,
      phone_number_collection: { enabled: true },
      after_completion: {
        type: 'redirect',
        redirect: { url: 'https://shop.example/done?cs={CHECKOUT_SESSION_ID}' },
      },
      restrictions: { completed_sessions: { limit: 1 } },
      metadata: { campaign: 'spring' },
    });
    expect(status).toBe(201);
    expect(body.object).toBe('payment_link');
    expect(body.currency).toBe('FAIR');
    expect(
      body.line_items.map((line: Json) => [line.description, line.quantity, line.amount_total]),
    ).toEqual([
      ['Mug', 2, '200'],
      ['Tee', 1, '250'],
    ]);
    expect(body.after_completion.redirect.url).toContain('{CHECKOUT_SESSION_ID}');
    expect(body.restrictions).toEqual({ completed_sessions: { limit: 1, count: 0 } });
    expect(String(body.url)).toMatch(/\/l\/link_[0-9a-f]{24}$/);
    const created = (
      await storedEvents({ merchantId: merchant.id, type: 'payment_link.created' })
    ).filter(({ event }) => (event.data.object as { id?: string }).id === body.id);
    expect(created).toHaveLength(1);
    const lines = await call('GET', `/v1/payment_links/${body.id}/line_items?expand[]=data.price`);
    expect(lines.body.has_more).toBe(false);
    expect(lines.body.data[0].price.id).toBe(a.publicId);
  });

  test('refuses recurring prices, mixed currencies and archived prices by line', async () => {
    const recurring = await seedPrice(merchant, { currency: 'FAIR', recurring: 'month' });
    const eur = await seedPrice(merchant, { currency: 'EUR' });
    const fair = await seedPrice(merchant, { currency: 'FAIR' });
    const archived = await seedPrice(merchant, { currency: 'FAIR', active: false });
    const cases: [Json[], string][] = [
      [[{ price: recurring.publicId, quantity: 1 }], 'line_items[0][price]'],
      [
        [
          { price: fair.publicId, quantity: 1 },
          { price: eur.publicId, quantity: 1 },
        ],
        'line_items[1][price]',
      ],
      [[{ price: archived.publicId, quantity: 1 }], 'line_items[0][price]'],
    ];
    for (const [lineItems, param] of cases) {
      const res = await call('POST', '/v1/payment_links', { line_items: lineItems });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe(param);
    }
  });

  test('updates options (never lines), records the moved fields, and clears with ""', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: link } = await call('POST', '/v1/payment_links', {
      line_items: [{ price: price.publicId, quantity: 1 }],
      restrictions: { completed_sessions: { limit: 5 } },
    });
    const updated = await call('POST', `/v1/payment_links/${link.id}`, {
      allow_promotion_codes: true,
      restrictions: '',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.allow_promotion_codes).toBe(true);
    expect(updated.body.restrictions).toBeNull();
    const lines = await call('POST', `/v1/payment_links/${link.id}`, { line_items: [] });
    expect(lines.status).toBe(400);
    const events = (
      await storedEvents({ merchantId: merchant.id, type: 'payment_link.updated' })
    ).filter(({ event }) => (event.data.object as { id?: string }).id === link.id);
    expect(events).toHaveLength(1);
    const { updated_at, ...previous } = must(events[0]).event.data.previous_attributes ?? {};
    expect(previous).toEqual({ allow_promotion_codes: false, restrictions: link.restrictions });
    // A real second boundary adds the old timestamp to the same event diff.
    expect(updated_at).toBe(
      updated.body.updated_at === link.updated_at ? undefined : link.updated_at,
    );
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the payer', () => {
  test('a visit creates a session with the link’s lines and options — and no payment', async () => {
    const price = await seedPrice(merchant, {
      currency: 'FAIR',
      unitAmount: '700',
      name: 'Poster',
    });
    const { body: link } = await call('POST', '/v1/payment_links', {
      line_items: [{ price: price.publicId, quantity: 3 }],
      allow_promotion_codes: true,
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: 'Thanks!' },
      },
    });
    const shown = await call('GET', `/v1/payment_links/${link.id}/public`);
    expect(shown.status).toBe(200);
    expect(shown.body.metadata).toBeUndefined();
    expect(shown.body.line_items[0].amount_total).toBe('2100');
    const before = await gatewayDb()
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.merchantId, merchant.id));
    const start = await call('POST', `/v1/payment_links/${link.id}/checkout_sessions`, {});
    expect(start.status).toBe(201);
    expect(start.body.object).toBe('checkout_session_start');
    const after = await gatewayDb()
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.merchantId, merchant.id));
    expect(after.length).toBe(before.length);
    const session = await call('GET', `/v1/checkout_sessions/${start.body.id}`);
    expect(session.body.payment_link).toBe(link.id);
    expect(session.body.allow_promotion_codes).toBe(true);
    expect(session.body.amount_total).toBe('2100');
    const view = await call('GET', `/v1/checkout_sessions/${start.body.id}/public`, undefined, {
      'X-Peable-Client-Secret': start.body.client_secret,
    });
    expect(view.body.line_items[0].description).toBe('Poster');
    expect(view.body.confirmation_message).toBeNull();
  });

  test('a link with a completed-sessions limit deactivates when it is reached', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: link } = await call('POST', '/v1/payment_links', {
      line_items: [{ price: price.publicId, quantity: 1 }],
      restrictions: { completed_sessions: { limit: 1 } },
    });
    const start = await call('POST', `/v1/payment_links/${link.id}/checkout_sessions`, {});
    const secret = { 'X-Peable-Client-Secret': start.body.client_secret };
    await call(
      'POST',
      `/v1/checkout_sessions/${start.body.id}/public`,
      { customer_details: { email: 'l@example.com' } },
      secret,
    );
    const confirmed = await call(
      'POST',
      `/v1/checkout_sessions/${start.body.id}/public/confirm`,
      {},
      secret,
    );
    expect(confirmed.status).toBe(200);
    await simulateFaircoinPayment(
      must(await findIntentByPublicId(gatewayDb(), confirmed.body.payment_intent.id)),
      'settled',
    );
    const after = await call('GET', `/v1/payment_links/${link.id}`);
    expect(after.body.active).toBe(false);
    expect(after.body.restrictions.completed_sessions.count).toBe(1);
    const refused = await call('POST', `/v1/payment_links/${link.id}/checkout_sessions`, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('payment_link_inactive');
    // The payment it created belongs to the link (contribution collections read this).
    const intent = must(await findIntentByPublicId(gatewayDb(), confirmed.body.payment_intent.id));
    expect(intent.paymentLinkId).not.toBeNull();
  });

  test('a free contribution takes the payer’s amount, and its operation key returns the same session', async () => {
    const row = await createContributionLink(gatewayDb(), {
      publicId: newId('link'),
      merchantId: merchant.id,
      oxyAppId: merchant.oxyAppId,
      environment: merchant.environment,
      rail: 'faircoin',
      currency: 'FAIR',
      network: 'testnet',
      amount: '0',
      metadata: {},
      contributionKey: uuidv7(),
      contribution: {
        organizationId: 'org_1',
        purpose: 'Community garden',
        amountMode: 'free',
        expiresAt: null,
      },
    });
    if (!row || row === 'expired') throw new Error('contribution not created');
    const shown = await call('GET', `/v1/payment_links/${row.publicId}/public`);
    expect(shown.body.contribution.purpose).toBe('Community garden');
    expect(shown.body.contribution_amount).toBeNull();
    const noKey = await call('POST', `/v1/payment_links/${row.publicId}/checkout_sessions`, {
      amount: '500000000',
    });
    expect(noKey.body.error.code).toBe('idempotency_key_invalid');
    const key = crypto.randomUUID();
    const first = await call(
      'POST',
      `/v1/payment_links/${row.publicId}/checkout_sessions`,
      { amount: '500000000' },
      { 'Idempotency-Key': key },
    );
    expect(first.status).toBe(201);
    const replay = await call(
      'POST',
      `/v1/payment_links/${row.publicId}/checkout_sessions`,
      { amount: '500000000' },
      { 'Idempotency-Key': key },
    );
    expect(replay.body.id).toBe(first.body.id);
    const conflict = await call(
      'POST',
      `/v1/payment_links/${row.publicId}/checkout_sessions`,
      { amount: '700000000' },
      { 'Idempotency-Key': key },
    );
    expect(conflict.status).toBe(409);
    const session = await call('GET', `/v1/checkout_sessions/${first.body.id}`);
    expect(session.body.amount_total).toBe('500000000');
    expect(session.body.submit_type).toBe('donate');
    const none = await call(
      'POST',
      `/v1/payment_links/${row.publicId}/checkout_sessions`,
      {},
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(none.body.error.param).toBe('amount');
  });
});
