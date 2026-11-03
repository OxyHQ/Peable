import { useMemo } from 'react';
import { dashboardAbilities, heldPermissions, type DashboardAbilities } from './permissions';
import { useOrbitScope } from './ScopeProvider';

/**
 * `can(action)` for the selected application — the one place a screen asks
 * whether to offer a write. Pair a gated control with `PermissionNotice`
 * (`src/ui/states.tsx`) so the reason is said once per section.
 */
export function useDashboardPermissions(): DashboardAbilities {
  const { applications, applicationId } = useOrbitScope();
  const held = heldPermissions(applications, applicationId);
  return useMemo(() => dashboardAbilities(held), [held]);
}
