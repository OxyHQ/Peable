/**
 * `/v1/webhook_endpoints` and `/v1/events` over HTTP, through the real gateway
 * (ADR 0014 D4): its request id, its idempotency layer and its routers, with
 * only the Oxy credential stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment, SafeFetchResult } from '@oxy.so/core/server';
import { WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT } from '@peable.to/shared-types';
import { PEABLE_API_VERSION } from '@peable.to/contracts';
import { insertEndpoint } from '../../db/webhooks/webhookEndpointRepository';
import { newId } from '../../lib/ids';
import { generateWebhookSecret } from '../../services/webhookEndpoints';
import { createGateway, type Gateway } from '../../server';
import { events } from '../../db/schema';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { runEventSweep } from '../../services/eventSweeper';
import { transitionIntent } from '../../services/intentTransition';
import { must } from '../../__tests__/helpers/must';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedDelivery,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_orbit_webhooks';
let environment: OxyServiceEnvironment = 'development';
let gateway: Gateway | undefined;
let baseUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 'orbit',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment,
    tier: 'external',
  };
  next();
};

const fakeSafeFetch = async (url: string): Promise<SafeFetchResult> => {
  const response = new IncomingMessage(new Socket());
  return { response, status: 200, headers: {}, finalUrl: url };
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

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
    safeFetch: fakeSafeFetch,
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('webhook endpoints', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    environment = 'development';
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  test('create shows the generated secret once; reads never do', async () => {
    const created = await call('POST', '/v1/webhook_endpoints', {
      url: 'https://merchant.example/hook',
      enabled_events: ['payment_intent.succeeded', 'payment_intent.succeeded'],
      metadata: { team: 'orders' },
    });
    expect(created.status).toBe(200);
    expect(created.headers.get('Cache-Control')).toBe('no-store');
    expect(created.json).toMatchObject({
      object: 'webhook_endpoint',
      livemode: false,
      url: 'https://merchant.example/hook',
      enabled_events: ['payment_intent.succeeded'],
      status: 'enabled',
      disabled_reason: null,
      description: null,
      api_version: '2026-11-03',
      metadata: { team: 'orders' },
    });
    expect(String(created.json.id)).toStartWith('we_');
    expect(String(created.json.secret)).toMatch(/^whsec_[0-9a-f]{64}$/);

    const read = await call('GET', `/v1/webhook_endpoints/${String(created.json.id)}`);
    expect(read.status).toBe(200);
    expect(read.json.secret).toBeUndefined();
    const list = await call('GET', '/v1/webhook_endpoints');
    expect(list.json).toMatchObject({
      object: 'list',
      has_more: false,
      url: '/v1/webhook_endpoints',
    });
    expect(JSON.stringify(list.json)).not.toContain(String(created.json.secret));
  });

  test('a retried create replays the same endpoint and secret, not a second one', async () => {
    const body = { url: 'https://merchant.example/hook', enabled_events: ['*'] };
    const first = await call('POST', '/v1/webhook_endpoints', body, { 'Idempotency-Key': 'we-1' });
    const second = await call('POST', '/v1/webhook_endpoints', body, { 'Idempotency-Key': 'we-1' });
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(second.json).toEqual(first.json);
    expect(must((await call('GET', '/v1/webhook_endpoints')).json.data as Json[])).toHaveLength(1);
  });

  test('validates enabled_events and the URL against the delivery SSRF rules', async () => {
    for (const [body, param] of [
      [{ url: 'https://merchant.example/hook', enabled_events: [] }, 'enabled_events'],
      [
        { url: 'https://merchant.example/hook', enabled_events: ['nope.event'] },
        'enabled_events[0]',
      ],
      // A targeted type is not subscribable.
      [
        { url: 'https://merchant.example/hook', enabled_events: ['webhook_endpoint.test'] },
        'enabled_events[0]',
      ],
      [{ url: 'ftp://merchant.example/hook', enabled_events: ['*'] }, 'url'],
      [{ url: 'https://localhost/hook', enabled_events: ['*'] }, 'url'],
      [{ url: 'https://10.0.0.8/hook', enabled_events: ['*'] }, 'url'],
      [{ url: 'https://[::1]/hook', enabled_events: ['*'] }, 'url'],
      [{ url: 'https://merchant.example:8443/hook', enabled_events: ['*'] }, 'url'],
      [{ url: 'https://user:pass@merchant.example/hook', enabled_events: ['*'] }, 'url'],
      [{ url: 'https://merchant.example/hook', enabled_events: ['*'], secret: 'mine' }, 'secret'],
    ] as const) {
      const refused = await call('POST', '/v1/webhook_endpoints', body);
      expect([JSON.stringify(body), refused.status]).toEqual([JSON.stringify(body), 400]);
      expect((refused.json.error as Json).param).toBe(param);
    }
    // Test mode may use plain http; live mode may not.
    const http = { url: 'http://merchant.example/hook', enabled_events: ['*'] };
    expect((await call('POST', '/v1/webhook_endpoints', http)).status).toBe(200);
    await seedMerchant({ oxyAppId: APP_ID, environment: 'production', network: 'mainnet' });
    environment = 'production';
    const live = await call('POST', '/v1/webhook_endpoints', http);
    expect(live.status).toBe(400);
    expect((live.json.error as Json).message).toContain('https');
  });

  test(`caps a merchant at ${WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT} endpoints`, async () => {
    const body = { url: 'https://merchant.example/hook', enabled_events: ['*'] };
    for (let index = 0; index < WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT; index += 1) {
      expect((await call('POST', '/v1/webhook_endpoints', body)).status).toBe(200);
    }
    const over = await call('POST', '/v1/webhook_endpoints', body);
    expect(over.status).toBe(400);
    expect((over.json.error as Json).code).toBe('webhook_endpoint_limit_reached');
  });

  test('updates url, events, description, metadata and disabled; deletes', async () => {
    const created = await call('POST', '/v1/webhook_endpoints', {
      url: 'https://merchant.example/hook',
      enabled_events: ['*'],
      description: 'first',
      metadata: { a: '1', b: '2' },
    });
    const id = String(created.json.id);

    const updated = await call('POST', `/v1/webhook_endpoints/${id}`, {
      url: 'https://merchant.example/v2',
      enabled_events: ['payment_intent.payment_failed'],
      description: '',
      metadata: { a: '', c: '3' },
      disabled: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      url: 'https://merchant.example/v2',
      enabled_events: ['payment_intent.payment_failed'],
      description: null,
      metadata: { b: '2', c: '3' },
      status: 'disabled',
      disabled_reason: 'disabled_by_merchant',
    });
    expect(updated.json.secret).toBeUndefined();

    const enabled = await call('POST', `/v1/webhook_endpoints/${id}`, { disabled: false });
    expect(enabled.json).toMatchObject({ status: 'enabled', disabled_reason: null });

    const unsafe = await call('POST', `/v1/webhook_endpoints/${id}`, { url: 'https://127.0.0.1/' });
    expect(unsafe.status).toBe(400);

    const deleted = await call('DELETE', `/v1/webhook_endpoints/${id}`);
    expect(deleted.json).toEqual({ id, object: 'webhook_endpoint', deleted: true });
    expect((await call('GET', `/v1/webhook_endpoints/${id}`)).status).toBe(404);
    expect((await call('DELETE', `/v1/webhook_endpoints/${id}`)).status).toBe(404);
  });

  test('a stored url the rule refuses: the test event disables it url_refused, and it comes back only with a url that passes', async () => {
    // Written as migration 0040 wrote it: through the repository, not the route.
    const stored = await insertEndpoint(gatewayDb(), {
      publicId: newId('we'),
      merchantId: merchant.id,
      url: 'https://127.0.0.1:9/ssrf',
      enabledEvents: ['*'],
      metadata: {},
      apiVersion: PEABLE_API_VERSION,
      secret: generateWebhookSecret(),
    });
    if (stored === 'limit_reached') throw new Error('endpoint limit reached');
    const id = stored.publicId;

    const tested = await call('POST', `/v1/webhook_endpoints/${id}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.json).toMatchObject({
      last_status: 'failed',
      attempts: 0,
      last_error: 'webhook endpoint url refused: url must use port 80 or 443',
    });
    expect((await call('GET', `/v1/webhook_endpoints/${id}`)).json).toMatchObject({
      status: 'disabled',
      disabled_reason: 'url_refused',
    });

    const reenabled = await call('POST', `/v1/webhook_endpoints/${id}`, { disabled: false });
    expect(reenabled.status).toBe(400);
    expect(reenabled.json.error).toMatchObject({ code: 'url_invalid', param: 'url' });

    const fixed = await call('POST', `/v1/webhook_endpoints/${id}`, {
      url: 'https://merchant.example/hook',
      disabled: false,
    });
    expect(fixed.status).toBe(200);
    expect(fixed.json).toMatchObject({ status: 'enabled', disabled_reason: null });
  });

  test('roll_secret shows a new secret once and bounds the overlap to 24 hours', async () => {
    const created = await call('POST', '/v1/webhook_endpoints', {
      url: 'https://merchant.example/hook',
      enabled_events: ['*'],
    });
    const id = String(created.json.id);
    const rolled = await call('POST', `/v1/webhook_endpoints/${id}/roll_secret`, {
      expires_in_seconds: 3600,
    });
    expect(rolled.status).toBe(200);
    expect(String(rolled.json.secret)).toStartWith('whsec_');
    expect(rolled.json.secret).not.toBe(created.json.secret);
    const tooLong = await call('POST', `/v1/webhook_endpoints/${id}/roll_secret`, {
      expires_in_seconds: 86_401,
    });
    expect(tooLong.status).toBe(400);
    expect((await call('POST', '/v1/webhook_endpoints/we_nobody/roll_secret', {})).status).toBe(
      404,
    );
  });

  test("another merchant's endpoint is a 404, exactly like a missing one", async () => {
    const created = await call('POST', '/v1/webhook_endpoints', {
      url: 'https://merchant.example/hook',
      enabled_events: ['*'],
    });
    await seedMerchant({ oxyAppId: APP_ID, environment: 'staging' });
    environment = 'staging';
    expect((await call('GET', `/v1/webhook_endpoints/${String(created.json.id)}`)).status).toBe(
      404,
    );
    expect(
      (await call('POST', `/v1/webhook_endpoints/${String(created.json.id)}`, { disabled: true }))
        .status,
    ).toBe(404);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('events', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    environment = 'development';
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  test('an API change records its request id and Idempotency-Key on the event', async () => {
    const intent = await seedIntent(merchant);
    const rejected = await call(
      'POST',
      `/v1/payment_intents/${intent.publicId}/cancel`,
      { cancellation_reason: 'duplicate' },
      {
        'Idempotency-Key': 'cancel-1',
      },
    );
    expect(rejected.status).toBe(200);
    const list = await call('GET', '/v1/events?type=payment_intent.canceled');
    const [event] = must(list.json.data as Json[]);
    expect(must(event).request).toEqual({
      id: rejected.headers.get('Request-Id'),
      idempotency_key: 'cancel-1',
    });
    expect(must(event).data).toMatchObject({
      object: { id: intent.publicId, status: 'canceled', cancellation_reason: 'duplicate' },
      previous_attributes: { status: 'requires_action' },
    });
  });

  test('lists newest first, filters by exact type, prefix and created, retrieves by id', async () => {
    const one = await seedIntent(merchant);
    const two = await seedIntent(merchant);
    await transitionIntent(one.id, { from: one.status, status: 'canceled' });
    await transitionIntent(two.id, {
      from: two.status,
      status: 'processing',
      txid: 'a'.repeat(64),
    });

    const all = await call('GET', '/v1/events');
    const data = all.json.data as Json[];
    expect(data.map((row) => row.type)).toEqual([
      'payment_intent.processing',
      'payment_intent.canceled',
    ]);
    expect(data[0]).toMatchObject({
      object: 'event',
      livemode: false,
      api_version: '2026-11-03',
      request: { id: null, idempotency_key: null },
    });

    const exact = await call('GET', '/v1/events?type=payment_intent.canceled');
    expect((exact.json.data as Json[]).map((row) => row.type)).toEqual(['payment_intent.canceled']);
    const prefix = await call('GET', '/v1/events?type=payment_intent.*');
    expect(prefix.json.data as Json[]).toHaveLength(2);
    const otherPrefix = await call('GET', '/v1/events?type=connected_account.*');
    expect(otherPrefix.json.data as Json[]).toHaveLength(0);
    const star = await call('GET', '/v1/events?type=*');
    expect(star.json.data as Json[]).toHaveLength(2);
    expect((await call('GET', '/v1/events?type=payment_intent.%25')).status).toBe(400);

    const future = Math.floor(Date.now() / 1000) + 3600;
    const none = await call('GET', `/v1/events?created[gt]=${future}`);
    expect(none.json.data as Json[]).toHaveLength(0);

    const paged = await call('GET', '/v1/events?limit=1');
    expect(paged.json.has_more).toBe(true);
    const next = await call(
      'GET',
      `/v1/events?limit=1&starting_after=${String(must((paged.json.data as Json[])[0]).id)}`,
    );
    expect(must((next.json.data as Json[])[0]).type).toBe('payment_intent.canceled');

    const id = String(must(data[0]).id);
    const read = await call('GET', `/v1/events/${id}`);
    expect(read.json).toEqual(must(data[0]));
    expect((await call('GET', '/v1/events/evt_nobody')).status).toBe(404);
  });

  test('delivery_success splits delivered events from undelivered ones', async () => {
    const intent = await seedIntent(merchant);
    const ok = await seedDelivery(merchant, intent);
    const pending = await seedDelivery(merchant, intent, { pending: true });

    const succeeded = await call('GET', '/v1/events?delivery_success=true');
    expect((succeeded.json.data as Json[]).map((row) => row.id)).toEqual([ok.eventPublicId]);
    const failed = await call('GET', '/v1/events?delivery_success=false');
    expect((failed.json.data as Json[]).map((row) => row.id)).toEqual([pending.eventPublicId]);
  });

  test('an event older than 30 days is not served, and the sweep deletes it with its deliveries', async () => {
    const intent = await seedIntent(merchant);
    const delivery = await seedDelivery(merchant, intent);
    await gatewayDb()
      .update(events)
      .set({ createdAt: sql`now() - interval '31 days'` })
      .where(eq(events.id, delivery.eventId));

    expect((await call('GET', `/v1/events/${delivery.eventPublicId}`)).status).toBe(404);
    expect((await call('GET', '/v1/events')).json.data as Json[]).toHaveLength(0);

    await runEventSweep();
    expect(await gatewayDb().select().from(events)).toHaveLength(0);
    expect((await call('GET', `/v1/webhook_deliveries?limit=10`)).json.data as Json[]).toHaveLength(
      0,
    );
  });
});
