/**
 * Tests for the market service's Zod-validated fetchers.
 *
 * These drive {@link fetchPriceHistory} / {@link fetchNetworkStats} against a
 * mocked `fetch`, proving:
 *   - a well-formed response is parsed and normalized (wire → app shape);
 *   - unknown extra fields are ignored, not rejected;
 *   - samples with an unparseable timestamp are dropped, not fatal;
 *   - a non-OK response throws (so React Query keeps the last good value);
 *   - a payload the schema rejects throws.
 */

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { fetchPriceHistory, fetchNetworkStats } from './market';

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

describe('fetchPriceHistory', () => {
  test('parses and normalizes samples oldest→newest', async () => {
    mockFetchOnce(200, {
      history: [
        { price_usd: 1.25, timestamp: '2026-07-15T00:00:00.000Z' },
        { price_usd: 1.5, timestamp: '2026-07-16T00:00:00.000Z' },
      ],
    });

    const points = await fetchPriceHistory('mainnet');

    expect(points).toEqual([
      { priceUsd: 1.25, timestamp: Date.parse('2026-07-15T00:00:00.000Z') },
      { priceUsd: 1.5, timestamp: Date.parse('2026-07-16T00:00:00.000Z') },
    ]);
  });

  test('drops samples with an unparseable timestamp', async () => {
    mockFetchOnce(200, {
      history: [
        { price_usd: 1.0, timestamp: 'not-a-date' },
        { price_usd: 2.0, timestamp: '2026-07-16T00:00:00.000Z' },
      ],
    });

    const points = await fetchPriceHistory('mainnet');

    expect(points).toEqual([{ priceUsd: 2.0, timestamp: Date.parse('2026-07-16T00:00:00.000Z') }]);
  });

  test('throws on a non-OK response', async () => {
    mockFetchOnce(500, { history: [] });
    await expect(fetchPriceHistory('mainnet')).rejects.toThrow();
  });

  test('throws when a sample fails the schema', async () => {
    mockFetchOnce(200, {
      history: [{ price_usd: 'nope', timestamp: '2026-07-16T00:00:00.000Z' }],
    });
    await expect(fetchPriceHistory('mainnet')).rejects.toThrow();
  });
});

describe('fetchNetworkStats', () => {
  test('parses the three rendered fields and ignores extras', async () => {
    mockFetchOnce(200, {
      stats: {
        blockHeight: 123456,
        masternodeCount: 42,
        circulatingSupply: 53000000,
        connections: 8,
        difficulty: 1234.5,
      },
    });

    const stats = await fetchNetworkStats('mainnet');

    expect(stats).toEqual({
      blockHeight: 123456,
      masternodeCount: 42,
      circulatingSupply: 53000000,
    });
  });

  test('throws on a non-OK response', async () => {
    mockFetchOnce(503, { stats: null });
    await expect(fetchNetworkStats('mainnet')).rejects.toThrow();
  });

  test('throws when a required field is missing', async () => {
    mockFetchOnce(200, {
      stats: { blockHeight: 1, masternodeCount: 2 },
    });
    await expect(fetchNetworkStats('mainnet')).rejects.toThrow();
  });
});
