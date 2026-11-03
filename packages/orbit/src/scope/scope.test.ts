import { describe, expect, it } from 'bun:test';
import type { AccountNode, Application } from '@oxy.so/core';
import {
  activeApplications,
  eligibleOrganizations,
  EMPTY_SELECTION,
  environmentForMode,
  modeForEnvironment,
  organizationLabel,
  parseStoredSelection,
  reconcileApplication,
  reconcileOrganization,
} from './scope';

function node(overrides: Partial<AccountNode> & { accountId: string }): AccountNode {
  return {
    kind: 'organization',
    parentAccountId: null,
    account: { username: overrides.accountId, name: {} },
    relationship: 'member',
    callerMembership: { role: 'admin' },
    ...overrides,
  } as unknown as AccountNode;
}

const app = (id: string, status: string) =>
  ({ _id: id, name: id, status }) as unknown as Application;

describe('Test / Live', () => {
  it('maps the toggle onto the gateway environment and back', () => {
    expect(environmentForMode('test')).toBe('development');
    expect(environmentForMode('live')).toBe('production');
    expect(modeForEnvironment('production')).toBe('live');
    expect(modeForEnvironment('development')).toBe('test');
  });
});

describe('eligibleOrganizations', () => {
  it('keeps organizations the person is a member of, whatever the role', () => {
    const rows = [
      node({ accountId: 'org_admin' }),
      node({ accountId: 'org_viewer', callerMembership: { role: 'viewer' } as never }),
      node({ accountId: 'self', kind: 'personal' as never, callerMembership: null }),
      node({ accountId: 'org_none', callerMembership: null }),
    ];
    expect(eligibleOrganizations(rows).map((row) => row.accountId)).toEqual([
      'org_admin',
      'org_viewer',
    ]);
  });
});

describe('organizationLabel', () => {
  it('prefers the display name, then the handle', () => {
    expect(
      organizationLabel(
        node({
          accountId: 'o',
          account: { username: 'acme', name: { displayName: ' Acme ' } } as never,
        }),
      ),
    ).toBe('Acme');
    expect(
      organizationLabel(node({ accountId: 'o', account: { username: 'acme', name: {} } as never })),
    ).toBe('acme');
  });
});

describe('activeApplications', () => {
  it('drops applications that are not active', () => {
    expect(
      activeApplications([app('a', 'active'), app('b', 'suspended')]).map((a) => a._id),
    ).toEqual(['a']);
  });
});

describe('parseStoredSelection', () => {
  it('reads a stored selection and defaults the environment to Test', () => {
    expect(
      parseStoredSelection(
        '{"organizationId":"org","applicationId":"app","environment":"production"}',
      ),
    ).toEqual({ organizationId: 'org', applicationId: 'app', environment: 'production' });
    expect(parseStoredSelection('{"organizationId":"org","environment":"staging"}')).toEqual({
      organizationId: 'org',
      applicationId: null,
      environment: 'development',
    });
  });

  it('treats anything unreadable as nothing remembered', () => {
    expect(parseStoredSelection(null)).toEqual(EMPTY_SELECTION);
    expect(parseStoredSelection('{')).toEqual(EMPTY_SELECTION);
    expect(parseStoredSelection('42')).toEqual(EMPTY_SELECTION);
  });
});

describe('reconcile', () => {
  const orgs = [node({ accountId: 'o1' }), node({ accountId: 'o2' })];
  it('keeps a remembered choice that is still offered', () => {
    expect(reconcileOrganization('o2', orgs)).toBe('o2');
    expect(reconcileApplication('b', [app('a', 'active'), app('b', 'active')])).toBe('b');
  });

  it('falls back to the first, or to none', () => {
    expect(reconcileOrganization('gone', orgs)).toBe('o1');
    expect(reconcileOrganization('gone', [])).toBeNull();
    expect(reconcileApplication(null, [])).toBeNull();
  });
});
