import { describe, expect, test } from 'bun:test';
import { resources } from '../support/testGateway';
import { lineItemFixture, paymentLinkFixture } from '../support/checkoutFixture';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function gatewayCallOf(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((r) => !r.url.includes('/auth/service-token'));
}

describe('PaymentLinksResource (v2)', () => {
  test('create() POSTs line items over prices with the options, and a minted idempotency key', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: paymentLinkFixture };
    });
    const resource = resources(buildTestClient(fetchImpl)).paymentLinks;
    const params = {
      line_items: [
        {
          price: 'price_fixture',
          quantity: 2,
          adjustable_quantity: { enabled: true, maximum: 10 },
        },
      ],
      allow_promotion_codes: true,
      after_completion: {
        type: 'redirect' as const,
        redirect: { url: 'https://merchant.example/thanks?cs={CHECKOUT_SESSION_ID}' },
      },
      restrictions: { completed_sessions: { limit: 100 } },
    };

    const link = await resource.create(params);

    expect(link.id).toBe('link_fixture');
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links`);
    expect(call?.headers.get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(call?.body ?? '{}')).toEqual(params);
  });

  test('create() forwards an explicit idempotency key', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: paymentLinkFixture };
    });
    const resource = resources(buildTestClient(fetchImpl)).paymentLinks;

    await resource.create(
      { line_items: [{ price: 'price_fixture', quantity: 1 }] },
      { idempotencyKey: 'link-1' },
    );

    expect(gatewayCallOf(requests)?.headers.get('Idempotency-Key')).toBe('link-1');
  });

  test('retrieve() GETs /v1/payment_links/:id', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: paymentLinkFixture };
    });
    const resource = resources(buildTestClient(fetchImpl)).paymentLinks;

    await resource.retrieve('link_1');

    expect(gatewayCallOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links/link_1`);
  });

  test('list() GETs /v1/payment_links with active/limit/starting_after', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { object: 'list', data: [], has_more: false } };
    });
    const resource = resources(buildTestClient(fetchImpl)).paymentLinks;

    await resource.list({ limit: 20, starting_after: 'link_0', active: true });

    const url = new URL(gatewayCallOf(requests)?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_links');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('starting_after')).toBe('link_0');
    expect(url.searchParams.get('active')).toBe('true');
  });

  test('update() POSTs /v1/payment_links/:id with only the fields given', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { ...paymentLinkFixture, active: false } };
    });
    const resource = resources(buildTestClient(fetchImpl)).paymentLinks;

    await resource.update('link_1', { active: false, restrictions: '' });

    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links/link_1`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ active: false, restrictions: '' });
  });

  test('listLineItems() GETs /v1/payment_links/:id/line_items with expand', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 200,
        json: { object: 'list', data: [lineItemFixture], has_more: false, url: '' },
      };
    });
    const resource = resources(buildTestClient(fetchImpl)).paymentLinks;

    const page = await resource.listLineItems('link_1', { expand: ['data.price'] });

    expect(page.data[0]?.id).toBe('li_fixture');
    const url = new URL(gatewayCallOf(requests)?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_links/link_1/line_items');
    expect(url.searchParams.getAll('expand[]')).toEqual(['data.price']);
  });
});
