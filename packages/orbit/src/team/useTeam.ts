import { useQuery } from '@tanstack/react-query';
import type { AccountMember, User } from '@oxy.so/core';
import { oxyServices } from '../api/client';

export interface TeamRow {
  member: AccountMember;
  /** The member's display name, else their handle, else their user id. */
  name: string;
  handle: string | null;
}

function nameOf(user: User | undefined, fallback: string): { name: string; handle: string | null } {
  if (!user) return { name: fallback, handle: null };
  const handle = user.username || null;
  return { name: user.name?.displayName?.trim() || handle || fallback, handle };
}

/**
 * The members of the account that owns the application — the people the
 * gateway's membership check admits — read straight from Oxy as the signed-in
 * user, with their names. A caller without `members:read` is refused by Oxy
 * (403), and the screen says so.
 */
export function useTeam(ownerAccountId: string | null) {
  return useQuery({
    queryKey: ['orbit', 'team', ownerAccountId],
    enabled: ownerAccountId !== null,
    queryFn: async (): Promise<TeamRow[]> => {
      const members = await oxyServices.accounts.members.list(ownerAccountId ?? '');
      const ids = [...new Set(members.map((member) => member.memberUserId))];
      // A name that cannot be read is shown as the id: names are a courtesy,
      // the membership is the fact.
      const users = ids.length ? await oxyServices.users.getMany(ids).catch(() => []) : [];
      const byId = new Map(users.map((user) => [user.id, user]));
      return members.map((member) => ({
        member,
        ...nameOf(byId.get(member.memberUserId), member.memberUserId),
      }));
    },
  });
}
