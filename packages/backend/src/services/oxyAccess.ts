import type { Request, Response } from 'express';
import { z } from 'zod';
import { OxyApiError, OxyServices } from '@oxy.so/core';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  allowsDashboardAction,
  DASHBOARD_PERMISSIONS,
  type DashboardAction,
} from '@peable.to/contracts/vocabulary';
import { config } from '../config';
import { sendError } from '../lib/http';
import { requestIdOf } from '../lib/requestId';

/**
 * The ONE way a Peable surface asks Oxy what a signed-in person may do: Orbit's
 * dashboard, Peable Tax, the contribution routes and every Orbit upload. Peable
 * keeps no membership copy and reads no role name (spec §8, "zero RBAC
 * duplication"); oxy-api resolves role + grants − revokes into permissions, and
 * this module reads them.
 *
 * ## Two questions, both asked WITH THE CALLER'S OWN BEARER
 *
 * - **Application A** — `apps.get(A)`: oxy-api answers it only to a holder of
 *   `app:read` over the account that owns A, and `callerMembership.permissions`
 *   is the person's APPLICATION-lane vocabulary (`app:update`,
 *   `webhooks:update`, `billing:manage`, …). Not `OxyServer.appPermissionsFor`:
 *   that reads the application's OWN declared roles (`/roles/me`), a different
 *   question an organization's owner holds none of.
 * - **Account X** — `accounts.get(X)`: what the account is (`kind`) and the
 *   caller's effective permissions over it.
 *
 * Oxy resolves both for the HUMAN operator, so a person acting as their
 * organization is answered for themselves. A request authenticated by a
 * SERVICE token is refused before Oxy is asked: these surfaces act for a
 * person, never through delegation.
 *
 * ## Outcomes, translated once ({@link sendOxyAccessError})
 *
 * - an answer → the access, cached ({@link ACCESS_CACHE_TTL_MS}) per
 *   (question, user, session). Only answers that LET SOMEONE IN are cached, and
 *   a write (`fresh`) always asks again, so a revoked permission stops a write
 *   at once and a read within the TTL.
 * - 401 → `session_required`: sign in again.
 * - 403 / 404, or no `callerMembership` → `denied` (Oxy does not say which,
 *   and neither does Peable).
 * - anything else (unreachable, timeout, 5xx, an answer off the contract) →
 *   `unavailable`: logged with the request id, answered 503, never remembered
 *   as "no".
 *
 * ## The per-check client is the one thing `@oxy.so/core` will own
 *
 * The SDK has no caller-bound client yet, so {@link callerClient} builds a
 * short-lived `OxyServices` for one bearer (never `setAccessToken` on the shared
 * `OxyServer`, where it would leak into a concurrent request), uncached and
 * disposed after the one call. When `@oxy.so/core` ships
 * `oxy.applicationAccessFor(req, id)` / `oxy.accountAccessFor(req, id)`,
 * {@link createOxyAccess} becomes those two calls plus the error translation,
 * and `callerClient`, the schemas and the cache here are deleted.
 */

export type OxyAccessFailure = 'session_required' | 'denied' | 'unavailable';

/** Why Oxy did not let the person in. Never carries the bearer. */
export class OxyAccessError extends Error {
  readonly reason: OxyAccessFailure;
  constructor(reason: OxyAccessFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OxyAccessError';
    this.reason = reason;
  }
}

/** What the caller may do on one application, as oxy-api reports it. */
export interface ApplicationAccess {
  readonly applicationId: string;
  /** The Oxy account that owns the application — the account a member acts for. */
  readonly ownerAccountId: string;
  /** The caller's effective application permissions (`app:read`, `billing:manage`, …). */
  readonly permissions: readonly string[];
  /**
   * Oxy's own application (official, or a first-party/internal/system type).
   * Peable Tax lets only these calculate on the platform's provider account,
   * whose seller is Oxy's legal entity.
   */
  readonly official: boolean;
  /** `status === 'active'`: only an active application holds a merchant. */
  readonly active: boolean;
}

/** What the caller may do on one Oxy account. */
export interface AccountAccess {
  readonly accountId: string;
  /** `personal`, `organization`, … — what the account IS, not what the caller is to it. */
  readonly kind: string;
  /** The caller's effective account permissions; empty on their own (`self`) account. */
  readonly permissions: readonly string[];
}

