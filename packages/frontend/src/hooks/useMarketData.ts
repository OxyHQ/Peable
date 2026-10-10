/**
 * TanStack Query hooks for the Explorer market data.
 *
 * These own caching, de-duplication, and background refetch for the FAIR price
 * history and the live network stats. The Explorer realtime socket pushes fresh
 * block heights straight into the `["networkStats", network]` cache (see
 * `explorer-socket.ts`), so the network section ticks live off the WebSocket;
 * the poll interval below is only a fallback for when the socket is down.
 *
 * Both queries are keyed by network so switching mainnet/testnet never shows the
 * other network's data, and each network keeps its own cached last-good value.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { NetworkType } from '@fairco.in/core';
import {
  fetchPriceHistory,
  fetchNetworkStats,
  type PriceHistoryPoint,
  type NetworkStats,
} from '../services/market';

/** Fallback poll cadence; realtime WS pushes keep stats fresher than this. */
const MARKET_REFETCH_INTERVAL_MS = 60_000;

/** FAIR/USD price history for `network` (oldest→newest), refreshed while observed. */
export function usePriceHistory(network: NetworkType): UseQueryResult<PriceHistoryPoint[], Error> {
  return useQuery({
    queryKey: ['priceHistory', network],
    queryFn: () => fetchPriceHistory(network),
    refetchInterval: MARKET_REFETCH_INTERVAL_MS,
  });
}

/** Live network stats for `network`; driven by the realtime socket + poll fallback. */
export function useNetworkStats(network: NetworkType): UseQueryResult<NetworkStats, Error> {
  return useQuery({
    queryKey: ['networkStats', network],
    queryFn: () => fetchNetworkStats(network),
    refetchInterval: MARKET_REFETCH_INTERVAL_MS,
  });
}
