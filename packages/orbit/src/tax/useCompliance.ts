import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxy.so/bloom/toast';
import { taxComplianceApi } from '../api/client';
import type { DashboardScope } from '../api/dashboard';
import { describeError } from '../api/transport';
import { t } from '../i18n';
import type { TaxComplianceApi } from './complianceApi';

/**
 * Every compliance key starts with the scope, so a mode switch never shows the
 * other mode's records, and with `tax_compliance`, so one write refreshes all.
 */
export const complianceKeys = {
  all: (scope: DashboardScope) => [
    'orbit',
    scope.applicationId,
    scope.environment,
    'tax_compliance',
  ],
  one: (scope: DashboardScope, name: string) => [...complianceKeys.all(scope), name],
};

type Reader = Exclude<
  keyof TaxComplianceApi,
  | 'updateProfile'
  | 'addLocation'
  | 'updateLocation'
  | 'addDestination'
  | 'updateDestination'
  | 'addDeclaration'
  | 'updateDeclaration'
  | 'attachDocument'
  | 'assess'
  | 'replay'
  | 'resolveReviewItem'
  | 'reviewItems'
>;

/** One read of the workspace, by name. */
export function useCompliance<K extends Reader>(scope: DashboardScope, name: K) {
  type Answer = Awaited<ReturnType<TaxComplianceApi[K]>>;
  const read = taxComplianceApi[name] as unknown as (s: DashboardScope) => Promise<Answer>;
  return useQuery<Answer>({
    queryKey: complianceKeys.one(scope, name),
    queryFn: () => read(scope),
  });
}

export function useReviewItems(scope: DashboardScope) {
  return useQuery({
    queryKey: complianceKeys.one(scope, 'reviewItems'),
    queryFn: () => taxComplianceApi.reviewItems(scope),
  });
}

/**
 * A write: shows the gateway's own refusal, and on success refreshes every
 * compliance read (an assessment, for instance, moves the review queue).
 */
export function useComplianceWrite<A, R>(scope: DashboardScope, write: (args: A) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: complianceKeys.all(scope) });
      toast.success(t('compliance.saved'));
    },
    onError: (error) => toast.error(describeError(error, t('compliance.error'))),
  });
}
