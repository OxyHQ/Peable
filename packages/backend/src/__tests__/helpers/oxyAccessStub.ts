import type { Request } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { DASHBOARD_PERMISSIONS } from '@peable.to/contracts/vocabulary';
import {
  type AccountAccess,
  type AccessOptions,
  type ApplicationAccess,
  type OxyAccess,
  OxyAccessError,
  type OxyAccessFailure,
} from '../../services/oxyAccess';

/** Every permission a dashboard action names: what an owner holds, as far as Peable can tell. */
export const EVERY_DASHBOARD_PERMISSION: readonly string[] = [
  ...new Set(Object.values(DASHBOARD_PERMISSIONS)),
];

/** What a stubbed Oxy answers: an access (defaults filled in), a failure, or `undefined` for "no". */
export type ApplicationAnswer =
  | Partial<Omit<ApplicationAccess, 'applicationId'>>
  | OxyAccessFailure;
export type AccountAnswer = Partial<Omit<AccountAccess, 'accountId'>> | OxyAccessFailure;

/** One question a stub was asked, to assert caching and `fresh`. */
export interface AskedQuestion {
  readonly kind: 'application' | 'account';
  readonly id: string;
  readonly userId: string;
  readonly fresh: boolean;
}

/**
 * An {@link OxyAccess} that answers from the test's own table instead of
 * oxy-api — the seam every router takes. The REAL module's Oxy handling is
 * covered by `services/__tests__/oxyAccess.test.ts`.
 */
export function stubOxyAccess(answers: {
  readonly application?: (userId: string, applicationId: string) => ApplicationAnswer | undefined;
  readonly account?: (userId: string, accountId: string) => AccountAnswer | undefined;
}): OxyAccess & { readonly asked: AskedQuestion[] } {
  const asked: AskedQuestion[] = [];
  const userOf = (
    req: Request,
    kind: AskedQuestion['kind'],
    id: string,
    options?: AccessOptions,
  ) => {
    const userId = (req as OxyAuthRequest).userId;
    if (!userId) throw new OxyAccessError('session_required', 'no user session on the request');
    asked.push({ kind, id, userId, fresh: options?.fresh === true });
    return userId;
  };
  const settle = <T extends object>(answer: T | OxyAccessFailure | undefined): T => {
    if (answer === undefined) throw new OxyAccessError('denied', 'stub: not a member');
    if (typeof answer === 'string') throw new OxyAccessError(answer, `stub: ${answer}`);
    return answer;
  };
  return {
    asked,
    async application(req, applicationId, options) {
      const userId = userOf(req, 'application', applicationId, options);
      const answer = settle(answers.application?.(userId, applicationId));
      return {
        applicationId,
        ownerAccountId: 'acct_owner',
        permissions: EVERY_DASHBOARD_PERMISSION,
        official: false,
        active: true,
        ...answer,
      };
    },
    async account(req, accountId, options) {
      const userId = userOf(req, 'account', accountId, options);
      const answer = settle(answers.account?.(userId, accountId));
      return { accountId, kind: 'organization', permissions: [], ...answer };
    },
  };
}
