import type { AccountNode, Application } from '@oxy.so/core';
import type { OrbitEnvironment } from '../api/dashboard';

/**
 * What Orbit is looking at: one organization, one of its applications, and
 * Test or Live. Pure — `ScopeProvider.tsx` holds it in React and persists it.
 */
export interface OrbitSelection {
  organizationId: string | null;
  applicationId: string | null;
  environment: OrbitEnvironment;
}

export type OrbitMode = 'test' | 'live';

/** Test is the default: nothing a merchant clicks around in should touch live money first. */
export const DEFAULT_ENVIRONMENT: OrbitEnvironment = 'development';

export const EMPTY_SELECTION: OrbitSelection = {
  organizationId: null,
  applicationId: null,
  environment: DEFAULT_ENVIRONMENT,
};

export function environmentForMode(mode: OrbitMode): OrbitEnvironment {
  return mode === 'live' ? 'production' : 'development';
}

export function modeForEnvironment(environment: OrbitEnvironment): OrbitMode {
  return environment === 'production' ? 'live' : 'test';
}

/**
 * The organizations the signed-in person belongs to. The ROLE is not judged
 * here: each dashboard route asks oxy-api for the caller's membership itself
 * (the gateway never re-implements RBAC), and a screen shows the gateway's
 * 403 in its own words. Filtering by role here would hide an organization from
 * someone who may use some screens and not others.
 */
export function eligibleOrganizations(nodes: readonly AccountNode[]): AccountNode[] {
  return nodes.filter((node) => node.kind === 'organization' && node.callerMembership !== null);
}

/** Only active applications can hold a merchant. */
export function activeApplications(apps: readonly Application[]): Application[] {
  return apps.filter((app) => app.status === 'active');
}

/** `name.displayName`, else the handle, else the id — never a recomposed name. */
export function organizationLabel(node: AccountNode): string {
  return node.account.name?.displayName?.trim() || node.account.username || node.accountId;
}

/** The persisted selection, read defensively: storage is a per-viewer convenience, not truth. */
export function parseStoredSelection(raw: string | null | undefined): OrbitSelection {
  if (!raw) return EMPTY_SELECTION;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return EMPTY_SELECTION;
    const record = value as Record<string, unknown>;
    const text = (field: unknown) => (typeof field === 'string' && field ? field : null);
    return {
      organizationId: text(record.organizationId),
      applicationId: text(record.applicationId),
      environment: record.environment === 'production' ? 'production' : DEFAULT_ENVIRONMENT,
    };
  } catch {
    return EMPTY_SELECTION;
  }
}

/**
 * Keep a remembered choice only while it is still on offer: an organization the
 * person left, or an application that was archived, falls back to the first
 * one there is (or none).
 */
export function reconcileOrganization(
  remembered: string | null,
  organizations: readonly AccountNode[],
): string | null {
  if (remembered && organizations.some((node) => node.accountId === remembered)) return remembered;
  return organizations[0]?.accountId ?? null;
}

export function reconcileApplication(
  remembered: string | null,
  applications: readonly Application[],
): string | null {
  if (remembered && applications.some((app) => app._id === remembered)) return remembered;
  return applications[0]?._id ?? null;
}
