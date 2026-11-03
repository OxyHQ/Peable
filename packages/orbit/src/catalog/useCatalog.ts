import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Price, Product } from '@peable.to/shared-types';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';

export const PRODUCTS_PAGE_SIZE = 25;
/** A product's prices on one page: the gateway's list maximum. */
export const PRICES_PAGE_SIZE = 100;

/** `true` active, `false` archived, `null` both. */
export type ProductFilter = boolean | null;

/** Every catalog key starts with the scope, so a mode switch never shows the other mode's rows. */
export const catalogKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'catalog'],
  products: (scope: DashboardScope, active: ProductFilter) => [
    ...catalogKeys.all(scope),
    'products',
    active === null ? 'all' : active ? 'active' : 'archived',
  ],
  product: (scope: DashboardScope, id: string) => [...catalogKeys.all(scope), 'product', id],
  prices: (scope: DashboardScope, productId: string) => [
    ...catalogKeys.all(scope),
    'prices',
    productId,
  ],
};

export function useProductPages(scope: DashboardScope, active: ProductFilter) {
  return useInfiniteQuery({
    queryKey: catalogKeys.products(scope, active),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.products.list(scope, {
        limit: PRODUCTS_PAGE_SIZE,
        ...(active === null ? {} : { active }),
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<Product>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
}

export function useProduct(scope: DashboardScope, id: string) {
  return useQuery({
    queryKey: catalogKeys.product(scope, id),
    queryFn: () => dashboardApi.products.retrieve(scope, id),
  });
}

export function useProductPrices(scope: DashboardScope, productId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: catalogKeys.prices(scope, productId),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      dashboardApi.prices.list(scope, {
        product: productId,
        limit: PRICES_PAGE_SIZE,
        ...(pageParam ? { starting_after: pageParam } : {}),
      }),
    getNextPageParam: (last: ListPage<Price>) =>
      last.has_more ? last.data[last.data.length - 1]?.id : undefined,
  });
}
