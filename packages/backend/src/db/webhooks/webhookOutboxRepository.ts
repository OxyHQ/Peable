/**
 * The outbox side of `webhook_deliveries` — enqueue, claim, record.
 *
 * Separate module from `webhookDeliveryRepository.ts`, which owns the READS the
 * merchant API and dashboard make. These are the writes the dispatcher makes,
 * and they have a property those reads do not: `claimDueDeliveries` must be
 * safe to run from two processes at once, which is a statement-level concern
 * rather than a query-shape one.
 */
import { and, eq, isNotNull, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { webhookDeliveries, webhookEndpoints } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/** A claimed row, with everything an attempt needs and nothing it does not. */
export interface ClaimedDeliveryRow {
  readonly id: string;
  readonly merchantId: string;
  /** The event's PRIMARY key. */
  readonly eventId: string;
  readonly endpointId: string;
  readonly attempts: number;
}

const CLAIMED_COLUMNS = {
  id: webhookDeliveries.id,
  merchantId: webhookDeliveries.merchantId,
  eventId: webhookDeliveries.eventId,
  endpointId: webhookDeliveries.endpointId,
  attempts: webhookDeliveries.attempts,
} as const;

/**
 * Fan an event out: one pending delivery per ENABLED endpoint of the merchant
 * whose `enabled_events` names the type or `*`.
 *
 * Takes a `DatabaseOrTransaction` and is meant to be handed the TRANSACTION of
 * the change the event records: the whole value of this table is that the row
 * and the state change that caused it commit together (ADR 0001 D7).
 *
 * A read and then one multi-row insert, rather than `INSERT … SELECT`, because
 * the ids are uuid v7 minted here (`CONVENTIONS.md` §Ids) — that is what keeps
 * the delivery log's keyset walk in creation order. The array overlap `&&` is
 * the subscription match: `{*}` or the exact type.
 *
 * @returns how many deliveries were enqueued.
 */
export async function enqueueEventDeliveries(
  db: DatabaseOrTransaction,
  event: { readonly id: string; readonly merchantId: string; readonly type: string },
): Promise<number> {
  const endpoints = await db
    .select({ id: webhookEndpoints.id, url: webhookEndpoints.url })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.merchantId, event.merchantId),
        eq(webhookEndpoints.status, 'enabled'),
        sql`${webhookEndpoints.enabledEvents} && ARRAY['*', ${event.type}]::text[]`,
      ),
    )
    .orderBy(webhookEndpoints.id);
  if (endpoints.length === 0) return 0;
  // Due immediately: the backoff schedule starts after the FIRST failure.
  const now = new Date();
  await db.insert(webhookDeliveries).values(
    endpoints.map((endpoint) => ({
      id: uuidv7(),
      merchantId: event.merchantId,
      eventId: event.id,
      endpointId: endpoint.id,
      url: endpoint.url,
      nextAttemptAt: now,
    })),
  );
  return endpoints.length;
}

/**
 * Enqueue one delivery of `eventId` to one endpoint — a test event, which is
 * sent to the endpoint it names and no other, and a manual redelivery.
 */
export async function enqueueDelivery(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly eventId: string;
    readonly endpointId: string;
    readonly url: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      id: uuidv7(),
      merchantId: params.merchantId,
      eventId: params.eventId,
      endpointId: params.endpointId,
      url: params.url,
      nextAttemptAt: new Date(),
    })
    .returning({ id: webhookDeliveries.id });
  if (!row) throw new Error('webhook delivery enqueue returned no row');
  return row.id;
}

export interface ClaimDueParams {
  readonly limit: number;
  /** Identifies the claiming pass, so an abandoned lease is attributable. */
  readonly leaseOwner: string;
  readonly leaseMs: number;
  /** Injectable clock, so a suite can make a row due without waiting. */
  readonly now?: Date;
}