export interface AccessOptions {
  /** Skip the cache and ask Oxy (the answer still refreshes it). Every write passes it. */
  readonly fresh?: boolean;
}

/** The seam every surface (and every test) is handed. */
export interface OxyAccess {
  application(
    req: Request,
    applicationId: string,
    options?: AccessOptions,
  ): Promise<ApplicationAccess>;
  account(req: Request, accountId: string, options?: AccessOptions): Promise<AccountAccess>;
}

/** The part of an Oxy client this module uses — `OxyServices`, or a test double. */
export interface CallerClient {
  apps: { get(applicationId: string): Promise<unknown> };
  accounts: { get(accountId: string): Promise<unknown> };
  dispose?(): void;
}

/** Whole-request deadline for one check; the surface's request waits on it. */
const ACCESS_TIMEOUT_MS = 5_000;

/**
 * How long an answer that lets someone in is reused for READS — the SDK's own
 * `APP_PERMISSIONS_CACHE_TTL_MS`. A screen fires several reads per render, each
 * of which would otherwise reach oxy-api.
 */
export const ACCESS_CACHE_TTL_MS = 30_000;
/** Past this many entries the expired ones are dropped; past it again, all of them. */
const ACCESS_CACHE_MAX_ENTRIES = 10_000;

/**
 * A client for ONE caller's bearer. No retry — a check sits inside a request,
 * and an outage is answered 503 at once (the client retries, the gateway does
 * not stall) — and no cache: the answer this module keeps is the only one.
 */
export function callerClient(accessToken: string, baseURL: string): CallerClient {
  const client = new OxyServices({
    baseURL,
    enableCache: false,
    enableRetry: false,
    requestTimeout: ACCESS_TIMEOUT_MS,
  });
  client.session.setAccessToken(accessToken);
  return client;
}

/** Only the fields read here; lenient about the rest of oxy-api's DTOs. */
const membershipSchema = z
  .object({ permissions: z.array(z.string()) })
  .passthrough()
  .nullable()
  .optional();
const applicationSchema = z.object({
  ownerAccountId: z.string().min(1),
  status: z.string(),
  isOfficial: z.boolean().optional(),
  type: z.string().optional(),
  callerMembership: membershipSchema,
});
const accountSchema = z.object({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  relationship: z.string().optional(),
  callerMembership: membershipSchema,
});
const OFFICIAL_TYPES = new Set(['first_party', 'internal', 'system']);

