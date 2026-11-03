import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxy.so/db';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import { INTENT_WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_TYPES } from './valueSets';

/**
 * One event (`evt_…`) — a change a merchant can be told about, stored ONCE
 * (ADR 0014 D4).
 *
 * Written in the SAME transaction as the change that causes it, by
 * `services/events.ts`'s `recordEvent` — the one writer — which also fans the
 * event out to the merchant's matching webhook endpoints as delivery rows in
 * that transaction (ADR 0001 D7). An event exists whether or not any endpoint
 * wants it: `/v1/events` is the record, a delivery is one endpoint being told.
 *
 * It is a SNAPSHOT. `data_object` is the object as the API rendered it at that
 * moment, under `api_version`, and is never re-rendered — replaying last week's
 * `payment_intent.settled` must describe last week.
 *
 * Retention: 30 days (`services/eventSweeper.ts`), and every read filters on
 * the same horizon so an unswept row is invisible rather than served. Deleting
 * an event deletes its deliveries (`webhook_deliveries.event_id` cascades): a
 * delivery is that event sent somewhere and means nothing without it.
 *
 * `livemode` is not a column. An event is always in its merchant's mode, and
 * ADR 0017 keeps that fact in one place (`merchants.livemode`, read in the
 * row's own statement); the snapshot's own `livemode` is frozen inside
 * `data_object` anyway.
 */
export const events = pgTable(
  'events',
  {
    id: generatedId(),
    /** The public `evt_…`, what the wire calls `id`. */
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    type: text().notNull(),
    /** The wire date the snapshot was rendered with (`Peable-Version`). */
    apiVersion: text().notNull(),
    /** `data.object` — the resource as the API returned it at that moment. */
    dataObject: jsonb().$type<Record<string, unknown>>().notNull(),
    /** `data.previous_attributes` — the moved fields' values before the change. */
    previousAttributes: jsonb().$type<Record<string, unknown>>(),
    /**
     * The connected account (`ca_…`) the event is about — Stripe's
     * `event.account` (ADR 0012 D7). A rendered PUBLIC id frozen into the
     * snapshot, like everything in `data_object`; not a reference.
     */
    account: text(),
    /**
     * The payment the event is about, when it is about one — the INTERNAL key,
     * so the delivery log and the dashboard can correlate without parsing the
     * snapshot. `cascade` for the reason deliveries had it: an event about a
     * payment means nothing without the payment.
     */
    paymentIntentId: text().references(() => paymentIntents.id, { onDelete: 'cascade' }),
    /** `request.id` — the `Request-Id` of the API call that caused it, if one did. */
    requestId: text(),
    /** `request.idempotency_key` — the key that call carried, if any. */
    idempotencyKey: text(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('events_public_id_key').on(table.publicId),
    /** `GET /v1/events`: one merchant's events, walked by primary key. */
    index('events_merchant_id_id_idx').on(table.merchantId, table.id),
    /** The retention sweep's `created_at <= now() - 30 days`. */
    index('events_created_at_idx').on(table.createdAt),
    /** The cascade from a payment, and the delivery log's correlation. */
    index('events_payment_intent_id_idx')
      .on(table.paymentIntentId)
      .where(sql`${table.paymentIntentId} is not null`),
    check('events_type_check', sql.raw(`type in (${inList(WEBHOOK_EVENT_TYPES)})`)),
    check('events_api_version_check', sql.raw(`api_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`)),
    check('events_data_object_check', sql`jsonb_typeof(${table.dataObject}) = 'object'`),
    check(
      'events_previous_attributes_check',
      sql`${table.previousAttributes} is null or jsonb_typeof(${table.previousAttributes}) = 'object'`,
    ),
    /** A key is only ever recorded as part of the request that carried it. */
    check(
      'events_idempotency_key_needs_request_check',
      sql`${table.idempotencyKey} is null or ${table.requestId} is not null`,
    ),
    /**
     * An event ABOUT a payment names one; an event about something else does
     * not. Keyed on the DECLARED scope (`WEBHOOK_EVENT_SCOPES`), not on the
     * `payment_intent.` prefix — this row is written inside the money
     * transaction, so a CHECK it fails rolls the settlement back, and that
     * must never hinge on a naming convention. Moved here from
     * `webhook_deliveries`, which no longer carries the reference.
     */
    check(
      'events_intent_event_has_intent_check',
      sql.raw(
        `(type in (${inList(INTENT_WEBHOOK_EVENT_TYPES)})) = (payment_intent_id is not null)`,
      ),
    ),
  ],
);
