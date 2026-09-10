import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { safeFetch as realSafeFetch, SsrfRejection, UpstreamError } from "@oxy.so/core/server";
import { config } from "../config";
import type { SafeFetchFn } from "./webhookDispatcher";

/**
 * Delegates `/v1/dashboard/*` authorization to oxy-api's own Application RBAC
 * (spec §8, "zero RBAC duplication" hard rule) — this gateway never
 * re-implements `AccountMember`/`ApplicationPermission`. It forwards the
 * caller's OWN Oxy bearer to oxy-api `GET /applications/:applicationId`
 * (gated there by `requireAppPermission('app:read')`); a non-null
 * `application.callerMembership` in that response is the ENTIRE authorization
 * decision every `/v1/dashboard/*` route relies on (see `routes/dashboard.ts`).
 */
export interface AppMembershipResult {
  allowed: boolean;
}

/**
 * Cache TTL for a resolved membership decision. Membership changes (a
 * developer added to/removed from an Application's owning account) are rare,
 * so a bounded eventual-consistency window is an acceptable tradeoff against
 * a dashboard view firing several data requests per render each hitting
 * oxy-api (plan: "eventual-consistency of ≤60s is acceptable — document it").
 */
const MEMBERSHIP_CACHE_TTL_MS = 45_000;
/** How often expired cache entries are swept, so the Map cannot grow unbounded over the gateway's uptime. */
const MEMBERSHIP_CACHE_SWEEP_MS = 5 * 60 * 1000;
/** Hard cap on the oxy-api response body — generous for a serialized Application, bounds a misbehaving/compromised upstream. */
const MAX_RESPONSE_BYTES = 64 * 1024;

interface CacheEntry {
  allowed: boolean;
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
 * Only the field this module cares about — a non-null `callerMembership`
 * (shape irrelevant, only presence). Deliberately lenient about everything
 * else `serializeApplication` (oxy-api `routes/applications.ts`) returns, so
 * this gateway never needs to track that DTO's evolution field-by-field.
 */
const applicationResponseSchema = z.object({
  application: z.object({
    callerMembership: z.record(z.string(), z.unknown()).nullable(),
  }),
});

/**
 * Read an `IncomingMessage` body into a Buffer, aborting (and destroying the
 * stream) the moment it would exceed `maxBytes`. Mirrors the bounded-reader
 * pattern every other Oxy backend uses to consume a `safeFetch` response body
 * (e.g. oxy-api's `federation.service.ts`) — `safeFetch` itself does not
 * bound the body, so any caller that reads it (rather than just checking
 * `status` and discarding, like `webhookDispatcher.ts`) must.
 */
function readBodyLimited(response: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    response.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => finish(Buffer.concat(chunks, total)));
    response.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    response.on("close", () => finish(null));
  });
}

/**
 * Forward `userBearer` to oxy-api and resolve whether it carries a non-null
 * `callerMembership` for `applicationId`. ANY doubt — a non-200 status, an
 * SSRF rejection, a malformed/oversized body, an upstream timeout — resolves
 * to `false` (fail closed); the gateway never distinguishes WHY to the caller
 * (plan: "A 403/404 from oxy-api ⇒ not allowed — do not leak which").
 */
async function fetchCallerMembership(
  safeFetch: SafeFetchFn,
  oxyApiUrl: string,
  applicationId: string,
  userBearer: string,
): Promise<boolean> {
  let result;
  try {
    result = await safeFetch(`${oxyApiUrl}/applications/${encodeURIComponent(applicationId)}`, {
      headers: { Authorization: `Bearer ${userBearer}` },
    });
  } catch (error) {
    if (!(error instanceof SsrfRejection) && !(error instanceof UpstreamError)) {
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(
        `Peable dashboard membership check failed for application ${applicationId}: ${message}`,
      );
    }
    return false;
  }

  try {
    if (result.status !== 200) return false;
    const buffer = await readBodyLimited(result.response, MAX_RESPONSE_BYTES);
    if (!buffer || buffer.length === 0) return false;
    const parsed = applicationResponseSchema.safeParse(JSON.parse(buffer.toString("utf-8")));
    return parsed.success && parsed.data.application.callerMembership !== null;
  } catch {
    return false;
  } finally {
    result.response.destroy();
  }
}

/**
 * Resolve whether `userId` (authenticated by `userBearer`) is a member of
 * `applicationId`, per oxy-api's RBAC. Cache-first: a hit within
 * `MEMBERSHIP_CACHE_TTL_MS` never calls oxy-api at all.
 *
 * `userId` is not part of the plan's originally-sketched two-argument
 * interface, but IS required by its own caching requirement ("keyed
 * `${userId}:${applicationId}`") — the caller (`routes/dashboard.ts`) already
 * has it from `getRequiredOxyUserId(req)`, so it is taken explicitly here
 * rather than re-derived from the bearer.
 */
export async function assertAppMembership(
  userId: string,
  applicationId: string,
  userBearer: string,
  deps: { safeFetch?: SafeFetchFn; oxyApiUrl?: string; ttlMs?: number } = {},
): Promise<AppMembershipResult> {
  const cacheKey = `${userId}:${applicationId}`;
  const now = Date.now();
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { allowed: cached.allowed };
  }

  const safeFetch = deps.safeFetch ?? realSafeFetch;
  const oxyApiUrl = deps.oxyApiUrl ?? config.oxyApiUrl;
  const ttlMs = deps.ttlMs ?? MEMBERSHIP_CACHE_TTL_MS;
  const allowed = await fetchCallerMembership(safeFetch, oxyApiUrl, applicationId, userBearer);
  membershipCache.set(cacheKey, { allowed, expiresAt: now + ttlMs });
  return { allowed };
}
