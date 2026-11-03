import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { InvoiceStatus, SubscriptionStatus } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const BILLING_PAGE_SIZE = 25;

/** Every billing key starts with the scope, so a mode switch never shows the other mode's rows. */
export const billingKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'billing'],
  customers: (scope: DashboardScope, email: string) => [
    ...billingKeys.all(scope),
    'customers',
    email,
  ],
  customer: (scope: DashboardScope, id: string) => [...billingKeys.all(scope), 'customer', id],
  subscriptions: (scope: DashboardScope, filter: string, customer?: string) => [
    ...billingKeys.all(scope),
    'subscriptions',
    filter,
    customer ?? '',
  ],
  subscription: (scope: DashboardScope, id: string) => [
    ...billingKeys.all(scope),
    'subscription',
    id,
  ],
  invoices: (scope: DashboardScope, filter: string, customer?: string) => [
    ...billingKeys.all(scope),
    'invoices',
    filter,
    customer ?? '',
  ],
  invoice: (scope: DashboardScope, id: string) => [...billingKeys.all(scope), 'invoice', id],
  settings: (scope: DashboardScope) => [...billingKeys.all(scope), 'settings'],
  features: (scope: DashboardScope) => [...billingKeys.all(scope), 'features'],
  productFeatures: (scope: DashboardScope, productId: string) => [
    ...billingKeys.all(scope),
    'productFeatures',
    productId,
  ],
};

const nextCursor = <T extends { id: string }>(last: ListPage<T>) =>
  last.has_more ? last.data[last.data.length - 1]?.id : undefined;

export function useCustomerPages(scope: DashboardScope, email: string) {
  return useInfiniteQuery({
    queryKey: billingKeys.customers(scope, email),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.customers.list(scope, {
        limit: BILLING_PAGE_SIZE,
        ...(email ? { email } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

/** `null` status: Stripe's default view (everything but cancelled); `all` includes them. */
export function useSubscriptionPages(
  scope: DashboardScope,
  status: SubscriptionStatus | 'all' | null,
  customer?: string,
) {
  return useInfiniteQuery({
    queryKey: billingKeys.subscriptions(scope, status ?? 'default', customer),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.subscriptions.list(scope, {
        limit: BILLING_PAGE_SIZE,
        ...(status ? { status } : {}),
        ...(customer ? { customer } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

export function useInvoicePages(
  scope: DashboardScope,
  status: InvoiceStatus | null,
  customer?: string,
) {
  return useInfiniteQuery({
    queryKey: billingKeys.invoices(scope, status ?? 'all', customer),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.invoices.list(scope, {
        limit: BILLING_PAGE_SIZE,
        ...(status ? { status } : {}),
        ...(customer ? { customer } : {}),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: nextCursor,
  });
}

export function useCustomer(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: billingKeys.customer(scope, id),
    queryFn: async () => {
      const [customer, balance, entitlements] = await Promise.all([
        dashboardApi.customers.retrieve(scope, id),
        dashboardApi.customers.balanceTransactions(scope, id, { limit: BILLING_PAGE_SIZE }),
        dashboardApi.customers.activeEntitlements(scope, id),
      ]);
      return { customer, balance, entitlements };
    },
  });
}

export function useSubscription(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: billingKeys.subscription(scope, id),
    queryFn: () => dashboardApi.subscriptions.retrieve(scope, id),
  });
}

export function useInvoice(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: billingKeys.invoice(scope, id),
    queryFn: () => dashboardApi.invoices.retrieve(scope, id),
  });
}

export function useBillingSettings(scope: DashboardScope) {
  return useQuery({
    queryKey: billingKeys.settings(scope),
    queryFn: () => dashboardApi.billingSettings.retrieve(scope),
  });
}

/** Every feature (a merchant has few; one page of the maximum). */
export function useFeatures(scope: DashboardScope) {
  return useQuery({
    queryKey: billingKeys.features(scope),
    queryFn: () => dashboardApi.features.list(scope, { limit: 100 }),
  });
}

export function useProductFeatures(scope: DashboardScope, productId: string) {
  return useQuery({
    queryKey: billingKeys.productFeatures(scope, productId),
    queryFn: () => dashboardApi.features.ofProduct(scope, productId),
  });
}
