import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PaymentIntent, TerminalReader } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';
import { paymentKeys } from '../payments/usePayments';
import { isCollecting, PAYMENT_POLL_LIMIT, READER_POLL_MS } from './terminalForm';

/**
 * Terminal's queries (ADR 0024), keyed by the scope: a mode switch never shows
 * the other mode's locations or readers, and invalidating `terminalKeys.all`
 * after a write refreshes every list and reader.
 */
export const terminalKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'terminal'],
  locations: (scope: DashboardScope) => [...terminalKeys.all(scope), 'locations'],
  locationOptions: (scope: DashboardScope) => [...terminalKeys.all(scope), 'location-options'],
  readers: (scope: DashboardScope) => [...terminalKeys.all(scope), 'readers'],
  reader: (scope: DashboardScope, id: string) => [...terminalKeys.all(scope), 'reader', id],
};

export const TERMINAL_PAGE_SIZE = 25;
/** Every location a merchant has, for the reader form's picker and the readers' location names. */
export const LOCATION_OPTIONS_LIMIT = 100;

const nextCursor = <T extends { id: string }>(last: ListPage<T>) =>
  last.has_more ? last.data[last.data.length - 1]?.id : undefined;

export function useLocationPages(scope: DashboardScope) {
  return useInfiniteQuery({
    queryKey: terminalKeys.locations(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.terminal.locations.list(scope, {
        limit: TERMINAL_PAGE_SIZE,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

/** The first hundred locations: the reader form's choices and the names the readers table shows. */
export function useLocationOptions(scope: DashboardScope) {
  return useQuery({
    queryKey: terminalKeys.locationOptions(scope),
    queryFn: async () =>
      (await dashboardApi.terminal.locations.list(scope, { limit: LOCATION_OPTIONS_LIMIT })).data,
  });
}

export function useReaderPages(scope: DashboardScope) {
  return useInfiniteQuery({
    queryKey: terminalKeys.readers(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.terminal.readers.list(scope, {
        limit: TERMINAL_PAGE_SIZE,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

/**
 * One reader, reconciled with the provider by the gateway — asked again every
 * two seconds while it is collecting, so the page follows the card.
 */
export function useReader(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: terminalKeys.reader(scope, id),
    queryFn: () => dashboardApi.terminal.readers.retrieve(scope, id),
    refetchInterval: (query) => {
      const reader = query.state.data as TerminalReader | undefined;
      return reader && isCollecting(reader) ? READER_POLL_MS : false;
    },
  });
}

/**
 * The payment a reader collected. While `settling` (the reader finished, the
 * payment's own outcome not yet arrived) it is asked again every two seconds,
 * at most `PAYMENT_POLL_LIMIT` times.
 */
export function useCollectedPayment(
  scope: DashboardScope,
  id: string | null,
  settling: (intent: PaymentIntent | undefined) => boolean,
) {
  return useQuery({
    queryKey: paymentKeys.detail(scope, id ?? ''),
    queryFn: () => dashboardApi.paymentIntents.retrieve(scope, id ?? ''),
    enabled: id !== null,
    refetchInterval: (query) =>
      settling(query.state.data as PaymentIntent | undefined) &&
      query.state.dataUpdateCount < PAYMENT_POLL_LIMIT
        ? READER_POLL_MS
        : false,
  });
}
