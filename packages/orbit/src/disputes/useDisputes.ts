import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Dispute } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const DISPUTES_PAGE_SIZE = 25;

/**
 * Scoped like every Orbit key, so a mode switch never shows the other mode's
 * disputes. The key carries ids only: evidence lives in the cached detail and
 * nowhere else in Orbit (no key, no log, no toast).
 */
export const disputeKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'disputes'],
  list: (scope: DashboardScope, limit: number) => [...disputeKeys.all(scope), 'list', limit],
  detail: (scope: DashboardScope, id: string) => [...disputeKeys.all(scope), 'detail', id],
};

export function useDisputePages(scope: DashboardScope, limit = DISPUTES_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: disputeKeys.list(scope, limit),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.disputes.list(scope, {
        limit,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<Dispute>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
}

export function useDispute(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: disputeKeys.detail(scope, id),
    queryFn: () => dashboardApi.disputes.retrieve(scope, id),
  });
}
