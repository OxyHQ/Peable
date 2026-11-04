import {
  OxyAccessError,
  type OxyAccessErrorCode,
  type OxyAccountAccess,
  type OxyApplicationAccess,
  type OxyAuthRequest,
} from '@oxy.so/core/server';
import { DASHBOARD_PERMISSIONS } from '@peable.to/contracts/vocabulary';
import type { OxyAccess } from '../../services/oxyAccess';

/** Every permission a dashboard action names: what an owner holds, as far as Peable can tell. */
export const EVERY_DASHBOARD_PERMISSION: readonly string[] = [
  ...new Set(Object.values(DASHBOARD_PERMISSIONS)),
];

type Facts<T> = Partial<Omit<T, 'has'>>;

/** What a stubbed Oxy answers: an access (defaults filled in), a failure, or `undefined` for "no". */
export type ApplicationAnswer =
  | Facts<Omit<OxyApplicationAccess, 'applicationId'>>
  | OxyAccessErrorCode;
export type AccountAnswer = Facts<Omit<OxyAccountAccess, 'accountId'>> | OxyAccessErrorCode;

/** One question a stub was asked, to assert `fresh`. */
export interface AskedQuestion {
  readonly kind: 'application' | 'account';
  readonly id: string;
  readonly userId: string;
  readonly fresh: boolean;
}

function withHas<T extends { permissions: readonly string[] }>(
  facts: T,
): T & {
  has(permission: string): boolean;
} {
  return { ...facts, has: (permission: string) => facts.permissions.includes(permission) };
}

/**
 * An {@link OxyAccess} that answers from the test's own table instead of
 * oxy-api — the seam every router takes. The REAL path (`@oxy.so/core`
 * against an oxy-api stand-in) is covered by `services/__tests__/oxyAccess.test.ts`.
 */
export function stubOxyAccess(answers: {
  readonly application?: (userId: string, applicationId: string) => ApplicationAnswer | undefined;
  readonly account?: (userId: string, accountId: string) => AccountAnswer | undefined;
}): OxyAccess & { readonly asked: AskedQuestion[] } {
  const asked: AskedQuestion[] = [];
  const userOf = (
    req: unknown,
    kind: AskedQuestion['kind'],
    id: string,
    options?: { fresh?: boolean },
  ) => {
    const userId = (req as OxyAuthRequest).userId;
    if (!userId) throw new OxyAccessError('ACCESS_SESSION_REQUIRED', 'no user session');
    asked.push({ kind, id, userId, fresh: options?.fresh === true });
    return userId;
  };
  const settle = <T extends object>(answer: T | OxyAccessErrorCode | undefined): T => {
    if (answer === undefined) throw new OxyAccessError('ACCESS_DENIED', 'stub: not a member');
    if (typeof answer === 'string') throw new OxyAccessError(answer, `stub: ${answer}`);
    return answer;
  };
  return {
    asked,
    async applicationAccessFor(req, applicationId, options) {
      const userId = userOf(req, 'application', applicationId, options);
      const answer = settle(answers.application?.(userId, applicationId));
      return withHas({
        applicationId,
        ownerAccountId: 'acct_owner',
        official: false,
        status: 'active' as const,
        role: 'owner',
        permissions: EVERY_DASHBOARD_PERMISSION,
        ...answer,
      });
    },
    async accountAccessFor(req, accountId, options) {
      const userId = userOf(req, 'account', accountId, options);
      const answer = settle(answers.account?.(userId, accountId));
      return withHas({
        accountId,
        kind: 'organization' as const,
        relationship: 'member' as const,
        role: 'admin',
        source: 'direct' as const,
        permissions: [] as readonly string[],
        ...answer,
      });
    },
  };
}
