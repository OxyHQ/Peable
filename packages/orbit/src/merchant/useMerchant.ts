import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';

/** The one cache entry for "this application's merchant in this mode" — `null` when there is none. */
export const merchantQueryKey = (scope: DashboardScope) => [
  'orbit',
  scope.applicationId,
  scope.environment,
  'merchant',
];

/**
 * The merchant of the selected application and mode (`null` when there is
 * none yet). `OrbitScreen` reads it once per page to decide between the page
 * and the first-run state, so a page with five sections shows ONE "Set up
 * payments", not five.
 */
export function useMerchant(scope: DashboardScope | null) {
  return useQuery({
    queryKey: scope ? merchantQueryKey(scope) : ['orbit', 'no-scope', 'merchant'],
    queryFn: () => (scope ? dashboardApi.merchant.retrieve(scope) : null),
    enabled: scope !== null,
  });
}
