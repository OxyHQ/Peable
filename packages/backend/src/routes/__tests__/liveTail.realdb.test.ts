/**
 * The live tail and the request log, over HTTP through the real gateway and a
 * real database — only the Oxy credential stubbed:
 *
 * - `GET /v1/events/stream`: an event recorded in a COMMITTED transaction is
 *   streamed, rendered exactly as `/v1/events` renders it; one recorded in a
 *   rolled-back transaction never is; another merchant's never is; `types`
 *   filters; `Last-Event-ID` replays what committed after it; a live
 *   credential is refused.
 * - The request log: written for a merchant request (method, path without its
 *   query, status, idempotency key — nothing else), listed and filtered,
 *   retrieved by `Request-Id`, served to Orbit's dashboard route, swept after
 *   30 days, and streamed by `GET /v1/request_logs/stream`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { Peable, WebhooksResource } from '@peable.to/sdk';
import { signWebhook } from '@peable.to/shared-types';
import { createGateway, type Gateway } from '../../server';
import { createDashboardRouter } from '../dashboard';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { apiRequestLogs } from '../../db/schema';
import { recordEvent } from '../../services/events';
import { runRequestLogSweep } from '../../services/requestLogSweeper';
import { flushRequestLogs } from '../../lib/requestLog';
import { requestIdMiddleware } from '../../lib/requestId';
import { toWebhookEndpointDTO } from '../../lib/serialize';
import { openSse } from '../../__tests__/helpers/sse';
import {
  POSTGRES_TESTS_ENABLED,
  gatewayDb,
  resetGatewayTables,
  seedMerchant,
  seedWebhookEndpoint,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_A = 'app_live_tail_a';
const APP_B = 'app_live_tail_b';
let appId = APP_A;
let environment: OxyServiceEnvironment = 'development';
let gateway: Gateway | undefined;
let dashboard: Server | undefined;
let baseUrl = '';
let dashboardUrl = '';
let merchantA: MerchantRow;
let merchantB: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId,
    appName: 'tail',
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

/** A committed `webhook_endpoint.test` event for `merchant` — any recorded event will do. */
async function recordCommitted(merchant: MerchantRow) {
  const { endpoint } = await seedWebhookEndpoint(merchant);
  return gatewayDb().transaction((tx) =>
    recordEvent(tx, {
      merchantId: merchant.id,
      type: 'webhook_endpoint.test',
      object: toWebhookEndpointDTO(endpoint),
    }),
  );
}

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    createDashboardRouter({
      requireOxyUser: (req, _res, next) => {
        (req as OxyAuthRequest).userId = 'user_member';
        (req as OxyAuthRequest).accessToken = 'token';
        next();
      },
      assertAppMembership: async () => ({ allowed: true, ownerAccountId: 'owner' }),
    }),
  );
  dashboard = app.listen(0);
  dashboardUrl = `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
  dashboard?.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('GET /v1/events/stream', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    appId = APP_A;
    environment = 'development';
    merchantA = await seedMerchant({ oxyAppId: APP_A });
    merchantB = await seedMerchant({ oxyAppId: APP_B });
  });

  test('streams a committed event exactly as /v1/events renders it', async () => {
    const stream = await openSse(`${baseUrl}/v1/events/stream`);
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toStartWith('text/event-stream');
      const ready = await stream.next();
      expect(ready.event).toBe('ready');
      expect(JSON.parse(ready.data)).toEqual({ object: 'live_stream', livemode: false });

      const event = await recordCommitted(merchantA);
      const frame = await stream.next();
      expect(frame.event).toBe('event');
      expect(frame.id).toBe(event.publicId);
      const stored = await call('GET', `/v1/events/${event.publicId}`);
      expect(JSON.parse(frame.data)).toEqual(stored.json);
    } finally {
      stream.close();
    }
  });

  test('never streams an event whose transaction rolled back', async () => {
    const stream = await openSse(`${baseUrl}/v1/events/stream`);
    try {
      await stream.next();
      const { endpoint } = await seedWebhookEndpoint(merchantA);
      await gatewayDb()
        .transaction(async (tx) => {
          await recordEvent(tx, {
            merchantId: merchantA.id,
            type: 'webhook_endpoint.test',
            object: toWebhookEndpointDTO(endpoint),
          });
          throw new Error('roll back');
        })
        .catch(() => undefined);
      expect(await stream.quiet(400)).toBeNull();

      // And the stream is alive: the next committed one still arrives.
      const event = await recordCommitted(merchantA);
      expect((await stream.next()).id).toBe(event.publicId);
    } finally {
      stream.close();
    }
  });

  test("never streams another merchant's event", async () => {
    const stream = await openSse(`${baseUrl}/v1/events/stream`);
    try {
      await stream.next();
      await recordCommitted(merchantB);
      expect(await stream.quiet(400)).toBeNull();
      const mine = await recordCommitted(merchantA);
      expect((await stream.next()).id).toBe(mine.publicId);
    } finally {
      stream.close();
    }
  });

  test('`types` keeps only the matching events', async () => {
    const stream = await openSse(`${baseUrl}/v1/events/stream?types=payment_intent.*`);
    try {
      await stream.next();
      await recordCommitted(merchantA);
      expect(await stream.quiet(300)).toBeNull();
      const created = await call('POST', '/v1/payment_intents', {
        amount: '100000000',
        network: 'testnet',
      });
      expect(created.status).toBe(201);
      const frame = await stream.next();
      const event = JSON.parse(frame.data) as Json;
      expect(event.type).toBe('payment_intent.created');
      expect((event.data as Json).object).toMatchObject({ id: created.json.id });
    } finally {
      stream.close();
    }
  });

  test('a malformed `types` is a 400 naming it', async () => {
    const response = await call('GET', '/v1/events/stream?types=Payment%20Intent');
    expect(response.status).toBe(400);
    expect(response.json.error).toMatchObject({ param: 'types[0]' });
  });

  test('Last-Event-ID replays what committed after it, oldest first', async () => {
    const first = await recordCommitted(merchantA);
    const second = await recordCommitted(merchantA);
    const third = await recordCommitted(merchantA);
    const stream = await openSse(`${baseUrl}/v1/events/stream`, {
      'Last-Event-ID': first.publicId,
    });
    try {
      expect((await stream.next()).event).toBe('ready');
      expect((await stream.next()).id).toBe(second.publicId);
      expect((await stream.next()).id).toBe(third.publicId);
      expect(await stream.quiet(200)).toBeNull();
    } finally {
      stream.close();
    }
  });

  test("the SDK's events.stream reads it, and a CLI-style signature verifies", async () => {
    const peable = new Peable({
      baseURL: baseUrl,
      tokenProvider: { getToken: async () => 'token', invalidate: () => undefined },
    });
    const controller = new AbortController();
    let ready: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const received = (async () => {
      for await (const event of peable.events.stream(
        {},
        { signal: controller.signal, onConnect: () => ready() },
      )) {
        controller.abort();
        return event;
      }
      return undefined;
    })();
    await connected;
    const recorded = await recordCommitted(merchantA);
    const event = await received;
    expect(event?.id).toBe(recorded.publicId);
    // What `peable listen` does with it: the body a delivery carries, signed
    // with the dispatcher's own algorithm, verifies with the SDK.
    const body = JSON.stringify(event);
    const secret = `whsec_${'ab'.repeat(32)}`;
    const header = signWebhook(secret, body, Math.floor(Date.now() / 1000));
    expect(new WebhooksResource().constructEvent(body, header, secret).id).toBe(recorded.publicId);
  });

  test('a live credential is refused', async () => {
    appId = 'app_live_tail_live';
    environment = 'production';
    await seedMerchant({ oxyAppId: appId, environment: 'production', network: 'mainnet' });
    const response = await call('GET', '/v1/events/stream');
    expect(response.status).toBe(403);
    expect(response.json.error).toMatchObject({ type: 'permission_error', code: 'test_mode_only' });
  });

  test('a stream is not itself a request log row', async () => {
    const stream = await openSse(`${baseUrl}/v1/events/stream`);
    await stream.next();
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await flushRequestLogs();
    const rows = await gatewayDb().select().from(apiRequestLogs);
    expect(rows.map((row) => row.path)).not.toContain('/v1/events/stream');
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the request log', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    appId = APP_A;
    environment = 'development';
    merchantA = await seedMerchant({ oxyAppId: APP_A });
    merchantB = await seedMerchant({ oxyAppId: APP_B });
  });

  test('records method, path without query, status, duration and key — nothing else', async () => {
    const created = await call(
      'POST',
      '/v1/payment_intents?ignored=secret@example.com',
      { amount: '100000000', network: 'testnet', metadata: { email: 'payer@example.com' } },
      { 'Idempotency-Key': 'order-42' },
    );
    expect(created.json).toMatchObject({ object: 'payment_intent' });
    const requestId = created.headers.get('Request-Id');
    await flushRequestLogs();

    const log = await call('GET', `/v1/request_logs/${String(requestId)}`);
    expect(log.status).toBe(200);
    expect(log.json).toEqual({
      id: requestId,
      object: 'request_log',
      livemode: false,
      method: 'POST',
      path: '/v1/payment_intents',
      status: 201,
      duration_ms: expect.any(Number),
      idempotency_key: 'order-42',
      created: expect.any(Number),
    });
    const [raw] = await gatewayDb().execute(
      sql`select row_to_json(l)::text as row from api_request_logs l where request_id = ${requestId}`,
    );
    expect(String((raw as { row: string }).row)).not.toContain('example.com');
  });

  test('a refused request is logged too; an unknown route is not a merchant request', async () => {
    const refused = await call('POST', '/v1/payment_intents', { amount: 'nope' });
    expect(refused.status).toBe(400);
    await call('GET', '/health');
    await flushRequestLogs();
    const list = await call('GET', '/v1/request_logs?status=4xx');
    expect((list.json.data as Json[]).map((row) => row.id)).toEqual([
      refused.headers.get('Request-Id'),
    ]);
  });

  test('lists newest first, filtered by status and method, scoped to the merchant', async () => {
    await call('GET', '/v1/payment_intents');
    await call('POST', '/v1/payment_intents', { amount: '100000000', network: 'testnet' });
    appId = APP_B;
    await call('GET', '/v1/payment_intents');
    appId = APP_A;
    await flushRequestLogs();

    const all = await call('GET', '/v1/request_logs');
    expect(all.json).toMatchObject({ object: 'list', has_more: false, url: '/v1/request_logs' });
    expect((all.json.data as Json[]).map((row) => `${row.method} ${row.status}`)).toEqual([
      'POST 201',
      'GET 200',
    ]);
    const posts = await call('GET', '/v1/request_logs?method=POST');
    expect((posts.json.data as Json[]).map((row) => row.status)).toEqual([201]);
    await flushRequestLogs();
    // The log reads are requests too, and are logged like any other.
    const exact = await call('GET', '/v1/request_logs?status=200');
    expect((exact.json.data as Json[]).map((row) => row.path)).toEqual([
      '/v1/request_logs',
      '/v1/request_logs',
      '/v1/payment_intents',
    ]);
    const unknown = await call('GET', '/v1/request_logs?status=6xx');
    expect(unknown.status).toBe(400);
  });

  test("Orbit's dashboard route lists the same rows", async () => {
    const made = await call('GET', '/v1/payment_intents');
    await flushRequestLogs();
    const response = await fetch(
      `${dashboardUrl}/v1/dashboard/applications/${APP_A}/request_logs?environment=development`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    expect((body.data as Json[]).map((row) => row.id)).toContain(made.headers.get('Request-Id'));
  });

  test('is swept after 30 days, and unreadable before the sweep reaches it', async () => {
    const made = await call('GET', '/v1/payment_intents');
    await flushRequestLogs();
    await gatewayDb().execute(
      sql`update api_request_logs set created_at = now() - interval '31 days'`,
    );
    const hidden = await call('GET', `/v1/request_logs/${String(made.headers.get('Request-Id'))}`);
    expect(hidden.status).toBe(404);
    await flushRequestLogs();
    await runRequestLogSweep();
    // Only the 404 lookup itself is left: it is less than 30 days old.
    expect((await gatewayDb().select().from(apiRequestLogs)).map((row) => row.status)).toEqual([
      404,
    ]);
  });

  test('GET /v1/request_logs/stream tails requests as they are answered', async () => {
    const stream = await openSse(`${baseUrl}/v1/request_logs/stream?status=2xx`);
    try {
      expect((await stream.next()).event).toBe('ready');
      await call('POST', '/v1/payment_intents', { amount: 'nope' });
      const made = await call('POST', '/v1/payment_intents', {
        amount: '100000000',
        network: 'testnet',
      });
      const frame = await stream.next();
      expect(frame.event).toBe('request_log');
      expect(frame.id).toBe(String(made.headers.get('Request-Id')));
      expect(JSON.parse(frame.data)).toMatchObject({ method: 'POST', status: 201 });
    } finally {
      stream.close();
    }
  });

  test('the request-log stream refuses a live credential', async () => {
    appId = 'app_live_tail_live_logs';
    environment = 'production';
    await seedMerchant({ oxyAppId: appId, environment: 'production', network: 'mainnet' });
    const response = await call('GET', '/v1/request_logs/stream');
    expect(response.status).toBe(403);
    expect(response.json.error).toMatchObject({ code: 'test_mode_only' });
  });
});
