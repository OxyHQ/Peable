import { Admonition, AdmonitionText } from '@oxy.so/bloom/admonition';
import { t } from '../i18n';
import { DASHBOARD_PERMISSIONS, type DashboardAction } from '@peable.to/contracts/vocabulary';
import { useDashboardPermissions } from '../scope/useDashboardPermissions';

/**
 * Why a page's or section's controls are disabled, said once: the permission
 * the gateway asks for `action` (the shared map), and where it is granted.
 * Renders nothing when the person holds it. `view` is the wording for a page
 * the person cannot even read (Peable Tax without `billing:read`).
 */
export function ActionPermissionNotice({
  action,
  view = false,
}: {
  action: DashboardAction;
  view?: boolean;
}) {
  const { can } = useDashboardPermissions();
  if (can(action)) return null;
  return (
    <Admonition type="info">
      <AdmonitionText>
        {t(view ? 'permission.view' : 'permission.change', {
          permission: DASHBOARD_PERMISSIONS[action],
        })}
      </AdmonitionText>
    </Admonition>
  );
}
