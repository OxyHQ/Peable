/**
 * `webhookEndpoints`, `events` and `webhookDeliveries` (ADR 0014 D4): the
 * routes, methods, query spellings and bodies an integrator would otherwise
 * have to guess.
 */
import { resources } from '../support/testGateway';
import { describe, expect, test } from 'bun:test';
import type { WebhookEndpoint, WebhookEvent } from '@peable.to/shared-types';
import { Peable } from '../../src/index';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const ENDPOINT: WebhookEndpoint = {
  id: 'we_1',
  object: 'webhook_endpoint',
  livemode: false,
  url: 'https://merchant.example/hook',
  description: null,
  enabled_events: ['*'],
  status: 'enabled',
  disabled_reason: null,
  api_version: '2026-11-03',
  metadata: {},
  created: 1789776000,
  updated_at: 1789776000,
};

const EVENT: WebhookEvent = {
  id: 'evt_1',
  object: 'event',
  type: 'webhook_endpoint.test',
  created: 1789776000,
  livemode: false,
  api_version: '2026-11-03',
  data: { object: ENDPOINT },
  request: { id: 'req_1', idempotency_key: null },
};

function harness(json: unknown) {
  const gateway: CapturedRequest[] = [];
  const mock = createMockFetch((request) => {
    if (!request.url.startsWith(TEST_GATEWAY_URL)) return serviceTokenMintResponse();
    gateway.push(request);
    return { status: 200, json };
  });
  return { client: buildTestClient(mock.fetch), gateway };
}

function last(gateway: CapturedRequest[]): CapturedRequest {
  const request = gateway.at(-1);
  if (!request) throw new Error('no gateway request was made');
  return request;
}

describe('webhookEndpoints', () => {
  test('create POSTs the body with an Idempotency-Key and returns the secret', async () => {
    const { client, gateway } = harness({ ...ENDPOINT, secret: 'whsec_abc' });
    const endpoints = resources(client).webhookEndpoints;
    const created = await endpoints.create(
      { url: ENDPOINT.url, enabled_events: ['payment_intent.succeeded'] },
      { idempotencyKey: 'we-1' },
    );
    const request = last(gateway);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${TEST_GATEWAY_URL}/v1/webhook_endpoints`);
    expect(request.headers.get('Idempotency-Key')).toBe('we-1');
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      url: ENDPOINT.url,
      enabled_events: ['payment_intent.succeeded'],
    });
    expect(created.secret).toBe('whsec_abc');
  });

  test('retrieve, update, list, del and rollSecret address the endpoint', async () => {
    const { client, gateway } = harness(ENDPOINT);
    const endpoints = resources(client).webhookEndpoints;

    await endpoints.retrieve('we_1');
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'GET',
      `${TEST_GATEWAY_URL}/v1/webhook_endpoints/we_1`,
    ]);

    await endpoints.update('we_1', { disabled: true });
    expect(last(gateway).method).toBe('POST');
    expect(JSON.parse(last(gateway).body ?? '{}')).toEqual({ disabled: true });

    await endpoints.del('we_1');
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'DELETE',
      `${TEST_GATEWAY_URL}/v1/webhook_endpoints/we_1`,
    ]);

    await endpoints.rollSecret('we_1', { expires_in_seconds: 3600 });
    expect(last(gateway).url).toBe(`${TEST_GATEWAY_URL}/v1/webhook_endpoints/we_1/roll_secret`);
    expect(JSON.parse(last(gateway).body ?? '{}')).toEqual({ expires_in_seconds: 3600 });
  });

  test('list pages over the endpoints', async () => {
    const { client, gateway } = harness({
      object: 'list',
      data: [ENDPOINT],
      has_more: false,
      url: '/v1/webhook_endpoints',
    });
    const all = await resources(client).webhookEndpoints.list({ limit: 5 }).autoPagingToArray({
      limit: 10,
    });
    expect(all).toEqual([ENDPOINT]);
    expect(last(gateway).url).toBe(`${TEST_GATEWAY_URL}/v1/webhook_endpoints?limit=5`);
  });
});

describe('events', () => {
  test('list spells type and delivery_success as the gateway reads them', async () => {
    const { client, gateway } = harness({
      object: 'list',
      data: [EVENT],
      has_more: false,
      url: '/v1/events',
    });
    const page = await resources(client).events.list({
      type: 'payment_intent.*',
      delivery_success: false,
    });
    expect(page.data).toEqual([EVENT]);
    const url = new URL(last(gateway).url);
    expect(url.pathname).toBe('/v1/events');
    expect(url.searchParams.get('type')).toBe('payment_intent.*');
    expect(url.searchParams.get('delivery_success')).toBe('false');
  });

  test('retrieve reads one event', async () => {
    const { client, gateway } = harness(EVENT);
    expect(await resources(client).events.retrieve('evt_1')).toEqual(EVENT);
    expect(last(gateway).url).toBe(`${TEST_GATEWAY_URL}/v1/events/evt_1`);
  });
});

describe('webhookDeliveries', () => {
  test('list filters by event and endpoint; redeliver POSTs', async () => {
    const { client, gateway } = harness({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/webhook_deliveries',
    });
    const deliveries = resources(client).webhookDeliveries;
    await deliveries.list({ event: 'evt_1', webhook_endpoint: 'we_1' });
    const url = new URL(last(gateway).url);
    expect(url.searchParams.get('event')).toBe('evt_1');
    expect(url.searchParams.get('webhook_endpoint')).toBe('we_1');

    await deliveries.redeliver('d_1');
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'POST',
      `${TEST_GATEWAY_URL}/v1/webhook_deliveries/d_1/redeliver`,
    ]);
  });
});

test('the client exposes the three namespaces', () => {
  const peable = new Peable({ publicKey: 'oxy_dk_test', secret: 'sk_test' });
  expect(typeof peable.webhookEndpoints).toBe('object');
  expect(typeof peable.events).toBe('object');
  expect(typeof peable.webhookDeliveries).toBe('object');
});
