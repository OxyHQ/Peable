import { and, eq, type SQL } from 'drizzle-orm';
import type { WebhookDeliveryStatus, WebhookEventType } from '@peable.to/shared-types';
import { events, webhookDeliveries, webhookEndpoints } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

/**
 * READS for `webhook_deliveries` — what the merchant API and the dashboard ask
 * about a delivery.
 *
 * The writes live in `webhookOutboxRepository.ts`: a row is created by the
 * event fan-out (or a redelivery) BEFORE any attempt and updated by
 * `recordDeliveryAttempt` after each one. There is deliberately no function
 * that writes a finished delivery in one shot.
 *
 * Every read joins the event and the endpoint, because the wire names both by
 * their PUBLIC ids (`evt_…`, `we_…`) and the row holds their primary keys. Both
 * joins are inner: the foreign keys cascade, so a delivery always has both.
 */

export interface WebhookDeliveryRow {
  /** The merchant's mode, read in the same statement (ADR 0017). */
  readonly livemode: boolean;
  readonly id: string;
  readonly merchantId: string;
  /** The event's PRIMARY key. */
  readonly eventId: string;
  readonly eventPublicId: string;
  readonly eventType: WebhookEventType;
  readonly endpointId: string;
  readonly endpointPublicId: string;
  readonly url: string;
  readonly attempts: number;
  readonly delivered: boolean;
  readonly lastStatus: WebhookDeliveryStatus;
  /** Why the last attempt did not succeed. `null` while pending or delivered. */
  readonly lastError: string | null;
  /** When the next attempt is due. `null` exactly when the row is terminal. */
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const DELIVERY_COLUMNS = {
  livemode: merchantLivemodeOf(webhookDeliveries.merchantId),
  id: webhookDeliveries.id,
  merchantId: webhookDeliveries.merchantId,
  eventId: webhookDeliveries.eventId,
  eventPublicId: events.publicId,
  eventType: events.type,
  endpointId: webhookDeliveries.endpointId,
  endpointPublicId: webhookEndpoints.publicId,
  url: webhookDeliveries.url,
  attempts: webhookDeliveries.attempts,
  delivered: webhookDeliveries.delivered,
  lastStatus: webhookDeliveries.lastStatus,
  lastError: webhookDeliveries.lastError,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  createdAt: webhookDeliveries.createdAt,
  updatedAt: webhookDeliveries.updatedAt,
} as const;

function toDeliveryRow(row: {
  eventType: string;
  lastStatus: string;
  [key: string]: unknown;
}): WebhookDeliveryRow {
  return {
    ...row,
    eventType: row.eventType as WebhookEventType,
    lastStatus: row.lastStatus as WebhookDeliveryStatus,
  } as unknown as WebhookDeliveryRow;
}

function selectDeliveries(db: DatabaseOrTransaction) {
  return db
    .select(DELIVERY_COLUMNS)
    .from(webhookDeliveries)
    .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId));
}

/**
 * One delivery, scoped to the merchant that owns it. Ownership is in the WHERE
 * clause, so a foreign delivery 404s exactly like a missing one.
 */
export async function findDeliveryForMerchant(
  db: DatabaseOrTransaction,
  id: string,
  merchantId: string,
): Promise<WebhookDeliveryRow | null> {
  const [row] = await selectDeliveries(db).where(
    and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.merchantId, merchantId)),
  );
  return row ? toDeliveryRow(row) : null;
}

export interface ListDeliveriesParams {
  readonly merchantId: string;
  /** Cursors already resolved and ownership-checked by the caller. */
  readonly page: KeysetPage;
  /** Only the deliveries of this event (its PRIMARY key). */
  readonly eventId?: string | undefined;
  /** Only the deliveries to this endpoint (its PRIMARY key). */
  readonly endpointId?: string | undefined;
}

/**
 * One page of a merchant's delivery log, newest first — optionally one event's
 * deliveries, or one endpoint's. `hasMore` comes from the `limit + 1` overflow,
 * never a `count(*)`.
 */
export async function listDeliveriesForMerchant(
  db: DatabaseOrTransaction,
  params: ListDeliveriesParams,
): Promise<{ data: WebhookDeliveryRow[]; hasMore: boolean }> {
  const walk = keyset(webhookDeliveries.id, webhookDeliveries.createdAt, params.page);
  const conditions: (SQL | undefined)[] = [
    eq(webhookDeliveries.merchantId, params.merchantId),
    walk.where,
  ];
  if (params.eventId !== undefined) conditions.push(eq(webhookDeliveries.eventId, params.eventId));
  if (params.endpointId !== undefined) {
    conditions.push(eq(webhookDeliveries.endpointId, params.endpointId));
  }
  const rows = await selectDeliveries(db)
    .where(and(...conditions))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toDeliveryRow));
}
