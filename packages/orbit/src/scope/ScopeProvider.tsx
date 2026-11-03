import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AccountNode, Application } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import type { ContributionScope } from '@peable.to/sdk/contributions';
import { oxyServices } from '../api/client';
import type { DashboardScope, OrbitEnvironment } from '../api/dashboard';
import {
  activeApplications,
  eligibleOrganizations,
  EMPTY_SELECTION,
  parseStoredSelection,
  reconcileApplication,
  reconcileOrganization,
  type OrbitSelection,
} from './scope';

const STORAGE_KEY = 'orbit:selection:v1';
const NO_ORGANIZATIONS: AccountNode[] = [];
const NO_APPLICATIONS: Application[] = [];

export interface OrbitScopeValue {
  organizations: AccountNode[];
  applications: Application[];
  organizationsLoading: boolean;
  applicationsLoading: boolean;
  /** A failure listing organizations or applications, for the shell to show. */
  error: unknown;
  retry: () => void;
  organizationId: string | null;
  applicationId: string | null;
  environment: OrbitEnvironment;
  setOrganizationId: (id: string) => void;
  setApplicationId: (id: string) => void;
  setEnvironment: (environment: OrbitEnvironment) => void;
  /** Set once an application is chosen: what every `/v1/dashboard/*` call is scoped by. */
  scope: DashboardScope | null;
  /** The contribution routes also name the organization. */
  contributionScope: ContributionScope | null;
}

const OrbitScopeContext = createContext<OrbitScopeValue | null>(null);

/**
 * The organization / application / Test-Live choice every Orbit screen works
 * in — the picker the wallet's tax and contributions screens each built for
 * themselves, held once. The person's choice is remembered on this device; a
 * remembered organization or application that is no longer offered falls back
 * to the first one there is.
 */
export function OrbitScopeProvider({ children }: { children: ReactNode }) {
  const { canUsePrivateApi, user } = useAuth();
  const [selection, setSelection] = useState<OrbitSelection>(EMPTY_SELECTION);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .catch(() => null)
      .then((raw) => {
        if (!active) return;
        setSelection(parseStoredSelection(raw));
        setRestored(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!restored) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(selection)).catch(() => undefined);
  }, [restored, selection]);

  const userId = user?.id ?? null;
  const organizationsQuery = useQuery({
    queryKey: ['orbit', 'organizations', userId],
    queryFn: async () => eligibleOrganizations(await oxyServices.accounts.list()),
    enabled: canUsePrivateApi && restored,
  });
  const organizations = organizationsQuery.data ?? NO_ORGANIZATIONS;
  const organizationId = organizationsQuery.data
    ? reconcileOrganization(selection.organizationId, organizations)
    : selection.organizationId;

  const applicationsQuery = useQuery({
    queryKey: ['orbit', 'applications', userId, organizationId],
    queryFn: async () => activeApplications(await oxyServices.apps.list(organizationId ?? '')),
    enabled: canUsePrivateApi && restored && !!organizationId && !!organizationsQuery.data,
  });
  const applications = applicationsQuery.data ?? NO_APPLICATIONS;
  const applicationId = applicationsQuery.data
    ? reconcileApplication(selection.applicationId, applications)
    : null;

  const setOrganizationId = useCallback((id: string) => {
    setSelection((prior) =>
      prior.organizationId === id ? prior : { ...prior, organizationId: id, applicationId: null },
    );
  }, []);
  const setApplicationId = useCallback((id: string) => {
    setSelection((prior) => ({ ...prior, applicationId: id }));
  }, []);
  const setEnvironment = useCallback((environment: OrbitEnvironment) => {
    setSelection((prior) => ({ ...prior, environment }));
  }, []);

  const { refetch: refetchOrganizations } = organizationsQuery;
  const { refetch: refetchApplications } = applicationsQuery;
  const retry = useCallback(() => {
    void refetchOrganizations();
    void refetchApplications();
  }, [refetchOrganizations, refetchApplications]);

  const environment = selection.environment;
  // Stable identities, keyed on the primitives: screens load data in effects
  // that depend on these objects, and must not reload because a list refetched.
  const scope = useMemo<DashboardScope | null>(
    () => (applicationId ? { applicationId, environment } : null),
    [applicationId, environment],
  );
  const contributionScope = useMemo<ContributionScope | null>(
    () => (applicationId && organizationId ? { organizationId, applicationId, environment } : null),
    [organizationId, applicationId, environment],
  );
  const value = useMemo<OrbitScopeValue>(
    () => ({
      organizations,
      applications,
      organizationsLoading: !restored || organizationsQuery.isPending,
      applicationsLoading: !!organizationId && applicationsQuery.isPending,
      error: organizationsQuery.error ?? applicationsQuery.error,
      retry,
      organizationId,
      applicationId,
      environment,
      setOrganizationId,
      setApplicationId,
      setEnvironment,
      scope,
      contributionScope,
    }),
    [
      organizations,
      applications,
      restored,
      organizationsQuery.isPending,
      organizationsQuery.error,
      applicationsQuery.isPending,
      applicationsQuery.error,
      retry,
      organizationId,
      applicationId,
      environment,
      setOrganizationId,
      setApplicationId,
      setEnvironment,
      scope,
      contributionScope,
    ],
  );

  return <OrbitScopeContext.Provider value={value}>{children}</OrbitScopeContext.Provider>;
}

export function useOrbitScope(): OrbitScopeValue {
  const value = useContext(OrbitScopeContext);
  if (!value) throw new Error('useOrbitScope must be used inside <OrbitScopeProvider>');
  return value;
}