/**
 * Claim up to `limit` due deliveries, in ONE statement.
 *
 * ## What makes this safe, and what `SKIP LOCKED` actually buys
 *
 * - **Exactly one claimant** comes from the LIVE-LEASE predicate plus the fact
 *   that this is one statement. A blocked claimant re-evaluates the row after
 *   the lock clears (READ COMMITTED), sees the lease the winner just wrote, and
 *   matches nothing. Splitting this into a select and a later update is what
 *   would hand the same row to both.
 * - **`SKIP LOCKED` buys NON-BLOCKING**, not correctness. MEASURED on
 *   PostgreSQL 16.13, with one dispatcher holding its transaction open for
 *   400ms: with `SKIP LOCKED` the second returns in 8ms with nothing; with a
 *   plain `FOR UPDATE` it returns in 403ms with nothing.
 *
 * A row is due when it is `pending`, its `next_attempt_at` has passed, and it
 * carries no LIVE lease. The expired-lease branch is the recovery path for a
 * dispatcher that died mid-attempt.
 */
export async function claimDueDeliveries(
  db: DatabaseOrTransaction,
  params: ClaimDueParams,
): Promise<ClaimedDeliveryRow[]> {
  const now = params.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + params.leaseMs);

  const due = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.lastStatus, 'pending'),
        isNotNull(webhookDeliveries.nextAttemptAt),
        lte(webhookDeliveries.nextAttemptAt, now),
        or(
          sql`${webhookDeliveries.leaseExpiresAt} is null`,
          lte(webhookDeliveries.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(params.limit)
    .for('update', { skipLocked: true });

  return db
    .update(webhookDeliveries)
    .set({ leaseOwner: params.leaseOwner, leaseExpiresAt })
    .where(sql`${webhookDeliveries.id} in (${due})`)
    .returning(CLAIMED_COLUMNS);
}

/** What one attempt concluded. */
export type DeliveryOutcome =
  | { readonly kind: 'delivered' }
  /** The target refused in a way no retry can fix. Terminal. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** Transient. Retried until the attempt budget runs out. */
  | { readonly kind: 'retry'; readonly reason: string };

export interface RecordAttemptParams {
  readonly id: string;
  readonly outcome: DeliveryOutcome;
  /** The URL this attempt actually POSTed to. */
  readonly url: string;
  /** When the next attempt becomes due; `null` exhausts the budget. */
  readonly nextAttemptAt: Date | null;
}

/**
 * Record an attempt's outcome and release the lease.
 *
 * The lease is cleared on EVERY path, terminal or not. A row left holding one
 * after its dispatcher moved on is invisible to the claim query until the lease
 * expires.
 */
export async function recordDeliveryAttempt(
  db: DatabaseOrTransaction,
  params: RecordAttemptParams,
): Promise<void> {
  const { outcome } = params;
  const lastStatus =
    outcome.kind === 'delivered'
      ? 'delivered'
      : outcome.kind === 'refused'
        ? 'failed'
        : params.nextAttemptAt === null
          ? 'dead'
          : 'pending';

  await db
    .update(webhookDeliveries)
    .set({
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      lastStatus,
      delivered: lastStatus === 'delivered',
      url: params.url,
      lastError: outcome.kind === 'delivered' ? null : outcome.reason,
      // `webhook_deliveries_schedule_agrees_check` ties this to the status.
      nextAttemptAt: lastStatus === 'pending' ? params.nextAttemptAt : null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(webhookDeliveries.id, params.id));
}

/**
 * Release a claim without recording an attempt.
 *
 * For a claimed row that is undeliverable for a reason that is not the
 * target's answer — its endpoint is disabled. Counting that as an attempt
 * would burn the budget on a condition no attempt was made against.
 */
export async function releaseDeliveryClaim(
  db: DatabaseOrTransaction,
  id: string,
  params: { readonly nextAttemptAt: Date | null; readonly reason: string },
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      lastStatus: params.nextAttemptAt === null ? 'failed' : 'pending',
      delivered: false,
      lastError: params.reason,
      nextAttemptAt: params.nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(webhookDeliveries.id, id));
}
