import { describe, expect, it } from 'bun:test';
import {
  allowsDashboardAction,
  DASHBOARD_PERMISSIONS,
  type DashboardAction,
  FILE_UPLOAD_ACTION,
} from '../vocabulary/dashboard';
import { FILE_UPLOAD_PURPOSES } from '../vocabulary/files';

const ACTIONS = Object.keys(DASHBOARD_PERMISSIONS) as DashboardAction[];

describe('allowsDashboardAction', () => {
  it('allows an action to exactly the holder of its permission', () => {
    for (const action of ACTIONS) {
      expect(allowsDashboardAction([DASHBOARD_PERMISSIONS[action]], action)).toBe(true);
      expect(allowsDashboardAction([], action)).toBe(false);
    }
  });

  it('lets billing:manage read Peable Tax, and implies nothing else', () => {
    expect(allowsDashboardAction(['billing:manage'], 'taxRead')).toBe(true);
    expect(allowsDashboardAction(['billing:read'], 'money')).toBe(false);
    expect(allowsDashboardAction(['app:update'], 'read')).toBe(false);
    expect(allowsDashboardAction(['app:update'], 'webhooks')).toBe(false);
    // The ACCOUNT-lane spelling is not the application permission.
    expect(allowsDashboardAction(['apps:read'], 'read')).toBe(false);
  });
});

describe('FILE_UPLOAD_ACTION', () => {
  it('names an action for every purpose a merchant may upload', () => {
    expect(Object.keys(FILE_UPLOAD_ACTION).sort()).toEqual([...FILE_UPLOAD_PURPOSES].sort());
  });
});
