import { describe, expect, it } from 'bun:test';
import type { Application } from '@oxy.so/core';
import { DASHBOARD_PERMISSIONS, type DashboardAction } from '@peable.to/contracts/vocabulary';
import { dashboardAbilities, heldPermissions } from './permissions';

const ACTIONS = Object.keys(DASHBOARD_PERMISSIONS) as DashboardAction[];

const app = (id: string, callerMembership: unknown) =>
  ({ _id: id, callerMembership }) as unknown as Application;

describe('heldPermissions', () => {
  const apps = [
    app('app_editor', { permissions: ['app:read', 'app:update'] }),
    app('app_none', null),
    app('app_old', { role: 'viewer' }),
  ];

  it('reads the selected application’s callerMembership.permissions', () => {
    expect(heldPermissions(apps, 'app_editor')).toEqual(['app:read', 'app:update']);
  });

  it('allows nothing without a choice, a listed application, a membership or a list', () => {
    expect(heldPermissions(apps, null)).toEqual([]);
    expect(heldPermissions(apps, 'app_missing')).toEqual([]);
    expect(heldPermissions(apps, 'app_none')).toEqual([]);
    expect(heldPermissions(apps, 'app_old')).toEqual([]);
  });

  it('feeds can() per action', () => {
    const { can } = dashboardAbilities(heldPermissions(apps, 'app_editor'));
    expect(ACTIONS.filter(can)).toEqual(['read', 'configure']);
    expect(ACTIONS.filter(dashboardAbilities([]).can)).toEqual([]);
  });
});
