import { z } from 'zod';
import { OxyApiError, OxyServices } from '@oxy.so/core';
import { config } from '../config';

/**
 * Delegates `/v1/dashboard/*` authorization to oxy-api's own Application RBAC
 * (spec §8, "zero RBAC duplication" hard rule) — this gateway never
 * re-implements `AccountMember`/`ApplicationPermission`. It asks Oxy for the
 * application WITH THE CALLER'S OWN BEARER (`apps.get`, `GET
 * /applications/:applicationId`, gated there by `requireAppPermission
 * ('app:read')` over the application's owning account); a non-null
 * `callerMembership` in that answer is the ENTIRE authorization decision every
 * `/v1/dashboard/*` route relies on (see `routes/dashboard.ts`). Oxy resolves
 * it for the HUMAN operator, so a person acting as their organization is
 * answered for themselves.
 *
 * ## Through the Oxy SDK, as the other Oxy backends ask
 *
 * The same shape as Mercaria's account-graph reads: a SHORT-LIVED `OxyServices`
 * client per check, carrying the caller's bearer (never set on a shared
 * client, where it would leak into a concurrent request), pointed at
 * `config.oxyApiUrl`. Not `OxyServer.appPermissionsFor`: that reads the
 * application's OWN declared roles (`/roles/me`), which an organization's
 * owner holds none of, not membership of the account that owns the app.
 *
 * It used to be a hand-rolled request through `safeFetch`, the SSRF guard for
 * URLs a MERCHANT supplies. Inside the Oxy VPC `api.oxy.so` is split-horizon —
 * it answers with the internal load balancer, a private IP — so the guard
 * refused every check before it left the process, silently, and the refusal
 * was cached as "not a member": every Orbit screen told the application's own
 * owner "you are not a member of this application".
 *
 * ## Outcomes, translated once
 *
 * - 200 with a membership → allowed.
 * - 403 / 404, or 200 with `callerMembership: null` → an ANSWER: not a member
 *   (Oxy does not say which, and neither does the gateway). Cached.
 * - 401 → the caller's session is no longer valid: sign in again. Not cached.
 * - anything else (unreachable, timeout, 5xx, an answer off the contract) →
 *   Oxy is unavailable: logged, fail closed with a 503. Never cached.
 */
export interface AppMembershipResult {
  allowed: boolean;
  /**
   * Oxy could not give an answer. Still `allowed: false` — the gate fails
   * closed — but the caller answers it as an outage (503), never as a refusal.
   */
  unavailable?: true;
  /** Oxy refused the caller's bearer itself (401): they must sign in again. */
  unauthenticated?: true;
  /** The caller's effective application permissions (`billing:manage`, …),
   * exactly as oxy-api reports them. Absent when oxy-api reported none. */
  permissions?: readonly string[];
  /** Whether oxy-api marks the application as Oxy's own (official, or a
   * first-party/internal/system type). Peable Tax lets only these calculate on
   * the platform's provider account, whose seller is Oxy's legal entity. */
  official?: boolean;
  /**
   * The Oxy account that owns the application, from the same response — the
   * account a member acts for. Read only by the merchant-avatar ownership check
   * (`services/oxyFiles/fileOwnership.ts`); absent when not allowed or when
   * oxy-api did not say.
   */
  ownerAccountId?: string;
}

/** The part of an Oxy client this module uses — `OxyServices`, or a test double. */
export interface MembershipClient {
  apps: { get(applicationId: string): Promise<unknown> };
  dispose?(): void;
}

/** A client for ONE caller's bearer. */
export type MembershipClientFactory = (accessToken: string, baseURL: string) => MembershipClient;

/** Whole-request deadline for one check; the dashboard request waits on it. */
const MEMBERSHIP_TIMEOUT_MS = 5_000;

const sdkClientFor: MembershipClientFactory = (accessToken, baseURL) => {
  // No SDK retry: a check sits inside a dashboard request, and an outage is
  // answered 503 at once — Orbit retries, the gateway does not stall.
  const client = new OxyServices({
    baseURL,
    enableRetry: false,
    requestTimeout: MEMBERSHIP_TIMEOUT_MS,
  });
  client.session.setAccessToken(accessToken);
  return client;
};

/**
 * Cache TTL for a DEFINITIVE membership decision. Membership changes (a
 * developer added to/removed from an Application's owning account) are rare,
 * so a bounded eventual-consistency window is an acceptable tradeoff against
 * a dashboard view firing several data requests per render each hitting
 * oxy-api (plan: "eventual-consistency of ≤60s is acceptable — document it").
 */
const MEMBERSHIP_CACHE_TTL_MS = 45_000;
/** How often expired cache entries are swept, so the Map cannot grow unbounded over the gateway's uptime. */
const MEMBERSHIP_CACHE_SWEEP_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: AppMembershipResult;
  expiresAt: number;
}

