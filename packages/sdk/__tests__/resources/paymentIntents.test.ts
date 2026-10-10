import { describe, expect, test } from 'bun:test';
import type { PaymentIntent } from '@peable.to/shared-types';
import { PaymentIntentsResource } from '../../src/resources/paymentIntents';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { createMockFetch } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const SAMPLE_INTENT: PaymentIntent = {
  id: 'pi_1',
  object: 'payment_intent',
  status: 'created',
  rail: 'faircoin',
  amount: '100000',
  currency: 'FAIR',
  network: 'testnet',
  address: 'addr1',
  merchantId: 'merch_1',
  txid: null,
  confirmations: 0,
  clientSecret: 'pi_1_secret_x',
  metadata: {},
  expiresAt: '2026-07-19T00:15:00.000Z',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

describe('PaymentIntentsResource', () => {
  test('create() POSTs /v1/payment_intents with body + Idempotency-Key + bearer, returns the DTO', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: SAMPLE_INTENT };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const intent = await resource.create(
      { amount: '100000', network: 'testnet' },
      { idempotencyKey: 'idem-abc' },
    );

    expect(intent).toEqual(SAMPLE_INTENT);
    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents`);
    expect(call?.headers.get('Idempotency-Key')).toBe('idem-abc');
    expect(call?.headers.get('Authorization')).toBe('Bearer svc_test_token');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount: '100000', network: 'testnet' });
  });

  test('retrieve() GETs /v1/payment_intents/:id', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'pi_1', object: 'payment_intent', status: 'settled' } };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await resource.retrieve('pi_1');

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1`);
  });

  test('list() GETs /v1/payment_intents with status/limit/starting_after query params', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { object: 'list', data: [], has_more: false } };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await resource.list({ status: 'settled', limit: 5 });

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    const url = new URL(call?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_intents');
    expect(url.searchParams.get('status')).toBe('settled');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.has('starting_after')).toBe(false);
  });

  test('reject() POSTs /v1/payment_intents/:id/reject', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'pi_1', object: 'payment_intent', status: 'rejected' } };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const intent = await resource.reject('pi_1');

    expect(intent.status).toBe('rejected');
    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/reject`);
  });

  test('propagates a mapped PeableError on a non-2xx Gateway response', async () => {
    const { fetch: fetchImpl } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 404,
        json: { error: { type: 'invalid_request_error', message: 'payment intent not found' } },
      };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await expect(resource.retrieve('pi_missing')).rejects.toBeInstanceOf(PeableInvalidRequestError);
  });
});
