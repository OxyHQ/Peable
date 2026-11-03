import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const PAYMENTS_PAGE_SIZE = 25;

/** Every key Orbit caches payment data under starts with the scope, so a mode switch never shows the other mode's rows. */
export const paymentKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'payments'],
  list: (scope: DashboardScope, status: PaymentIntentStatus | null, limit: number) => [
    ...paymentKeys.all(scope),
    'list',
    status ?? 'all',
    limit,
  ],
  detail: (scope: DashboardScope, id: string) => [...paymentKeys.all(scope), 'detail', id],
};

/** A list paged by `starting_after` = the last id of the page before, while `has_more`. */
export function usePaymentPages(
  scope: DashboardScope,
  status: PaymentIntentStatus | null,
  limit = PAYMENTS_PAGE_SIZE,
) {
  return useInfiniteQuery({
    queryKey: paymentKeys.list(scope, status, limit),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.paymentIntents.list(scope, {
        limit,
        ...(status ? { status } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<PaymentIntent>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
}

export function usePayment(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: paymentKeys.detail(scope, id),
    queryFn: () => dashboardApi.paymentIntents.retrieve(scope, id),
  });
}
