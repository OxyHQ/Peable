/**
 * Market service for FairCoin wallet.
 * Fetches the FAIR price history (for the home sparkline) and live network
 * stats (block height, masternode count, circulating supply) from the Explorer
 * API. Responses are validated with Zod, and the exported types are inferred
 * from those schemas so the parsed shape and the TypeScript type can never
 * drift apart.
 *
 * These are thin, *throwing* fetchers: caching, de-duplication, and the
 * "keep the last good value on error" behaviour are owned by TanStack Query
 * (see `hooks/useMarketData.ts`), not this module. A non-OK response or a
 * payload the schema rejects throws, which React Query surfaces as a query
 * error while it continues to serve the last successful data.
 */

import { z } from 'zod';
import { EXPLORER_BASE_URL, type NetworkType } from '@fairco.in/core';

const EXPLORER_API = EXPLORER_BASE_URL;

// GET /api/price/history → { history: [{ price_usd, timestamp }] }. Each raw
// sample is normalized to the app's { priceUsd, timestamp(ms) } shape at parse
// time so callers never touch the wire format.
const priceHistoryPointSchema = z
  .object({
    price_usd: z.number(),
    timestamp: z.string(),
  })
  .transform((raw) => ({
    priceUsd: raw.price_usd,
    timestamp: new Date(raw.timestamp).getTime(),
  }));

const priceHistoryResponseSchema = z.object({
  history: z.array(priceHistoryPointSchema),
});

/** A single sampled FAIR/USD price point, normalized from the Explorer wire shape. */
export type PriceHistoryPoint = z.infer<typeof priceHistoryPointSchema>;

// GET /api/stats → { stats: { blockHeight, masternodeCount, circulatingSupply, … } }.
// Extra fields are ignored; the three we render must be present numbers.
const networkStatsSchema = z.object({
  blockHeight: z.number(),
  masternodeCount: z.number(),
  circulatingSupply: z.number(),
});

const networkStatsResponseSchema = z.object({
  stats: networkStatsSchema,
});

/** Live network snapshot from `GET /api/stats`. */
export type NetworkStats = z.infer<typeof networkStatsSchema>;

/**
 * Fetch the FAIR price history (default 7 days), oldest→newest. Throws on a
 * non-OK response or a payload the schema rejects. Samples whose timestamp
 * doesn't parse to a finite epoch are dropped rather than failing the series.
 */
export async function fetchPriceHistory(
  network: NetworkType,
  period = '7d',
): Promise<PriceHistoryPoint[]> {
  const response = await fetch(
    `${EXPLORER_API}/api/price/history?period=${encodeURIComponent(period)}&network=${network}`,
  );
  if (!response.ok) {
    throw new Error(`price history request failed: ${response.status}`);
  }
  const { history } = priceHistoryResponseSchema.parse(await response.json());
  return history.filter((point) => Number.isFinite(point.timestamp));
}

/**
 * Fetch the live network stats. Throws on a non-OK response or a payload the
 * schema rejects.
 */
export async function fetchNetworkStats(network: NetworkType): Promise<NetworkStats> {
  const response = await fetch(`${EXPLORER_API}/api/stats?network=${network}`);
  if (!response.ok) {
    throw new Error(`network stats request failed: ${response.status}`);
  }
  const { stats } = networkStatsResponseSchema.parse(await response.json());
  return stats;
}
