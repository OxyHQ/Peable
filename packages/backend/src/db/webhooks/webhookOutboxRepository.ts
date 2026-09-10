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
import type { WebhookEvent, WebhookEventType } from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { webhookDeliveries } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/** A claimed row, with everything an attempt needs and nothing it does not. */
export interface ClaimedDeliveryRow {
  readonly id: string;
  readonly merchantId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

const CLAIMED_COLUMNS = {
  id: webhookDeliveries.id,
  merchantId: webhookDeliveries.merchantId,
  eventId: webhookDeliveries.eventId,
  eventType: webhookDeliveries.eventType,
  payload: webhookDeliveries.payload,
  attempts: webhookDeliveries.attempts,
} as const;

export interface EnqueueWebhookParams {
  readonly merchantId: string;
  /** The INTERNAL id of the intent the event is about, not its `pi_…`. */
  readonly paymentIntentId: string;
  readonly event: WebhookEvent;
  /** The merchant's endpoint as of enqueue. Re-read at each attempt. */
  readonly url: string;
}

/**
 * Write the promise.
 *
 * Takes a `DatabaseOrTransaction` and is meant to be handed a TRANSACTION: the
 * whole value of this table is that the row and the state change that caused it
 * commit together. Enqueuing after the commit reintroduces exactly the window
 * ADR 0001 D7 closed — a crash there loses the event with the intent already
 * settled and nothing anywhere recording that a merchant was never told.
 */
export async function enqueueWebhook(
  db: DatabaseOrTransaction,
  params: EnqueueWebhookParams
): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      id: uuidv7(),
      merchantId: params.merchantId,
      paymentIntentId: params.paymentIntentId,
      eventId: params.event.id,
      eventType: params.event.type,
      payload: params.event as unknown as Record<string, unknown>,
      url: params.url,
      // `attempts`, `delivered` and `last_status` take their column defaults —
      // 0, false, 'pending'. Due immediately: the backoff schedule starts after
      // the FIRST failure, not before the first try.
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
 * Two things, and they are commonly conflated:
 *
 * - **Exactly one claimant** comes from the LIVE-LEASE predicate plus the fact
 *   that this is one statement. A blocked claimant re-evaluates the row after
 *   the lock clears (READ COMMITTED), sees the lease the winner just wrote, and
 *   matches nothing. Splitting this into a select and a later update is what
 *   would hand the same row to both — the symptom being a merchant receiving
 *   one event twice, which their endpoint may or may not be idempotent about.
 * - **`SKIP LOCKED` buys NON-BLOCKING**, not correctness. MEASURED on
 *   PostgreSQL 16.13, with one dispatcher holding its transaction open for
 *   400ms: with `SKIP LOCKED` the second returns in **8ms** with nothing; with
 *   a plain `FOR UPDATE` it returns in **403ms** with nothing. Same outcome,
 *   and the whole poll cycle of every other dispatcher spent waiting on the
 *   head of the queue.
 *
 * Both are wanted. The distinction is recorded because a future reader
 * measuring only the outcome will find `SKIP LOCKED` removable, and removing it
 * costs throughput in a way no test asserting the outcome can see.
 *
 * A row is due when it is `pending`, its `next_attempt_at` has passed, and it
 * carries no LIVE lease. The expired-lease branch is the recovery path: a
 * dispatcher that died mid-attempt leaves its lease behind, and without that
 * `or` the row would stay claimable-by-nobody forever.
 */
export async function claimDueDeliveries(
  db: DatabaseOrTransaction,
  params: ClaimDueParams
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
          lte(webhookDeliveries.leaseExpiresAt, now)
        )
      )
    )
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(params.limit)
    .for('update', { skipLocked: true });

  const rows = await db
    .update(webhookDeliveries)
    .set({ leaseOwner: params.leaseOwner, leaseExpiresAt })
    .where(sql`${webhookDeliveries.id} in (${due})`)
    .returning(CLAIMED_COLUMNS);

  return rows.map((row) => ({
    ...row,
    eventType: row.eventType as WebhookEventType,
    payload: row.payload,
  }));
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
 * expires — which turns a delivered event into a row that looks stuck, and a
 * retryable one into a delay nobody asked for.
 */
export async function recordDeliveryAttempt(
  db: DatabaseOrTransaction,
  params: RecordAttemptParams
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
      // `webhook_deliveries_schedule_agrees_check` ties this to the status, so
      // the two cannot be set inconsistently even by a future caller.
      nextAttemptAt: lastStatus === 'pending' ? params.nextAttemptAt : null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(webhookDeliveries.id, params.id));
}

/**
 * Release a claim without recording an attempt.
 *
 * For the case where a claimed row turns out to be undeliverable for a reason
 * that is not the target's fault and not an attempt — the merchant has removed
 * their webhook configuration between enqueue and claim. Counting that as an
 * attempt would burn the budget on a condition no attempt was made against.
 */
export async function releaseDeliveryClaim(
  db: DatabaseOrTransaction,
  id: string,
  params: { readonly nextAttemptAt: Date | null; readonly reason: string }
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
