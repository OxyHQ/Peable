import { describe, expect, it } from 'bun:test';
import type { AccountMember } from '@oxy.so/core';
import { peableAccessOf, sortMembers } from './permissions';

const member = (overrides: Partial<AccountMember>): AccountMember => ({
  _id: 'm',
  accountId: 'org',
  memberUserId: 'u',
  role: 'viewer',
  permissions: [],
  inherit: true,
  status: 'active',
  source: 'direct',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('peableAccessOf', () => {
  it('reads the permissions the gateway checks, not the role', () => {
    expect(
      peableAccessOf(
        member({ role: 'billing', permissions: ['apps:read', 'billing:read', 'billing:manage'] }),
      ),
    ).toEqual({ orbit: true, taxRead: true, taxManage: true });
    expect(peableAccessOf(member({ role: 'developer', permissions: ['apps:read'] }))).toEqual({
      orbit: true,
      taxRead: false,
      taxManage: false,
    });
    // A revoked `apps:read` is no Orbit, whatever the role says.
    expect(peableAccessOf(member({ role: 'admin', permissions: ['billing:read'] }))).toEqual({
      orbit: false,
      taxRead: true,
      taxManage: false,
    });
  });

  it('lets managing tax imply reading it', () => {
    expect(peableAccessOf(member({ permissions: ['billing:manage'] })).taxRead).toBe(true);
  });

  it('grants nothing to an invitation not yet accepted', () => {
    expect(
      peableAccessOf(member({ status: 'invited', permissions: ['apps:read', 'billing:manage'] })),
    ).toEqual({ orbit: false, taxRead: false, taxManage: false });
  });
});

describe('sortMembers', () => {
  it('puts owners first, direct before inherited, then by name', () => {
    const rows = [
      { member: member({ role: 'viewer' }), name: 'Ana' },
      { member: member({ role: 'owner', source: 'inherited' }), name: 'Zoe' },
      { member: member({ role: 'owner' }), name: 'Yan' },
      { member: member({ role: 'developer' }), name: 'Bo' },
      { member: member({ role: 'developer' }), name: 'Al' },
    ];
    expect(sortMembers(rows).map((row) => row.name)).toEqual(['Yan', 'Zoe', 'Al', 'Bo', 'Ana']);
  });
});
