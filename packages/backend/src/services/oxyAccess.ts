import type { Request, Response } from 'express';
import {
  accessErrorStatus,
  OxyAccessError,
  type OxyAccountAccess,
  type OxyApplicationAccess,
  type OxyAuthRequest,
  type OxyServer,
} from '@oxy.so/core/server';
import {
  allowsDashboardAction,
  DASHBOARD_PERMISSIONS,
  type DashboardAction,
} from '@peable.to/contracts/vocabulary';
import { sendError } from '../lib/http';
import { requestIdOf } from '../lib/requestId';

/**
 * The ONE way a Peable surface asks Oxy what a signed-in person may do: Orbit's
 * dashboard, Peable Tax, the contribution routes and every Orbit upload. Peable
 * keeps no membership copy, no cache and reads no role name (spec §8, "zero
 * RBAC duplication"): `@oxy.so/core` asks Oxy with the request's own bearer.
 *
 * - **Application A** — `oxy.applicationAccessFor`: the person's APPLICATION
 *   permissions (`app:update`, `webhooks:update`, `billing:manage`, …) through
 *   the account that owns A. Not `oxy.appPermissionsFor`: that reads Peable's
 *   OWN declared operator keys, a different question an organization's owner
 *   holds none of.
 * - **Account X** — `oxy.accountAccessFor`: what the account is (`kind`) and
 *   the person's effective permissions over it.
 *
 * The SDK refuses a request authenticated by a SERVICE token before Oxy is
 * asked, caches only answers that let someone in (per session, 30 s), and
 * types every other outcome as an `OxyAccessError`. This module adds only
 * Peable's side: which permission an action needs (`DASHBOARD_PERMISSIONS`,
 * shared with Orbit), `fresh` on every write, and the answer in Peable's error
 * envelope ({@link sendOxyAccessError}).
 */

/** The seam every surface (and every test) is handed: the process's `oxy` in production. */
export type OxyAccess = Pick<OxyServer, 'applicationAccessFor' | 'accountAccessFor'>;

/** The canonical HTTP answer for each outcome — every surface answers the same way. */
export function sendOxyAccessError(
  res: Response,
  error: OxyAccessError,
  subject: { readonly kind: 'application' | 'account'; readonly id: string },
): void {
  console.warn(
    `[oxy.access] ${subject.kind}=${subject.id} request=${requestIdOf(res) ?? '-'} ${error.code}: ${error.message}`,
  );
  switch (accessErrorStatus(error)) {
    case 401:
      sendError(
        res,
        401,
        'authentication_error',
        'your Oxy session is no longer valid; sign in again',
        'session_invalid',
      );
      return;
    case 503:
      // Fail closed, but say what happened: an outage is not a refusal, and a
      // member must not be told they are not one while Oxy cannot be asked.
      sendError(
        res,
        503,
        'api_error',
        `could not verify your access to this ${subject.kind} with Oxy; try again`,
        'membership_unavailable',
      );
      return;
    default:
      sendError(
        res,
        403,
        'permission_error',
        `you are not a member of this ${subject.kind}`,
        subject.kind === 'application'
          ? 'application_membership_required'
          : 'account_membership_required',
      );
  }
}

/** Reads reuse a recent answer; anything else asks Oxy again. */
function isWrite(req: Request): boolean {
  return req.method !== 'GET' && req.method !== 'HEAD';
}

/**
 * May the person behind `req` perform `action` on `applicationId`? Answers the
 * request itself on every "no" and returns `null`; returns the access otherwise.
 */
export async function authorizeApplication(
  req: Request,
  res: Response,
  applicationId: string,
  action: DashboardAction,
  access: OxyAccess,
): Promise<OxyApplicationAccess | null> {
  let granted: OxyApplicationAccess;
  try {
    granted = await access.applicationAccessFor(req as OxyAuthRequest, applicationId, {
      fresh: isWrite(req),
    });
  } catch (error) {
    if (!(error instanceof OxyAccessError)) throw error;
    sendOxyAccessError(res, error, { kind: 'application', id: applicationId });
    return null;
  }
  if (!allowsDashboardAction(granted.permissions, action)) {
    const permission = DASHBOARD_PERMISSIONS[action];
    sendError(
      res,
      403,
      'permission_error',
      `this action needs the ${permission} permission on the application`,
      'permission_required',
      permission,
    );
    return null;
  }
  return granted;
}

/**
 * What the person behind `req` may do on Oxy account `accountId`. Answers the
 * request itself on every "no" and returns `null`.
 */
export async function authorizeAccount(
  req: Request,
  res: Response,
  accountId: string,
  access: OxyAccess,
): Promise<OxyAccountAccess | null> {
  try {
    return await access.accountAccessFor(req as OxyAuthRequest, accountId, { fresh: isWrite(req) });
  } catch (error) {
    if (!(error instanceof OxyAccessError)) throw error;
    sendOxyAccessError(res, error, { kind: 'account', id: accountId });
    return null;
  }
}
