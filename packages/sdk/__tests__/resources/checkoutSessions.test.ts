import { describe, expect, test } from 'bun:test';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { CheckoutResource } from '../../src/resources/checkoutSessions';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function gatewayCallOf(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((r) => !r.url.includes('/auth/service-token'));
}

describe('CheckoutResource.sessions', () => {
  test('create() POSTs /v1/checkout_sessions and returns the CheckoutSession DTO', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 201,
        json: {
          id: 'cs_1',
          object: 'checkout_session',
          paymentIntentId: 'pi_1',
          clientSecret: 'pi_1_secret_x',
          amount: '100000',
          network: 'testnet',
          metadata: {},
          url: 'https://checkout.peable.to/c/cs_1',
        },
      };
    });
    const checkout = new CheckoutResource(buildTestClient(fetchImpl));

    const session = await checkout.sessions.create({ amount: '100000', network: 'testnet' });

    expect(session.id).toBe('cs_1');
    expect(session.clientSecret).toBe('pi_1_secret_x');
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions`);
    expect(call?.headers.get('Idempotency-Key')).toBeNull();
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount: '100000', network: 'testnet' });
  });

  test('create() sends options.idempotencyKey as the Idempotency-Key header', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: { id: 'cs_1', object: 'checkout_session' } };
    });
    const checkout = new CheckoutResource(buildTestClient(fetchImpl));

    await checkout.sessions.create(
      { amount: '100000', network: 'testnet' },
      { idempotencyKey: 'order-42' },
    );

    expect(gatewayCallOf(requests)?.headers.get('Idempotency-Key')).toBe('order-42');
  });

  /**
   * The case the option exists for. The first create reaches the gateway and
   * creates the session, but the caller never sees the answer (a timeout or a
   * dropped connection surfaces as a network failure). The retry carries the
   * SAME key, so the gateway — which keys the session on it — answers with the
   * session already made rather than a second one.
   */
  test('a retry after a lost response reuses the key and gets the same session', async () => {
    const sessionsByKey = new Map<string, string>();
    let created = 0;
    let dropNextResponse = true;
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      const key = req.headers.get('Idempotency-Key') ?? '';
      let id = sessionsByKey.get(key);
      const replay = id !== undefined;
      if (!id) {
        created += 1;
        id = `cs_${created}`;
        sessionsByKey.set(key, id);
      }
      if (dropNextResponse) {
        dropNextResponse = false;
        throw new Error('socket hang up');
      }
      return { status: replay ? 200 : 201, json: { id, object: 'checkout_session' } };
    });
    const checkout = new CheckoutResource(buildTestClient(fetchImpl));
    const params = { amount: '100000', network: 'testnet' as const };

    await expect(checkout.sessions.create(params, { idempotencyKey: 'order-7' })).rejects.toThrow(
      'Failed to reach the Peable Gateway',
    );
    const session = await checkout.sessions.create(params, { idempotencyKey: 'order-7' });

    expect(session.id).toBe('cs_1');
    expect(created).toBe(1);
    const keys = requests
      .filter((r) => !r.url.includes('/auth/service-token'))
      .map((r) => r.headers.get('Idempotency-Key'));
    expect(keys).toEqual(['order-7', 'order-7']);
  });

  test('a key replayed with different parameters surfaces the 409 as an invalid request', async () => {
    const { fetch: fetchImpl } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 409,
        json: {
          error: {
            type: 'idempotency_error',
            message: 'Idempotency-Key reused with different parameters',
          },
        },
      };
    });
    const checkout = new CheckoutResource(buildTestClient(fetchImpl));

    const failure = checkout.sessions.create(
      { amount: '200000', network: 'testnet' },
      { idempotencyKey: 'order-42' },
    );

    await expect(failure).rejects.toBeInstanceOf(PeableInvalidRequestError);
    await expect(failure).rejects.toMatchObject({ statusCode: 409 });
  });

  test('retrieve() GETs /v1/checkout_sessions/:id', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'cs_1', object: 'checkout_session' } };
    });
    const checkout = new CheckoutResource(buildTestClient(fetchImpl));

    await checkout.sessions.retrieve('cs_1');

    expect(gatewayCallOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions/cs_1`);
  });
});
