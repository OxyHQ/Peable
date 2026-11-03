import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { usePagedList } from '../ui/paging';

export const CONNECT_PAGE_SIZE = 25;

/**
 * Every Connect key starts with the scope, so a mode switch never shows the
 * other mode's sellers, and with `connect`, so one write can refresh them all.
 */
export const connectKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'connect'],
  sellers: (scope: DashboardScope) => [...connectKeys.all(scope), 'sellers'],
  seller: (scope: DashboardScope, id: string) => [...connectKeys.all(scope), 'seller', id],
  transfers: (scope: DashboardScope, seller: string | null) => [
    ...connectKeys.all(scope),
    'transfers',
    seller ?? 'all',
  ],
  reversals: (scope: DashboardScope, transferId: string) => [
    ...connectKeys.all(scope),
    'reversals',
    transferId,
  ],
};

export function useSellerPages(scope: DashboardScope) {
  return usePagedList(connectKeys.sellers(scope), (startingAfter) =>
    dashboardApi.connectedAccounts.list(scope, {
      limit: CONNECT_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
  );
}

export function useSeller(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: connectKeys.seller(scope, id),
    queryFn: () => dashboardApi.connectedAccounts.retrieve(scope, id),
  });
}

/** Every settlement, or one seller's (`ca_…`). */
export function useTransferPages(scope: DashboardScope, seller: string | null) {
  return usePagedList(connectKeys.transfers(scope, seller), (startingAfter) =>
    dashboardApi.transfers.list(scope, {
      limit: CONNECT_PAGE_SIZE,
      ...(seller ? { connected_account: seller } : {}),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
  );
}

/** A settlement's reversals, read only once someone opens them. */
export function useReversals(scope: DashboardScope, transferId: string, enabled: boolean) {
  return useQuery({
    queryKey: connectKeys.reversals(scope, transferId),
    queryFn: () => dashboardApi.transfers.reversals(scope, transferId),
    enabled,
  });
}
