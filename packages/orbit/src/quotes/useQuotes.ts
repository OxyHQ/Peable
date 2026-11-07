import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { QuoteStatus } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';
import { BILLING_PAGE_SIZE, billingKeys } from '../billing/useBilling';

/**
 * Quotes' queries (ADR 0018 §5), under the billing scope's keys: a mode switch
 * never shows the other mode's quotes, and invalidating `billingKeys.all`
 * after an acceptance refreshes the invoices and subscriptions it made too.
 */
export const quoteKeys = {
  list: (scope: DashboardScope, filter: string, customer?: string) => [
    ...billingKeys.all(scope),
    'quotes',
    filter,
    customer ?? '',
  ],
  quote: (scope: DashboardScope, id: string) => [...billingKeys.all(scope), 'quote', id],
};

const nextCursor = <T extends { id: string }>(last: ListPage<T>) =>
  last.has_more ? last.data[last.data.length - 1]?.id : undefined;

export function useQuotePages(
  scope: DashboardScope,
  status: QuoteStatus | null,
  customer?: string,
) {
  return useInfiniteQuery({
    queryKey: quoteKeys.list(scope, status ?? 'all', customer),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.quotes.list(scope, {
        limit: BILLING_PAGE_SIZE,
        ...(status ? { status } : {}),
        ...(customer ? { customer } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

/** A quote and its lines (each with its Price expanded), read together. */
export function useQuote(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: quoteKeys.quote(scope, id),
    queryFn: async () => {
      const [quote, lines] = await Promise.all([
        dashboardApi.quotes.retrieve(scope, id),
        dashboardApi.quotes.lineItems(scope, id),
      ]);
      return { quote, lines: lines.data };
    },
  });
}
