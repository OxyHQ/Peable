import { describe, expect, test } from 'bun:test';
import { resources } from '../support/testGateway';
import { PeableIdempotencyError } from '../../src/core/errors';
import { checkoutSessionFixture, lineItemFixture } from '../support/checkoutFixture';
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
        json: { ...checkoutSessionFixture, id: 'cs_1' },
      };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    const params = {
      line_items: [
        { price: 'price_1', quantity: 2, adjustable_quantity: { enabled: true, maximum: 5 } },
        {
          price_data: {
            currency: 'EUR' as const,
            unit_amount: '500',
            product_data: { name: 'Gift wrap' },
          },
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      shipping_address_collection: { allowed_countries: ['ES', 'FR'] },
      custom_fields: [
        {
          key: 'engraving',
          label: { type: 'custom' as const, custom: 'Engraving' },
          type: 'text' as const,
        },
      ],
      success_url: 'https://merchant.example/thanks?session={CHECKOUT_SESSION_ID}',
    };
    const session = await checkout.sessions.create(params);

    expect(session.id).toBe('cs_1');
    expect(session.payment_intent).toBeNull();
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions`);
    // No key passed: the client mints one, so its own retry cannot run twice.
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(call?.body ?? '{}')).toEqual(params);
  });

  test('create() sends options.idempotencyKey as the Idempotency-Key header', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: { id: 'cs_1', object: 'checkout_session' } };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    await checkout.sessions.create(
      { line_items: [{ price: 'price_1', quantity: 1 }] },
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
    const checkout = resources(buildTestClient(fetchImpl)).checkout;
    const params = { line_items: [{ price: 'price_1', quantity: 1 }] };

    // The lost response is retried automatically, under the same key.
    const session = await checkout.sessions.create(params, { idempotencyKey: 'order-7' });

    expect(session.id).toBe('cs_1');
    expect(created).toBe(1);
    const keys = requests
      .filter((r) => !r.url.includes('/auth/service-token'))
      .map((r) => r.headers.get('Idempotency-Key'));
    expect(keys).toEqual(['order-7', 'order-7']);
  });

  test('a key reused with different parameters is a PeableIdempotencyError, never retried', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 400,
        json: {
          error: {
            type: 'idempotency_error',
            code: 'idempotency_error',
            message: 'Idempotency-Key reused with different parameters',
          },
        },
      };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    const failure = checkout.sessions.create(
      { line_items: [{ price: 'price_2', quantity: 1 }] },
      { idempotencyKey: 'order-42' },
    );

    await expect(failure).rejects.toBeInstanceOf(PeableIdempotencyError);
    await expect(failure).rejects.toMatchObject({ statusCode: 400, code: 'idempotency_error' });
    expect(requests.filter((r) => !r.url.includes('/auth/service-token'))).toHaveLength(1);
  });

  test('retrieve() GETs /v1/checkout_sessions/:id', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'cs_1', object: 'checkout_session' } };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    await checkout.sessions.retrieve('cs_1');

    expect(gatewayCallOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions/cs_1`);
  });

  test('list() sends the v2 filters', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 200,
        json: { object: 'list', data: [], has_more: false, url: '/v1/checkout_sessions' },
      };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    await checkout.sessions.list({
      payment_link: 'link_1',
      customer: 'cus_1',
      status: 'complete',
      payment_intent: 'pi_1',
      limit: 5,
    });

    const url = new URL(gatewayCallOf(requests)?.url ?? '');
    expect(url.pathname).toBe('/v1/checkout_sessions');
    expect(url.searchParams.get('payment_link')).toBe('link_1');
    expect(url.searchParams.get('customer')).toBe('cus_1');
    expect(url.searchParams.get('status')).toBe('complete');
    expect(url.searchParams.get('payment_intent')).toBe('pi_1');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  test('expire() POSTs /v1/checkout_sessions/:id/expire', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { ...checkoutSessionFixture, status: 'expired' } };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    const session = await checkout.sessions.expire('cs_fixture');

    expect(session.status).toBe('expired');
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions/cs_fixture/expire`);
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('listLineItems() pages /v1/checkout_sessions/:id/line_items with expand', async () => {
    const pages = [
      {
        object: 'list',
        data: [lineItemFixture],
        has_more: true,
        url: '/v1/checkout_sessions/cs_1/line_items',
      },
      {
        object: 'list',
        data: [{ ...lineItemFixture, id: 'li_2' }],
        has_more: false,
        url: '/v1/checkout_sessions/cs_1/line_items',
      },
    ];
    let page = 0;
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      const json = pages[page] ?? pages[1];
      page += 1;
      return { status: 200, json };
    });
    const checkout = resources(buildTestClient(fetchImpl)).checkout;

    const items = await checkout.sessions
      .listLineItems('cs_1', { expand: ['data.price'] })
      .autoPagingToArray({ limit: 10 });

    expect(items.map((item) => item.id)).toEqual(['li_fixture', 'li_2']);
    const calls = requests.filter((r) => !r.url.includes('/auth/service-token'));
    const first = new URL(calls[0]?.url ?? '');
    expect(first.pathname).toBe('/v1/checkout_sessions/cs_1/line_items');
    expect(first.searchParams.getAll('expand[]')).toEqual(['data.price']);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('starting_after')).toBe('li_fixture');
  });
});