function describe(error: unknown): string {
  if (error instanceof OxyApiError) return `OxyApiError ${error.status} ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Translate whatever the SDK threw into one of the three outcomes. */
function failureOf(error: unknown): OxyAccessError {
  if (error instanceof OxyApiError && error.status === 401) {
    return new OxyAccessError('session_required', 'oxy-api refused the bearer (401)', {
      cause: error,
    });
  }
  if (error instanceof OxyApiError && (error.status === 403 || error.status === 404)) {
    return new OxyAccessError('denied', `oxy-api answered ${error.status}`, { cause: error });
  }
  return new OxyAccessError('unavailable', `oxy-api unavailable (${describe(error)})`, {
    cause: error,
  });
}

interface CacheEntry {
  readonly value: ApplicationAccess | AccountAccess;
  readonly expiresAt: number;
}

export function createOxyAccess(
  deps: {
    readonly oxyApiUrl?: string;
    readonly clientFor?: (accessToken: string, baseURL: string) => CallerClient;
    readonly ttlMs?: number;
  } = {},
): OxyAccess {
  const baseURL = deps.oxyApiUrl ?? config.oxyApiUrl;
  const clientFor = deps.clientFor ?? callerClient;
  const ttlMs = deps.ttlMs ?? ACCESS_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  const remember = (key: string, value: CacheEntry['value']) => {
    const now = Date.now();
    if (cache.size >= ACCESS_CACHE_MAX_ENTRIES) {
      for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
      if (cache.size >= ACCESS_CACHE_MAX_ENTRIES) cache.clear();
    }
    cache.set(key, { value, expiresAt: now + ttlMs });
  };

  /** Ask Oxy one question with the caller's bearer, through the cache. */
  async function ask<T extends CacheEntry['value']>(
    req: Request,
    question: string,
    options: AccessOptions | undefined,
    call: (client: CallerClient) => Promise<unknown>,
    read: (answer: unknown) => T | null,
  ): Promise<T> {
    const authed = req as OxyAuthRequest;
    if (authed.serviceApp) {
      throw new OxyAccessError('session_required', 'a service credential acts for no person');
    }
    const { userId, accessToken } = authed;
    if (!userId || !accessToken) {
      throw new OxyAccessError('session_required', 'no user session on the request');
    }
    const key = `${question}|${userId}|${authed.sessionId ?? accessToken}`;
    if (!options?.fresh) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    }

    const client = clientFor(accessToken, baseURL);
    let answer: unknown;
    try {
      answer = await call(client);
    } catch (error) {
      throw failureOf(error);
    } finally {
      client.dispose?.();
    }
    const value = read(answer);
    if (!value) throw new OxyAccessError('denied', 'no membership in the answer');
    remember(key, value);
    return value;
  }

  const offContract = () =>
    new OxyAccessError('unavailable', 'oxy-api answer does not match the contract');

  return {
    application: (req, applicationId, options) =>
      ask(
        req,
        `application:${applicationId}`,
        options,
        (client) => client.apps.get(applicationId),
        (answer) => {
          const parsed = applicationSchema.safeParse(answer);
          if (!parsed.success) throw offContract();
          const { callerMembership, ownerAccountId, status, isOfficial, type } = parsed.data;
          if (!callerMembership) return null;
          return {
            applicationId,
            ownerAccountId,
            permissions: callerMembership.permissions,
            official: isOfficial === true || (type !== undefined && OFFICIAL_TYPES.has(type)),
            active: status === 'active',
          };
        },
      ),
    account: (req, accountId, options) =>
      ask(
        req,
        `account:${accountId}`,
        options,
        (client) => client.accounts.get(accountId),
        (answer) => {
          const parsed = accountSchema.safeParse(answer);
          if (!parsed.success) throw offContract();
          const { callerMembership, relationship, kind } = parsed.data;
          // The caller's own account carries no membership row: it is theirs.
          if (!callerMembership && relationship !== 'self') return null;
          return {
            accountId: parsed.data.accountId,
            kind,
            permissions: callerMembership?.permissions ?? [],
          };
        },
      ),
  };
}

/** The process's one instance. */
export const oxyAccess: OxyAccess = createOxyAccess();

/** The canonical HTTP answer for each outcome — every surface answers the same way. */
export function sendOxyAccessError(
  res: Response,
  error: OxyAccessError,
  subject: { readonly kind: 'application' | 'account'; readonly id: string },
): void {
  console.warn(
    `[oxy.access] ${subject.kind}=${subject.id} request=${requestIdOf(res) ?? '-'} ${error.reason}: ${error.message}`,
  );
  switch (error.reason) {
    case 'session_required':
      sendError(
        res,
        401,
        'authentication_error',
        'your Oxy session is no longer valid; sign in again',
        'session_invalid',
      );
      return;
    case 'denied':
      sendError(
        res,
        403,
        'permission_error',
        `you are not a member of this ${subject.kind}`,
        subject.kind === 'application'
          ? 'application_membership_required'
          : 'account_membership_required',
      );
      return;
    case 'unavailable':
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
  }
}

/** Reads reuse a recent answer; anything else asks Oxy again. */
function isWrite(req: Request): boolean {
  return req.method !== 'GET' && req.method !== 'HEAD';
}

/**
 * May the person behind `req` perform `action` on `applicationId`? Answers the
 * request itself on every "no" and returns `null`; returns the access otherwise.
 * The action's permission comes from `DASHBOARD_PERMISSIONS`, the map Orbit
 * reads too.
 */
export async function authorizeApplication(
  req: Request,
  res: Response,
  applicationId: string,
  action: DashboardAction,
  access: OxyAccess = oxyAccess,
): Promise<ApplicationAccess | null> {
  let granted: ApplicationAccess;
  try {
    granted = await access.application(req, applicationId, { fresh: isWrite(req) });
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
  access: OxyAccess = oxyAccess,
): Promise<AccountAccess | null> {
  try {
    return await access.account(req, accountId, { fresh: isWrite(req) });
  } catch (error) {
    if (!(error instanceof OxyAccessError)) throw error;
    sendOxyAccessError(res, error, { kind: 'account', id: accountId });
    return null;
  }
}
