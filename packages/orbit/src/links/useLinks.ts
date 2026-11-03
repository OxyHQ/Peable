import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PaymentLink } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const LINKS_PAGE_SIZE = 25;

/** `true` active, `false` deactivated, `null` both. */
export type LinkFilter = boolean | null;

/** Every link key starts with the scope, so a mode switch never shows the other mode's links. */
export const linkKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'links'],
  list: (scope: DashboardScope, active: LinkFilter) => [
    ...linkKeys.all(scope),
    'list',
    active === null ? 'all' : active ? 'active' : 'inactive',
  ],
  link: (scope: DashboardScope, id: string) => [...linkKeys.all(scope), 'link', id],
};

export function useLinkPages(scope: DashboardScope, active: LinkFilter) {
  return useInfiniteQuery({
    queryKey: linkKeys.list(scope, active),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.paymentLinks.list(scope, {
        limit: LINKS_PAGE_SIZE,
        ...(active === null ? {} : { active }),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<PaymentLink>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
}

export function useLink(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: linkKeys.link(scope, id),
    queryFn: () => dashboardApi.paymentLinks.retrieve(scope, id),
  });
}
