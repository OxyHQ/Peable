/**
 * Tests for the FAIR price fetcher.
 *
 * The case that matters most is the FIRST one: the exact body
 * `https://explorer.fairco.in/api/price` returns today. The previous parser read
 * `data.price.usd` and `data.change_24h.usd`, neither of which the server has
 * ever sent; because `data.price` is a truthy number the `if (!data.price)`
 * guard never fired, so `usd` came out `undefined` and every fiat figure in the
 * app rendered as `NaN`. A test that asserts against a hand-written fixture of
 * the shape the code expects would have passed throughout — so the fixture here
 * is a real captured response, extra fields and all.
 *
 * `fetchPrice` deliberately never throws (it backs a `useSyncExternalStore`
 * snapshot, not a React Query fetcher), so every failure path is asserted as
 * "the last good quote survives" rather than as a rejection. The module-level
 * cache that makes that possible is shared across tests, so each test below
 * establishes the cache state it needs rather than relying on the file's order.
 */

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { fetchPrice, getCachedPrice, type PriceData } from './price';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

/**
 * A verbatim `GET /api/price` response, captured 2026-07-30.
 *
 * Every field is kept, including the four the app does not render, because the
 * bug being guarded against is a shape mismatch — trimming the fixture to what
 * the parser looks at would remove the evidence.
 */
const LIVE_PAYLOAD = {
  price: 0.4908275003129989,
  change24h: 0,
  volume24h: null,
  liquidityUsd: 2454.137501565,
  marketCapUsd: null,
  source: 'wfair-base',
  updatedAt: '2026-07-30T16:15:06.186Z',
} as const;

/** Put a known quote in the module cache and return it. */
async function primeCache(usd: number): Promise<PriceData> {
  mockFetchOnce(200, { ...LIVE_PAYLOAD, price: usd });
  const primed = await fetchPrice();
  if (primed === null) throw new Error('could not prime the price cache');
  return primed;
}

describe('fetchPrice', () => {
  test('parses the real explorer payload', async () => {
    mockFetchOnce(200, LIVE_PAYLOAD);

    const price = await fetchPrice();

    expect(price).not.toBeNull();
    // The assertion the old parser failed: a usable number, not `undefined`.
    expect(price?.usd).toBe(0.4908275003129989);
    expect(Number.isFinite(price?.usd)).toBe(true);
    expect(price?.timestamp).toBe(Date.parse('2026-07-30T16:15:06.186Z'));
  });

  test('a fiat conversion off the parsed price is a number, not NaN', async () => {
    mockFetchOnce(200, LIVE_PAYLOAD);

    const price = await fetchPrice();
    // What `AmountInput`, `SendSheet` and the home card each compute. This is
    // the symptom users actually saw, asserted directly rather than inferred
    // from the parse.
    const fiat = 2 * (price?.usd ?? Number.NaN);

    expect(Number.isNaN(fiat)).toBe(false);
    expect(fiat).toBeCloseTo(0.9816550006259978, 12);
  });

  test('keeps a zero change24h rather than turning it into null', async () => {
    mockFetchOnce(200, LIVE_PAYLOAD);

    const price = await fetchPrice();

    // FAIR's change is genuinely 0 right now, and 0 is a measurement. A
    // truthiness guard here would report "unknown" for a known value.
    expect(price?.change24h).toBe(0);
  });

  test('carries a real change24h through', async () => {
    mockFetchOnce(200, { ...LIVE_PAYLOAD, price: 1.5, change24h: -3.25 });

    const price = await fetchPrice();

    expect(price?.change24h).toBe(-3.25);
  });

  test('ignores unknown fields the server may add', async () => {
    mockFetchOnce(200, { ...LIVE_PAYLOAD, price: 2.5, someNewField: 'ignored' });

    const price = await fetchPrice();

    expect(price?.usd).toBe(2.5);
  });

  test('falls back to now when updatedAt is absent or unparseable', async () => {
    const before = Date.now();
    mockFetchOnce(200, { price: 3.5, change24h: null, updatedAt: 'not-a-date' });

    const price = await fetchPrice();

    expect(price?.usd).toBe(3.5);
    expect(price?.timestamp).toBeGreaterThanOrEqual(before);
  });

  test('keeps the last good quote when every source is down (price: null)', async () => {
    const primed = await primeCache(4.5);
    mockFetchOnce(200, { ...LIVE_PAYLOAD, price: null });

    const price = await fetchPrice();

    // Not zero, and not null — the documented all-sources-unavailable case must
    // not overwrite a good quote with a meaningless one.
    expect(price).toEqual(primed);
    expect(getCachedPrice()).toEqual(primed);
  });

  test('keeps the last good quote on a non-OK response', async () => {
    const primed = await primeCache(5.5);
    mockFetchOnce(500, {});

    expect(await fetchPrice()).toEqual(primed);
  });

  test('keeps the last good quote on a body it cannot read', async () => {
    const primed = await primeCache(6.5);
    // The OLD wire shape. If this were ever restored server-side the app should
    // hold its last quote rather than publish `undefined`.
    mockFetchOnce(200, { price: { usd: 7.5, eur: 7, btc: 0.0001 } });

    expect(await fetchPrice()).toEqual(primed);
  });

  test('keeps the last good quote when the network throws', async () => {
    const primed = await primeCache(8.5);
    globalThis.fetch = mock(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await fetchPrice()).toEqual(primed);
  });

  test('returns the same object identity when the quote has not moved', async () => {
    const primed = await primeCache(9.5);
    mockFetchOnce(200, {
      ...LIVE_PAYLOAD,
      price: 9.5,
      // A later observation of an unchanged quote.
      updatedAt: '2026-07-30T18:00:00.000Z',
    });

    const price = await fetchPrice();

    // Identity, not equality: `getCachedPrice` is a `useSyncExternalStore`
    // snapshot, so a fresh object every poll would re-render every subscriber
    // for a price that did not move.
    expect(price).toBe(primed);
  });
});
