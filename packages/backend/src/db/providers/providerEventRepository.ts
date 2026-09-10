/**
 * Writes and reads for `provider_events` — the immutable envelope of everything
 * a payment provider has told this gateway.
 *
 * There is deliberately no `update` beyond `markProviderEventProcessed` and
 * `markProviderEventFailed`, and neither touches `payload`, `object_ids` or the
 * identity columns. The value of this table is that it says what the provider
 * actually sent; a row that can be edited says only what someone last thought
 * the provider sent.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { providerEvents } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

export interface ProviderEventRow {
  readonly id: string;
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerAccountId: string | null;
  readonly type: string;
  readonly livemode: boolean;
  readonly apiVersion: string | null;
  readonly objectIds: Record<string, string>;
  readonly payload: Record<string, unknown>;
  readonly processedAt: Date | null;
  readonly processingError: string | null;
  readonly createdAt: Date;
}

const EVENT_COLUMNS = {
  id: providerEvents.id,
  provider: providerEvents.provider,
  providerEventId: providerEvents.providerEventId,
  providerAccountId: providerEvents.providerAccountId,
  type: providerEvents.type,
  livemode: providerEvents.livemode,
  apiVersion: providerEvents.apiVersion,
  objectIds: providerEvents.objectIds,
  payload: providerEvents.payload,
  processedAt: providerEvents.processedAt,
  processingError: providerEvents.processingError,
  createdAt: providerEvents.createdAt,
} as const;

export interface InsertProviderEventParams {
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerAccountId: string | null;
  readonly type: string;
  readonly livemode: boolean;
  readonly apiVersion: string | null;
  readonly objectIds: Record<string, string>;
  /** ALREADY redacted. This function does not redact; `services/providers/redact.ts` does. */
  readonly payload: Record<string, unknown>;
}

/**
 * Store one verified delivery, or report that we already had it.
 *
 * Returns the new row's id, or **`null` when the unique index converged** — the
 * provider retried a delivery that is already stored. That is a SUCCESS from the
 * caller's point of view and the reason this is a converge-on-the-index insert
 * rather than a read-then-write: Stripe retries anything it did not get a 2xx
 * for, including while the first delivery is still being written, and a
 * `SELECT` before the `INSERT` cannot see an uncommitted row. The read-first
 * shape passes every test and duplicates events under exactly the load that
 * produces retries.
 *
 * `provider_account_id` is part of the key, so a platform-scope and a
 * connect-scope event with the same id are two rows rather than one.
 */
export async function insertProviderEvent(
  db: DatabaseOrTransaction,
  params: InsertProviderEventParams
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(providerEvents)
      .values({
        id: uuidv7(),
        provider: params.provider,
        providerEventId: params.providerEventId,
        providerAccountId: params.providerAccountId,
        type: params.type,
        livemode: params.livemode,
        apiVersion: params.apiVersion,
        objectIds: params.objectIds,
        payload: params.payload,
      })
      .returning({ id: providerEvents.id });
    return row?.id ?? null;
  } catch (error) {
    if (isUniqueViolation(error, 'provider_events_identity_key')) {
      return null;
    }
    throw error;
  }
}

/** By primary key — the drain's lookup once it has claimed an id. */
export async function findProviderEventById(
  db: DatabaseOrTransaction,
  id: string
): Promise<ProviderEventRow | null> {
  const [row] = await db.select(EVENT_COLUMNS).from(providerEvents).where(eq(providerEvents.id, id));
  return (row as ProviderEventRow | undefined) ?? null;
}

/**
 * By provider identity — what an operator asking "did we ever receive `evt_…`?"
 * needs, and what a test asserting dedupe reads.
 */
export async function findProviderEventByIdentity(
  db: DatabaseOrTransaction,
  provider: string,
  providerAccountId: string | null,
  providerEventId: string
): Promise<ProviderEventRow | null> {
  const [row] = await db
    .select(EVENT_COLUMNS)
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.provider, provider),
        // `IS NOT DISTINCT FROM`, not `=`: a platform-scope event stores NULL
        // here, and `null = null` is NULL in SQL, so an `eq` would never match
        // the very rows the platform endpoint writes.
        sql`${providerEvents.providerAccountId} is not distinct from ${providerAccountId}`,
        eq(providerEvents.providerEventId, providerEventId)
      )
    );
  return (row as ProviderEventRow | undefined) ?? null;
}

/**
 * The drain's batch: unprocessed, oldest first.
 *
 * Ordered by `created_at` and served by the partial index of the same name, so
 * the scan is over the unprocessed rows alone rather than over the whole history
 * — which is what keeps this cheap once the table is large, and it only ever
 * grows.
 */
export async function findUnprocessedProviderEvents(
  db: DatabaseOrTransaction,
  limit: number
): Promise<readonly ProviderEventRow[]> {
  const rows = await db
    .select(EVENT_COLUMNS)
    .from(providerEvents)
    .where(isNull(providerEvents.processedAt))
    .orderBy(asc(providerEvents.createdAt))
    .limit(limit);
  return rows as readonly ProviderEventRow[];
}

/**
 * Mark an event handled.
 *
 * Clears `processing_error` as well: an event that failed, was retried and then
 * succeeded must not keep reading as broken in the operator surface.
 */
export async function markProviderEventProcessed(
  db: DatabaseOrTransaction,
  id: string
): Promise<void> {
  await db
    .update(providerEvents)
    .set({ processedAt: new Date(), processingError: null })
    .where(eq(providerEvents.id, id));
}

/**
 * Record why processing failed, leaving `processed_at` NULL so the event is
 * still in the drain's set. The error is operator-facing and is expected to have
 * been through `redactProviderMessage` before it arrives here.
 */
export async function markProviderEventFailed(
  db: DatabaseOrTransaction,
  id: string,
  error: string
): Promise<void> {
  await db.update(providerEvents).set({ processingError: error }).where(eq(providerEvents.id, id));
}
