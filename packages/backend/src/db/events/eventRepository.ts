import { and, eq, gt, like, notExists, exists, type SQL, sql } from 'drizzle-orm';
import type { WebhookEventType } from '@peable.to/shared-types';
import type { EventTypeFilter } from '@peable.to/contracts';
import { uuidv7 } from '@oxy.so/db';
import { events, webhookDeliveries } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

/**
 * Reads and writes for `events` (ADR 0014 D4).
 *
 * The one writer is `insertEvent`, reached only from `services/events.ts`'s
 * `recordEvent`, which also fans the event out to its deliveries in the same
 * transaction.
 */

/**
 * How long an event is served by the API, and kept at all.
 *
 * Every read below filters on it, so an event the sweeper has not reached yet
 * is already invisible — the sweep keeps the table from growing, it never
 * decides what a caller sees.
 */
export const EVENT_RETENTION_DAYS = 30;

export interface EventRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  /** The merchant's mode, read in the row's own statement (ADR 0017). */
  readonly livemode: boolean;
  readonly type: WebhookEventType;
  readonly apiVersion: string;
  readonly dataObject: Record<string, unknown>;
  readonly previousAttributes: Record<string, unknown> | null;
  readonly account: string | null;
  readonly paymentIntentId: string | null;
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

const EVENT_COLUMNS = {
  livemode: merchantLivemodeOf(events.merchantId),
  id: events.id,
  publicId: events.publicId,
  merchantId: events.merchantId,
  type: events.type,
  apiVersion: events.apiVersion,
  dataObject: events.dataObject,
  previousAttributes: events.previousAttributes,
  account: events.account,
  paymentIntentId: events.paymentIntentId,
  requestId: events.requestId,
  idempotencyKey: events.idempotencyKey,
  createdAt: events.createdAt,
} as const;

function toEventRow(row: { type: string; [key: string]: unknown }): EventRow {
  return { ...row, type: row.type as WebhookEventType } as unknown as EventRow;
}

/** Inside the API's retention horizon. */
function retained(): SQL {
  return gt(events.createdAt, sql`now() - make_interval(days => ${EVENT_RETENTION_DAYS})`);
}

export interface InsertEventParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly type: WebhookEventType;
  readonly apiVersion: string;
  readonly dataObject: Record<string, unknown>;
  readonly previousAttributes?: Record<string, unknown> | undefined;
  readonly account?: string | null | undefined;
  readonly paymentIntentId?: string | null | undefined;
  readonly requestId: string | null;
  readonly idempotencyKey: string | null;
}

/**
 * Write one event. Meant to be handed the TRANSACTION of the change it records
 * (ADR 0001 D7) — called after the commit, an event can be lost to a crash
 * with the change already made.
 */
export async function insertEvent(
  db: DatabaseOrTransaction,
  params: InsertEventParams,
): Promise<EventRow> {
  const [row] = await db
    .insert(events)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      type: params.type,
      apiVersion: params.apiVersion,
      dataObject: params.dataObject,
      previousAttributes: params.previousAttributes ?? null,
      account: params.account ?? null,
      paymentIntentId: params.paymentIntentId ?? null,
      requestId: params.requestId,
      idempotencyKey: params.idempotencyKey,
    })
    .returning(EVENT_COLUMNS);
  if (!row) throw new Error('event insert returned no row');
  return toEventRow(row);
}

/** One event by its PRIMARY key — the dispatcher's read, not scoped by retention. */
export async function findEventById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<EventRow | null> {
  const [row] = await db.select(EVENT_COLUMNS).from(events).where(eq(events.id, id));
  return row ? toEventRow(row) : null;
}

/**
 * One event by its PRIMARY key, scoped to the merchant and the retention
 * horizon — the live tail's read of a row it was signalled about.
 */
export async function findEventByIdForMerchant(
  db: DatabaseOrTransaction,
  id: string,
  merchantId: string,
): Promise<EventRow | null> {
  const [row] = await db
    .select(EVENT_COLUMNS)
    .from(events)
    .where(and(eq(events.id, id), eq(events.merchantId, merchantId), retained()));
  return row ? toEventRow(row) : null;
}

