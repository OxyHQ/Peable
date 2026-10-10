/**
 * Resolve display identity for the wallet's own transaction addresses (spec
 * §4.8) — batched and cached via React Query. Enrichment is display-only: a
 * failed request never surfaces as an error, callers just render raw
 * address + amount for whichever entries are missing from the returned map.
 */
import { useQuery } from '@tanstack/react-query';
import type { EnrichmentResult } from '@peable.to/shared-types';
import { enrichAddresses } from '../services/gateway-client';

/** Mirrors the backend's `ENRICH_MAX_ADDRESSES` cap. */
const MAX_ENRICH_BATCH = 50;
const ENRICHMENT_STALE_TIME_MS = 5 * 60 * 1000;

export function useTransactionEnrichment(addresses: string[]): Record<string, EnrichmentResult> {
  const uniqueAddresses = [...new Set(addresses)].sort().slice(0, MAX_ENRICH_BATCH);

  const { data } = useQuery({
    queryKey: ['transactionEnrichment', uniqueAddresses],
    queryFn: () => enrichAddresses(uniqueAddresses),
    enabled: uniqueAddresses.length > 0,
    staleTime: ENRICHMENT_STALE_TIME_MS,
    // Display-only (spec §4.8) — a failed lookup must never surface as an
    // error state; render raw address + amount instead.
    throwOnError: false,
  });

  return data ?? {};
}
