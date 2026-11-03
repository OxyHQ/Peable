import { and, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { idempotencyKeys } from '../schema';
import type { IdempotencyKeyStatus } from '../schema/valueSets';
import type { DatabaseOrTransaction } from '../postgres';

/** How long a key answers with what it first answered (ADR 0014 D3). */
export const IDEMPOTENCY_KEY_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long a request holds its key before a retry of the SAME request may take
 * it over.
 *
 * Long enough that no live request outlives it: every provider call is bounded
 * at 10 seconds with no network retries (`providers/stripe/client.ts`), and the
 * longest route makes a handful. Short enough that a task killed mid-request
 * blocks its caller's retries for one minute, not for the whole 24 hours. If a
 * request does outlive it, the business idempotency beneath this layer is what
 * stops the takeover moving money twice — which is why that layer stays.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 60;

/** The request a key is bound to: the method, the path and the body's hash. */
export interface IdempotentRequest {
  readonly merchantId: string;
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly requestHash: string;
}

/** A key some earlier request holds or completed. */
export interface IdempotencyKeyRow {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly requestHash: string;
  readonly status: IdempotencyKeyStatus;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
}

const KEY_COLUMNS = {
  id: idempotencyKeys.id,
  method: idempotencyKeys.method,
  path: idempotencyKeys.path,
  requestHash: idempotencyKeys.requestHash,
  status: idempotencyKeys.status,
  responseStatus: idempotencyKeys.responseStatus,
  responseBody: idempotencyKeys.responseBody,
} as const;

/** The database clock at the precision every `timestamptz` here is stored at. */
const NOW = sql`date_trunc('milliseconds', now())`;

function secondsFromNow(seconds: number) {
  // `sql.raw`: the interval is a constant of this module, and a bound
  // parameter inside `make_interval` would be one more round of casting for
  // a value nobody supplies.
  return sql`${NOW} + ${sql.raw(`interval '${String(seconds)} seconds'`)}`;
}

/**
 * Claim `request.key` for this request, in ONE statement.
 *
 * The insert wins when the key is new. On a conflict it wins only over a row
 * that no longer binds anybody:
 *
 * - an EXPIRED row (past its 24 hours, not yet swept) — the key is free again,
 *   and the claim starts a fresh window;
 * - an `in_progress` row whose LEASE ran out, for the SAME method, path and
 *   body — the request that held it died, and this is its retry. The 24-hour
 *   window keeps running from the first sight of the key.
 *
 * Anything else — a live lease, a completed answer, a different request —
 * returns `null`, and the caller reads the row to decide which.
 *
 * Read-then-insert would let two concurrent first requests both see nothing
 * and both run; the unique constraint plus `on conflict` makes exactly one of
 * them the owner.
 *
 * @returns the claim's id, which every later write names — or `null`.
 */
export async function claimIdempotencyKey(
  db: DatabaseOrTransaction,
  request: IdempotentRequest,
): Promise<string | null> {
  const claimId = uuidv7();
  const expired = sql`${idempotencyKeys.expiresAt} <= now()`;
  const [row] = await db
    .insert(idempotencyKeys)
    .values({
      id: claimId,
      merchantId: request.merchantId,
      key: request.key,
      method: request.method,
      path: request.path,
      requestHash: request.requestHash,
      status: 'in_progress',
      leaseExpiresAt: secondsFromNow(IDEMPOTENCY_LEASE_SECONDS),
      createdAt: NOW,
      expiresAt: secondsFromNow(IDEMPOTENCY_KEY_TTL_SECONDS),
    })
    .onConflictDoUpdate({
      target: [idempotencyKeys.merchantId, idempotencyKeys.key],
      set: {
        id: claimId,
        method: request.method,
        path: request.path,
        requestHash: request.requestHash,
        status: 'in_progress',
        responseStatus: null,
        responseBody: null,
        leaseExpiresAt: secondsFromNow(IDEMPOTENCY_LEASE_SECONDS),
        createdAt: sql`case when ${expired} then ${NOW} else ${idempotencyKeys.createdAt} end`,
        expiresAt: sql`case when ${expired} then ${secondsFromNow(IDEMPOTENCY_KEY_TTL_SECONDS)} else ${idempotencyKeys.expiresAt} end`,
      },
      setWhere: sql`${expired} or (
        ${idempotencyKeys.status} = 'in_progress'
        and ${idempotencyKeys.leaseExpiresAt} <= now()
        and ${idempotencyKeys.method} = ${request.method}
        and ${idempotencyKeys.path} = ${request.path}
        and ${idempotencyKeys.requestHash} = ${request.requestHash}
      )`,
    })
    .returning({ id: idempotencyKeys.id });
  return row?.id ?? null;
}

/**
 * The live row for a key, or `null` when there is none — never released,
 * never expired. Expiry is decided here, not by the sweeper: the sweep lags,
 * and an unswept expired row must not answer anybody.
 */
export async function findIdempotencyKey(
  db: DatabaseOrTransaction,
  merchantId: string,
  key: string,
): Promise<IdempotencyKeyRow | null> {
  const [row] = await db
    .select(KEY_COLUMNS)
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.merchantId, merchantId),
        eq(idempotencyKeys.key, key),
        gt(idempotencyKeys.expiresAt, sql`now()`),
      ),
    );
  return row ?? null;
}

/**
 * Store the answer to a claimed request. A no-op when the claim was taken over
 * (its lease ran out and a retry now owns the key): that retry's answer is the
 * one to keep.
 *
 * @returns whether this claim was still the owner.
 */
export async function completeIdempotencyKey(
  db: DatabaseOrTransaction,
  claimId: string,
  response: { status: number; body: unknown },
): Promise<boolean> {
  const rows = await db
    .update(idempotencyKeys)
    .set({
      status: 'completed',
      responseStatus: response.status,
      responseBody: response.body,
      leaseExpiresAt: null,
    })
    .where(and(eq(idempotencyKeys.id, claimId), eq(idempotencyKeys.status, 'in_progress')))
    .returning({ id: idempotencyKeys.id });
  return rows.length > 0;
}

/**
 * Give the key back, so a retry runs the request again. For a 5xx, and for a
 * response this layer could not capture.
 */
export async function releaseIdempotencyKey(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.id, claimId), eq(idempotencyKeys.status, 'in_progress')));
}