/** Keyed `${userId}:${applicationId}` — see the module doc above. */
const membershipCache = new Map<string, CacheEntry>();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of membershipCache) {
    if (entry.expiresAt <= now) membershipCache.delete(key);
  }
}, MEMBERSHIP_CACHE_SWEEP_MS);
sweepTimer.unref?.();

/**
 * Only the fields this module cares about. Deliberately lenient about
 * everything else `serializeApplication` (oxy-api `routes/applications.ts`)
 * returns, so this gateway never needs to track that DTO field-by-field.
 */
const applicationSchema = z.object({
  callerMembership: z
    .object({ permissions: z.array(z.string()).optional() })
    .passthrough()
    .nullable()
    .optional(),
  isOfficial: z.boolean().optional(),
  type: z.string().optional(),
  ownerAccountId: z.string().min(1).optional(),
});
const OFFICIAL_TYPES = new Set(['first_party', 'internal', 'system']);

const NOT_A_MEMBER: AppMembershipResult = { allowed: false };
const UNAVAILABLE: AppMembershipResult = { allowed: false, unavailable: true };
const UNAUTHENTICATED: AppMembershipResult = { allowed: false, unauthenticated: true };

/** Why a check did not end in "member": logged with the request id, never the bearer. */
function report(applicationId: string, reason: string, requestId: string | undefined): void {
  console.warn(
    `[dashboard.membership] application=${applicationId} request=${requestId ?? '-'} ${reason}`,
  );
}

function describe(error: unknown): string {
  if (error instanceof OxyApiError) return `OxyApiError ${error.status} ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function fetchCallerMembership(
  clientFor: MembershipClientFactory,
  oxyApiUrl: string,
  applicationId: string,
  userBearer: string,
  requestId: string | undefined,
): Promise<AppMembershipResult> {
  const client = clientFor(userBearer, oxyApiUrl);
  let application: unknown;
  try {
    application = await client.apps.get(applicationId);
  } catch (error) {
    if (error instanceof OxyApiError && (error.status === 403 || error.status === 404)) {
      report(applicationId, `not a member (oxy-api ${error.status})`, requestId);
      return NOT_A_MEMBER;
    }
    if (error instanceof OxyApiError && error.status === 401) {
      report(applicationId, 'oxy-api refused the bearer (401)', requestId);
      return UNAUTHENTICATED;
    }
    report(applicationId, `oxy-api unavailable (${describe(error)})`, requestId);
    return UNAVAILABLE;
  } finally {
    client.dispose?.();
  }

  const parsed = applicationSchema.safeParse(application);
  if (!parsed.success) {
    report(applicationId, 'oxy-api answer does not match the application contract', requestId);
    return UNAVAILABLE;
  }
  const { callerMembership, isOfficial, type, ownerAccountId } = parsed.data;
  if (!callerMembership) {
    report(applicationId, 'not a member (no callerMembership)', requestId);
    return NOT_A_MEMBER;
  }
  return {
    allowed: true,
    ...(ownerAccountId ? { ownerAccountId } : {}),
    ...(callerMembership.permissions ? { permissions: callerMembership.permissions } : {}),
    official: isOfficial === true || (type !== undefined && OFFICIAL_TYPES.has(type)),
  };
}

/**
 * Resolve whether `userId` (authenticated by `userBearer`) is a member of
 * `applicationId`, per oxy-api's RBAC. Cache-first: a hit within
 * `MEMBERSHIP_CACHE_TTL_MS` never calls oxy-api at all. Only ANSWERS are
 * cached — an outage or a refused bearer is asked again on the next request,
 * never remembered as "not a member".
 *
 * `userId` keys the cache (`${userId}:${applicationId}`); the caller
 * (`routes/dashboard.ts`) already has it from `getRequiredOxyUserId(req)`.
 */
export async function assertAppMembership(
  userId: string,
  applicationId: string,
  userBearer: string,
  deps: {
    client?: MembershipClientFactory;
    oxyApiUrl?: string;
    ttlMs?: number;
    requestId?: string;
  } = {},
): Promise<AppMembershipResult> {
  const cacheKey = `${userId}:${applicationId}`;
  const now = Date.now();
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = await fetchCallerMembership(
    deps.client ?? sdkClientFor,
    deps.oxyApiUrl ?? config.oxyApiUrl,
    applicationId,
    userBearer,
    deps.requestId,
  );
  if (!result.unavailable && !result.unauthenticated) {
    membershipCache.set(cacheKey, {
      result,
      expiresAt: now + (deps.ttlMs ?? MEMBERSHIP_CACHE_TTL_MS),
    });
  }
  return result;
}
