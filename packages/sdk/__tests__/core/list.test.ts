import { describe, expect, test } from 'bun:test';
import { resources } from '../support/testGateway';
import { encodeQuery } from '../../src/core/list';
import { createMockFetch } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

/** Five fake intents, newest first, as the gateway would order them. */
const ALL = ['pi_5', 'pi_4', 'pi_3', 'pi_2', 'pi_1'];

/**
 * A gateway that pages `ALL` exactly as `db/keyset.ts` does: forward from
 * `starting_after`, backward (still newest first) from `ending_before`.
 */
function pagingGateway() {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const after = url.searchParams.get('starting_after');
    const before = url.searchParams.get('ending_before');
    let data: string[];
    let hasMore: boolean;
    if (before !== null) {
      const newer = ALL.slice(0, ALL.indexOf(before));
      data = newer.slice(-limit);
      hasMore = newer.length > limit;
    } else {
      const older = after === null ? ALL : ALL.slice(ALL.indexOf(after) + 1);
      data = older.slice(0, limit);
      hasMore = older.length > limit;
    }
    return {
      status: 200,
      json: {
        object: 'list',
        data: data.map((id) => ({ id, object: 'payment_intent' })),
        has_more: hasMore,
        url: url.pathname,
      },
    };
  });
}

describe('encodeQuery', () => {
  test('arrays as key[]=v, objects as key[sub]=v, absent values omitted', () => {
    const query = encodeQuery({
      limit: 5,
      expand: ['data.payment_intent', 'data.connected_account'],
      created: { gte: 100, lt: undefined, lte: 200 },
      starting_after: undefined,
      status: null,
    });
    expect(decodeURIComponent(query)).toBe(
      'limit=5&expand[]=data.payment_intent&expand[]=data.connected_account&created[gte]=100&created[lte]=200',
    );
  });
});

describe('list() auto-pagination', () => {
  test('awaiting list() is one page', async () => {
    const { fetch, requests } = pagingGateway();
    const page = await resources(buildTestClient(fetch)).paymentIntents.list({ limit: 2 });
    expect(page.data.map((row) => row.id)).toEqual(['pi_5', 'pi_4']);
    expect(page.has_more).toBe(true);
    expect(page.url).toBe('/v1/payment_intents');
    expect(requests.filter((r) => r.url.startsWith(TEST_GATEWAY_URL))).toHaveLength(1);
  });

  test('for await walks every page forward with starting_after', async () => {
    const { fetch, requests } = pagingGateway();
    const ids: string[] = [];
    for await (const intent of resources(buildTestClient(fetch)).paymentIntents.list({
      limit: 2,
    })) {
      ids.push(intent.id);
    }
    expect(ids).toEqual(ALL);
    const cursors = requests
      .filter((r) => r.url.startsWith(TEST_GATEWAY_URL))
      .map((r) => new URL(r.url).searchParams.get('starting_after'));
    expect(cursors).toEqual([null, 'pi_4', 'pi_2']);
  });

  test('from ending_before it walks backwards, moving away from the cursor', async () => {
    const { fetch, requests } = pagingGateway();
    const ids: string[] = [];
    const list = resources(buildTestClient(fetch)).paymentIntents.list({
      limit: 2,
      ending_before: 'pi_1',
    });
    for await (const intent of list) ids.push(intent.id);
    expect(ids).toEqual(['pi_2', 'pi_3', 'pi_4', 'pi_5']);
    const gatewayCalls = requests.filter((r) => r.url.startsWith(TEST_GATEWAY_URL));
    expect(gatewayCalls.map((r) => new URL(r.url).searchParams.get('ending_before'))).toEqual([
      'pi_1',
      'pi_3',
    ]);
    expect(gatewayCalls.every((r) => !new URL(r.url).searchParams.has('starting_after'))).toBe(
      true,
    );
  });

  test('autoPagingToArray stops at limit without fetching further pages', async () => {
    const { fetch, requests } = pagingGateway();
    const ids = await resources(buildTestClient(fetch))
      .paymentIntents.list({ limit: 2 })
      .autoPagingToArray({ limit: 3 });
    expect(ids.map((row) => row.id)).toEqual(['pi_5', 'pi_4', 'pi_3']);
    expect(requests.filter((r) => r.url.startsWith(TEST_GATEWAY_URL))).toHaveLength(2);
  });

  test('autoPagingToArray requires a bounded limit', async () => {
    const { fetch } = pagingGateway();
    const list = resources(buildTestClient(fetch)).paymentIntents.list();
    await expect(list.autoPagingToArray({ limit: 0 })).rejects.toThrow(TypeError);
    await expect(list.autoPagingToArray({ limit: 10_001 })).rejects.toThrow(TypeError);
  });

  test('autoPagingEach stops when the callback returns false', async () => {
    const { fetch } = pagingGateway();
    const seen: string[] = [];
    await resources(buildTestClient(fetch))
      .paymentIntents.list({ limit: 2 })
      .autoPagingEach((intent) => {
        seen.push(intent.id);
        return seen.length < 3;
      });
    expect(seen).toEqual(['pi_5', 'pi_4', 'pi_3']);
  });
});

describe('expand, filters and updates on the wire', () => {
  test('list sends created ranges, filters and expand[]', async () => {
    const { fetch, requests } = pagingGateway();
    await resources(buildTestClient(fetch)).paymentIntents.list({
      status: 'succeeded',
      created: { gte: 1_800_000_000 },
      expand: ['data.connected_account'],
    });
    const url = new URL(requests.filter((r) => r.url.startsWith(TEST_GATEWAY_URL))[0]?.url ?? '');
    expect(url.searchParams.get('status')).toBe('succeeded');
    expect(url.searchParams.get('created[gte]')).toBe('1800000000');
    expect(url.searchParams.getAll('expand[]')).toEqual(['data.connected_account']);
  });

  test('retrieve sends expand[]; update POSTs metadata', async () => {
    const { fetch, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'pi_1', object: 'payment_intent' } };
    });
    const intents = resources(buildTestClient(fetch)).paymentIntents;
    await intents.retrieve('pi_1', { expand: ['connected_account'] });
    await intents.update('pi_1', { metadata: { order: '' } });
    const calls = requests.filter((r) => r.url.startsWith(TEST_GATEWAY_URL));
    expect(new URL(calls[0]?.url ?? '').searchParams.getAll('expand[]')).toEqual([
      'connected_account',
    ]);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1`);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ metadata: { order: '' } });
  });

  test("a payment's refund list keeps remaining_refundable beside the envelope", async () => {
    const { fetch } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 200,
        json: { object: 'list', data: [], has_more: false, url: '/x', remaining_refundable: '42' },
      };
    });
    const page = await resources(buildTestClient(fetch)).refunds.listForPaymentIntent('pi_1');
    expect(page.remaining_refundable).toBe('42');
  });

  test('payment links filter by active', async () => {
    const { fetch, requests } = pagingGateway();
    await resources(buildTestClient(fetch)).paymentLinks.list({ active: false });
    const url = new URL(requests.filter((r) => r.url.startsWith(TEST_GATEWAY_URL))[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_links');
    expect(url.searchParams.get('active')).toBe('false');
  });
});
