import type { AccountMember, AccountRole } from '@oxy.so/core';

/**
 * What a member of the application's owning Oxy account may do in Orbit —
 * read from the SAME permissions the gateway's checks use, never from a role
 * name (oxy-api resolves role + grants − revokes into `permissions`):
 *
 * - **Orbit**: every `/v1/dashboard/*` route asks oxy-api for the caller's
 *   membership of the application, which oxy-api grants on `app:read` — the
 *   application side of the account's `apps:read`. A member without it gets
 *   403 on every Orbit screen.
 * - **Peable Tax**: `billing:read` to look, `billing:manage` to change
 *   settings, registrations and approve (`routes/tax.ts`; manage implies read).
 *
 * Only an `active` membership counts: an invitation not yet accepted grants
 * nothing. Changes are made in Oxy Console, never here.
 */
export interface PeableAccess {
  orbit: boolean;
  taxRead: boolean;
  taxManage: boolean;
}

export function peableAccessOf(
  member: Pick<AccountMember, 'permissions' | 'status'>,
): PeableAccess {
  if (member.status !== 'active') return { orbit: false, taxRead: false, taxManage: false };
  const has = (permission: string) => member.permissions.includes(permission);
  const taxManage = has('billing:manage');
  return { orbit: has('apps:read'), taxRead: taxManage || has('billing:read'), taxManage };
}

/** The role order Oxy itself lists members in: most powerful first. */
export const ROLE_ORDER: readonly AccountRole[] = [
  'owner',
  'admin',
  'editor',
  'developer',
  'billing',
  'viewer',
];

/** Members by role (owners first), then by name; inherited rows after direct ones of the same role. */
export function sortMembers<
  T extends { member: Pick<AccountMember, 'role' | 'source'>; name: string },
>(rows: readonly T[]): T[] {
  const rank = (role: AccountRole) => {
    const index = ROLE_ORDER.indexOf(role);
    return index === -1 ? ROLE_ORDER.length : index;
  };
  return [...rows].sort(
    (a, b) =>
      rank(a.member.role) - rank(b.member.role) ||
      Number(a.member.source === 'inherited') - Number(b.member.source === 'inherited') ||
      a.name.localeCompare(b.name),
  );
}
