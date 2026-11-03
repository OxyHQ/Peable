import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  BalanceTransaction,
  BalanceTransactionType,
  Payout,
  PayoutReconciliationReport,
  PayoutStatus,
} from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const MONEY_PAGE_SIZE = 25;
/** The gateway's maximum page: a payout's transactions and the open mismatches read in one go. */
export const MONEY_WIDE_PAGE = 100;

/**
 * Every money key starts with the scope, so a mode switch never shows the
 * other mode's figures, and with `money`, so one write can refresh them all.
 */
export const moneyKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'money'],
  account: (scope: DashboardScope) => [...moneyKeys.all(scope), 'account'],
  balance: (scope: DashboardScope) => [...moneyKeys.all(scope), 'balance'],
  transactions: (scope: DashboardScope, type: BalanceTransactionType | null) => [
    ...moneyKeys.all(scope),
    'balance_transactions',
    type ?? 'all',
  ],
  payouts: (scope: DashboardScope, status: PayoutStatus | null) => [
    ...moneyKeys.all(scope),
    'payouts',
    status ?? 'all',
  ],
  payout: (scope: DashboardScope, id: string) => [...moneyKeys.all(scope), 'payout', id],
  reconciliation: (scope: DashboardScope, payoutId: string) => [
    ...moneyKeys.all(scope),
    'payout_reconciliation',
    payoutId,
  ],
  mismatches: (scope: DashboardScope) => [...moneyKeys.all(scope), 'reconciliation_mismatches'],
};

const nextCursor = <T extends { id: string }>(last: ListPage<T>) =>
  last.has_more ? last.data[last.data.length - 1]?.id : undefined;

/** `null` data means the merchant has no fiat account in this mode. */
export function useAccount(scope: DashboardScope) {
  return useQuery({
    queryKey: moneyKeys.account(scope),
    queryFn: () => dashboardApi.account.retrieve(scope),
  });
}

/** `null` data means no fiat account — show that, never a zero balance. */
export function useBalance(scope: DashboardScope) {
  return useQuery({
    queryKey: moneyKeys.balance(scope),
    queryFn: () => dashboardApi.balance.retrieve(scope),
  });
}

export function useBalanceTransactionPages(
  scope: DashboardScope,
  type: BalanceTransactionType | null,
) {
  return useInfiniteQuery({
    queryKey: moneyKeys.transactions(scope, type),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.balanceTransactions.list(scope, {
        limit: MONEY_PAGE_SIZE,
        ...(type ? { type } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<BalanceTransaction>) => nextCursor(last),
  });
}

export function usePayoutPages(scope: DashboardScope, status: PayoutStatus | null) {
  return useInfiniteQuery({
    queryKey: moneyKeys.payouts(scope, status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.payouts.list(scope, {
        limit: MONEY_PAGE_SIZE,
        ...(status ? { status } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<Payout>) => nextCursor(last),
  });
}

export function usePayout(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: moneyKeys.payout(scope, id),
    queryFn: () => dashboardApi.payouts.retrieve(scope, id),
  });
}

/** The report, page by page; `summary` (on every page) already covers the whole payout. */
export function usePayoutReconciliation(scope: DashboardScope, payoutId: string) {
  return useInfiniteQuery({
    queryKey: moneyKeys.reconciliation(scope, payoutId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.reports.payoutReconciliation(scope, payoutId, {
        limit: MONEY_WIDE_PAGE,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: PayoutReconciliationReport) => nextCursor(last),
  });
}

/** The first wide page of mismatches; the screen shows the unresolved ones. */
export function useReconciliationMismatches(scope: DashboardScope) {
  return useQuery({
    queryKey: moneyKeys.mismatches(scope),
    queryFn: () => dashboardApi.reconciliationMismatches.list(scope, { limit: MONEY_WIDE_PAGE }),
  });
}
