import type { Application } from '@oxy.so/core';
import { allowsDashboardAction, type DashboardAction } from '@peable.to/contracts/vocabulary';

/**
 * What the signed-in person may do on the selected application, judged with
 * the gateway's OWN map (`@peable.to/contracts/vocabulary`:
 * `DASHBOARD_PERMISSIONS`, `allowsDashboardAction`, `FILE_UPLOAD_ACTION`) over
 * the permissions Oxy already hands Orbit: the application's
 * `callerMembership.permissions` from `apps.list`. The gateway refuses what
 * this hides, so the two never disagree. The zod-free vocabulary subpath, as
 * every Orbit bundle imports the contracts.
 */
const NOTHING: readonly string[] = [];

/**
 * The permissions the person holds on `applicationId`: its
 * `callerMembership.permissions`, or nothing — no application chosen, an
 * application not on offer, no membership, or an answer without a list all
 * allow nothing, never everything.
 */
export function heldPermissions(
  applications: readonly Pick<Application, '_id' | 'callerMembership'>[],
  applicationId: string | null,
): readonly string[] {
  if (!applicationId) return NOTHING;
  const permissions = applications.find((app) => app._id === applicationId)?.callerMembership
    ?.permissions;
  return Array.isArray(permissions) ? permissions : NOTHING;
}

export interface DashboardAbilities {
  /** Whether the person may perform `action` on the selected application. */
  can: (action: DashboardAction) => boolean;
}

export function dashboardAbilities(held: readonly string[]): DashboardAbilities {
  return { can: (action) => allowsDashboardAction(held, action) };
}
