// The live tails (`events.stream`, `requestLogs.stream`), the request log and
// the test helpers, through the real constructor and a real socket: what
// reaches the Gateway, how the SSE frames come back as objects, how a stream
// the Gateway ended resumes with `Last-Event-ID`, and how a refusal surfaces.
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PeablePermissionError } from '../../src/core/errors';
import { Peable } from '../../src/index';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

async function listen(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => handler(request, response, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}

function client(url: string): Peable {
  return new Peable({
    baseURL: url,
    tokenProvider: { getToken: async () => 'token', invalidate: () => undefined },
  });
}

const event = (id: string) => ({
  id,
  object: 'event',
  type: 'payment_intent.succeeded',
  created: 1,
  livemode: false,
  api_version: '2026-11-03',
  data: { object: { id: 'pi_1' } },
  request: { id: null, idempotency_key: null },
});

function sse(response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  response.write('retry: 3000\n\n');
  response.write('event: ready\ndata: {"object":"live_stream","livemode":false}\n\n');
}

describe('events.stream', () => {
  test('yields each event, and resumes after the last one with Last-Event-ID', async () => {
    const seen: { url: string | undefined; lastEventId: string | undefined; auth?: string }[] = [];
    const url = await listen((request, response) => {
      seen.push({
        url: request.url,
        lastEventId: request.headers['last-event-id'] as string | undefined,
        auth: request.headers.authorization,
      });
      sse(response);
      if (seen.length === 1) {
        response.write(
          `: keepalive\n\nid: evt_1\nevent: event\ndata: ${JSON.stringify(event('evt_1'))}\n\n`,
        );
        // The Gateway ends a stream at the end of its lifetime.
        response.end();
        return;
      }
      response.write(`id: evt_2\nevent: event\ndata: ${JSON.stringify(event('evt_2'))}\n\n`);
    });

    const controller = new AbortController();
    let connects = 0;
    const got: string[] = [];
    for await (const item of client(url).events.stream(
      { types: 'payment_intent.*,charge.refunded' },
      {
        signal: controller.signal,
        onConnect: () => {
          connects += 1;
        },
      },
    )) {
      got.push(item.id);
      if (got.length === 2) controller.abort();
    }
    expect(got).toEqual(['evt_1', 'evt_2']);
    expect(connects).toBe(2);
    expect(seen[0]?.url).toBe('/v1/events/stream?types=payment_intent.*%2Ccharge.refunded');
    expect(seen[0]?.auth).toBe('Bearer token');
    expect(seen[0]?.lastEventId).toBeUndefined();
    expect(seen[1]?.lastEventId).toBe('evt_1');
  });

  test('a refusal (live credential) is thrown, not retried', async () => {
    let calls = 0;
    const url = await listen((_request, response) => {
      calls += 1;
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { type: 'permission_error', code: 'test_mode_only', message: 'test mode only' },
        }),
      );
    });
    const iterate = async () => {
      for await (const _ of client(url).events.stream()) {
        // never reached
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(PeablePermissionError);
    expect(calls).toBe(1);
  });
});

describe('requestLogs', () => {
  test('list spells status and method; stream yields request_log frames', async () => {
    const urls: string[] = [];
    const url = await listen((request, response) => {
      urls.push(request.url ?? '');
      if (request.url?.startsWith('/v1/request_logs/stream')) {
        sse(response);
        response.write(
          `id: req_1\nevent: request_log\ndata: ${JSON.stringify({ id: 'req_1', object: 'request_log', status: 404 })}\n\n`,
        );
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ object: 'list', data: [], has_more: false, url: '/v1/request_logs' }),
      );
    });
    const peable = client(url);
    await peable.requestLogs.list({ status: '4xx', method: 'POST', limit: 5 });
    expect(urls[0]).toBe('/v1/request_logs?status=4xx&method=POST&limit=5');

    const controller = new AbortController();
    for await (const log of peable.requestLogs.stream({ status: 404 }, { signal: controller.signal })) {
      expect(log).toMatchObject({ id: 'req_1', status: 404 });
      controller.abort();
    }
    expect(urls[1]).toBe('/v1/request_logs/stream?status=404');
  });
});

describe('testHelpers and sendTestEvent', () => {
  test('POST the helper routes with an Idempotency-Key', async () => {
    const seen: { method?: string; url?: string; body: string; key?: string }[] = [];
    const url = await listen((request, response, body) => {
      seen.push({
        method: request.method,
        url: request.url,
        body,
        key: request.headers['idempotency-key'] as string | undefined,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'x' }));
    });
    const peable = client(url);
    await peable.testHelpers.paymentIntents.simulateFaircoinPayment('pi_1', {
      outcome: 'underpaid',
    });
    await peable.testHelpers.checkoutSessions.expire('cs_1', {}, { idempotencyKey: 'k' });
    await peable.webhookEndpoints.sendTestEvent('we_1');
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /v1/test_helpers/payment_intents/pi_1/simulate_faircoin_payment',
      'POST /v1/test_helpers/checkout_sessions/cs_1/expire',
      'POST /v1/webhook_endpoints/we_1/test',
    ]);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ outcome: 'underpaid' });
    expect(seen[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]?.key).toBe('k');
  });
});