/** One event by its public `evt_…`, scoped to the merchant and the retention horizon. */
export async function findEventForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<EventRow | null> {
  const [row] = await db
    .select(EVENT_COLUMNS)
    .from(events)
    .where(and(eq(events.publicId, publicId), eq(events.merchantId, merchantId), retained()));
  return row ? toEventRow(row) : null;
}

/**
 * The `type` filter: an exact type, or a prefix followed by `*`
 * (`payment_intent.*`). `*` alone is no filter at all.
 */
/** `type=` as the contract parses it (`@peable.to/contracts` `listEventsQuery`). */
export type { EventTypeFilter };

export interface ListEventsParams {
  readonly merchantId: string;
  readonly page: KeysetPage;
  readonly type?: EventTypeFilter | undefined;
  /**
   * Stripe's `delivery_success`: `true` keeps events every delivery of which
   * succeeded (and that had at least one); `false` keeps events with a delivery
   * still pending or that failed.
   */
  readonly deliverySuccess?: boolean | undefined;
  /** Only the events about this payment — its INTERNAL key, resolved scoped by the route. */
  readonly paymentIntentId?: string | undefined;
}

/** `%` and `_` are LIKE wildcards; a prefix matches them literally. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** One page of a merchant's events, newest first, inside the retention horizon. */
export async function listEventsForMerchant(
  db: DatabaseOrTransaction,
  params: ListEventsParams,
): Promise<{ data: EventRow[]; hasMore: boolean }> {
  const walk = keyset(events.id, events.createdAt, params.page);
  const conditions: (SQL | undefined)[] = [
    eq(events.merchantId, params.merchantId),
    retained(),
    walk.where,
  ];
  if (params.type?.kind === 'exact') conditions.push(eq(events.type, params.type.type));
  if (params.type?.kind === 'prefix') {
    conditions.push(like(events.type, `${likeLiteral(params.type.prefix)}%`));
  }
  if (params.paymentIntentId !== undefined) {
    conditions.push(eq(events.paymentIntentId, params.paymentIntentId));
  }
  if (params.deliverySuccess !== undefined) {
    const undelivered = db
      .select({ one: sql`1` })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.eventId, events.id),
          sql`${webhookDeliveries.lastStatus} <> 'delivered'`,
        ),
      );
    const any = db
      .select({ one: sql`1` })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, events.id));
    conditions.push(
      params.deliverySuccess ? and(exists(any), notExists(undelivered)) : exists(undelivered),
    );
  }
  const rows = await db
    .select(EVENT_COLUMNS)
    .from(events)
    .where(and(...conditions))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toEventRow));
}

/**
 * Erase what a verification session's stored snapshots say about the person
 * the merchant pointed at (ADR 0023): `metadata` and `client_reference_id` on
 * every `identity.verification_session.*` event of that session.
 *
 * The one write to an event after its insert, and deliberately narrow: a
 * redaction is irreversible erasure the merchant asked for, and an event is
 * replayed byte for byte at every attempt (`toEventDTO`), so a snapshot left
 * as it was would keep re-sending what the redaction erased for 30 days.
 * Nothing else about the event changes — its type, id and delivery history
 * stay the record.
 */
export async function redactVerificationSessionEvents(
  db: DatabaseOrTransaction,
  merchantId: string,
  sessionPublicId: string,
): Promise<number> {
  const rows = await db
    .update(events)
    .set({
      dataObject: sql`${events.dataObject} || '{"metadata":{},"client_reference_id":null}'::jsonb`,
    })
    .where(
      and(
        eq(events.merchantId, merchantId),
        like(events.type, 'identity.verification_session.%'),
        sql`${events.dataObject}->>'id' = ${sessionPublicId}`,
      ),
    )
    .returning({ id: events.id });
  return rows.length;
}
