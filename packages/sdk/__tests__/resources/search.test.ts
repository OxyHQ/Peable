/**
 * Search (Stripe's Search API): every searchable resource answers
 * `GET /v1/<resource>/search` with the query, limit, page and `expand[]`
 * encoded the way the gateway reads them, and auto-pagination follows
 * `next_page` — with the SAME query — until it is `null`.
 */
import { describe, expect, test } from 'bun:test';
import type { SearchResult } from '@peable.to/shared-types';
import { Peable } from '../../src';
import { PeableApiError } from '../../src/core/errors';
import { ChargesResource } from '../../src/resources/charges';
import { CustomersResource } from '../../src/resources/customers';
import { PaymentIntentsResource } from '../../src/resources/paymentIntents';
import { PricesResource, ProductsResource } from '../../src/resources/catalog';
import { RefundsResource } from '../../src/resources/refunds';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import { buildTestClient, serviceTokenMintResponse } from '../support/testGateway';

function result<T>(data: T[], next_page: string | null, url = '/v1/customers/search') {
  const page: SearchResult<T> = {
    object: 'search_result',
    data,
    has_more: next_page !== null,
    next_page,
    url,
  };
  return page;
}

function callsOf(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter((r) => !r.url.includes('/auth/service-token'));
}

function queryOf(request: CapturedRequest): URLSearchParams {
  return new URL(request.url).searchParams;
}

describe('search', () => {
  test('every searchable resource calls its own search path', async () => {
    const mock = createMockFetch((req) =>
      req.url.includes('/auth/service-token')
        ? serviceTokenMintResponse()
        : { status: 200, json: result([], null) },
    );
    const client = buildTestClient(mock.fetch);
    const params = { query: 'created>0' };
    await new PaymentIntentsResource(client).search(params);
    await new ChargesResource(client).search(params);
    await new CustomersResource(client).search(params);
    await new ProductsResource(client).search(params);
    await new PricesResource(client).search(params);
    await new RefundsResource(client).search(params);
    expect(callsOf(mock.requests).map((r) => new URL(r.url).pathname)).toEqual([
      '/v1/payment_intents/search',
      '/v1/charges/search',
      '/v1/customers/search',
      '/v1/products/search',
      '/v1/prices/search',
      '/v1/refunds/search',
    ]);
  });

  test('encodes query, limit, page and expand[]', async () => {
    const mock = createMockFetch((req) =>
      req.url.includes('/auth/service-token')
        ? serviceTokenMintResponse()
        : { status: 200, json: result([], null) },
    );
    const query = `email:"jenny@example.com" AND metadata['order']:'6735'`;
    await new CustomersResource(buildTestClient(mock.fetch)).search({
      query,
      limit: 3,
      page: 'tok_1',
      expand: ['total_count', 'data.default_price'],
    });
    const [call] = callsOf(mock.requests);
    if (!call) throw new Error('no call');
    const sent = queryOf(call);
    expect(call.method).toBe('GET');
    expect(sent.get('query')).toBe(query);
    expect(sent.get('limit')).toBe('3');
    expect(sent.get('page')).toBe('tok_1');
    expect(sent.getAll('expand[]')).toEqual(['total_count', 'data.default_price']);
  });

  test('auto-pagination follows next_page with the same query, and stops at null', async () => {
    const pages: Record<string, SearchResult<{ id: string }>> = {
      first: result([{ id: 'cus_1' }, { id: 'cus_2' }], 'tok_a'),
      tok_a: result([{ id: 'cus_3' }], 'tok_b'),
      tok_b: result([{ id: 'cus_4' }], null),
    };
    const mock = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      const page = queryOf(req).get('page') ?? 'first';
      return { status: 200, json: pages[page] };
    });
    const customers = new CustomersResource(buildTestClient(mock.fetch));
    const all = await customers.search({ query: 'name~"jen"', limit: 2 }).autoPagingToArray({
      limit: 100,
    });
    expect(all.map((c) => c.id)).toEqual(['cus_1', 'cus_2', 'cus_3', 'cus_4']);
    const calls = callsOf(mock.requests);
    expect(calls.map((r) => queryOf(r).get('page'))).toEqual([null, 'tok_a', 'tok_b']);
    expect(new Set(calls.map((r) => queryOf(r).get('query')))).toEqual(new Set(['name~"jen"']));
    expect(new Set(calls.map((r) => queryOf(r).get('limit')))).toEqual(new Set(['2']));
  });

  test('the first page is the promise itself', async () => {
    const mock = createMockFetch((req) =>
      req.url.includes('/auth/service-token')
        ? serviceTokenMintResponse()
        : { status: 200, json: { ...result([{ id: 'pi_1' }], null), total_count: 1 } },
    );
    const page = await new PaymentIntentsResource(buildTestClient(mock.fetch)).search({
      query: 'status:"succeeded"',
      expand: ['total_count'],
    });
    expect(page.object).toBe('search_result');
    expect(page.total_count).toBe(1);
    expect(page.next_page).toBeNull();
  });

  test('a gateway repeating a next_page is an error, not an endless walk', async () => {
    const mock = createMockFetch((req) =>
      req.url.includes('/auth/service-token')
        ? serviceTokenMintResponse()
        : { status: 200, json: result([{ id: 'ch_1' }], 'tok_same') },
    );
    const charges = new ChargesResource(buildTestClient(mock.fetch));
    await expect(
      charges.search({ query: 'refunded:true' }).autoPagingToArray({ limit: 100 }),
    ).rejects.toBeInstanceOf(PeableApiError);
  });

  test('is wired on the client', () => {
    const peable = new Peable({ publicKey: 'oxy_dk_test', secret: 'sk_test' });
    for (const resource of [
      peable.paymentIntents,
      peable.charges,
      peable.customers,
      peable.products,
      peable.prices,
      peable.refunds,
    ]) {
      expect(typeof resource.search).toBe('function');
    }
  });
});
