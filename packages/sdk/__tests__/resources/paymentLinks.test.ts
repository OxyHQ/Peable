import { describe, expect, test } from 'bun:test';
import { PaymentLinksResource } from '../../src/resources/paymentLinks';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function gatewayCallOf(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((r) => !r.url.includes('/auth/service-token'));
}

describe('PaymentLinksResource', () => {
  test('create() POSTs /v1/payment_links with the params body (no idempotency key)', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 201,
        json: {
          id: 'link_1',
          object: 'payment_link',
          amount: '100000',
          network: 'testnet',
          active: true,
          metadata: {},
          url: 'https://checkout.peable.to/l/link_1',
        },
      };
    });
    const resource = new PaymentLinksResource(buildTestClient(fetchImpl));

    const link = await resource.create({ amount: '100000', network: 'testnet' });

    expect(link.id).toBe('link_1');
    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links`);
    expect(call?.headers.get('Idempotency-Key')).toBeNull();
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount: '100000', network: 'testnet' });
  });

  test('retrieve() GETs /v1/payment_links/:id', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'link_1', object: 'payment_link' } };
    });
    const resource = new PaymentLinksResource(buildTestClient(fetchImpl));

    await resource.retrieve('link_1');

    expect(gatewayCallOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links/link_1`);
  });

  test('list() GETs /v1/payment_links with limit/starting_after', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { object: 'list', data: [], has_more: false } };
    });
    const resource = new PaymentLinksResource(buildTestClient(fetchImpl));

    await resource.list({ limit: 20, starting_after: 'link_0' });

    const url = new URL(gatewayCallOf(requests)?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_links');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('starting_after')).toBe('link_0');
  });

  test('update() PATCHes /v1/payment_links/:id with only the whitelisted fields given', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'link_1', object: 'payment_link', active: false } };
    });
    const resource = new PaymentLinksResource(buildTestClient(fetchImpl));

    await resource.update('link_1', { active: false });

    const call = gatewayCallOf(requests);
    expect(call?.method).toBe('PATCH');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links/link_1`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ active: false });
  });
});
