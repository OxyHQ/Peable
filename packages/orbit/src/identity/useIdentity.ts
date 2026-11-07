import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { VerificationSessionStatus } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

/**
 * Identity verification's queries (ADR 0023), keyed by the scope: a mode
 * switch never shows the other mode's sessions, and invalidating
 * `identityKeys.all` after a write refreshes the list, the session and its
 * attempts.
 */
export const identityKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'identity'],
  list: (scope: DashboardScope, filter: string) => [...identityKeys.all(scope), 'sessions', filter],
  session: (scope: DashboardScope, id: string) => [...identityKeys.all(scope), 'session', id],
  reports: (scope: DashboardScope, id: string) => [...identityKeys.all(scope), 'reports', id],
};

export const IDENTITY_PAGE_SIZE = 25;

const nextCursor = <T extends { id: string }>(last: ListPage<T>) =>
  last.has_more ? last.data[last.data.length - 1]?.id : undefined;

export function useVerificationSessionPages(
  scope: DashboardScope,
  status: VerificationSessionStatus | null,
) {
  return useInfiniteQuery({
    queryKey: identityKeys.list(scope, status ?? 'all'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.identity.sessions.list(scope, {
        limit: IDENTITY_PAGE_SIZE,
        ...(status ? { status } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

/** One session, reconciled with the provider by the gateway (and carrying its link while open). */
export function useVerificationSession(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: identityKeys.session(scope, id),
    queryFn: () => dashboardApi.identity.sessions.retrieve(scope, id),
  });
}

/** A session's attempts, newest first: each check's outcome, nothing the person submitted. */
export function useVerificationReports(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: identityKeys.reports(scope, id),
    queryFn: async () => (await dashboardApi.identity.reports.list(scope, id)).data,
  });
}
