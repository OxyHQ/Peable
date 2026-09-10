import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from './valueSets';

/**
 * One webhook delivery — the DURABLE PROMISE that an event will reach a
 * merchant, and the record of how that went.
 *
 * It was an after-the-fact log: `deliver()` ran inline, best-effort, three
 * attempts with 50ms and 100ms of backoff, never threw, and only then wrote a
 * row. A merchant endpoint unreachable for a fifth of a second lost the event
 * silently. ADR 0001 D7 makes this an outbox instead: the row is written in the
 * SAME TRANSACTION as the state change that caused it, and a dispatcher claims
 * it afterwards. That ordering is the whole point — an event that exists only
 * in memory between the commit and the HTTP call is an event a crash loses,
 * and Mercaria reaches `paid` from nothing else.
 *
 * Keyed by merchant rather than by "the" webhook: today a merchant has one
 * endpoint (`merchants.webhook_url`/`webhook_secret`), and if that ever becomes
 * N endpoints with event filters, this gains an `endpoint_id` rather than being
 * rewritten.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    /**
     * The intent the event was about. Holds the intent's PRIMARY KEY; the Mongo
     * field held the public `pi_…` id, and the serializer renders that from the
     * join.
     *
     * `cascade`, unlike every other reference in this schema: a delivery log is
     * derived from its intent and has no meaning without it, where an intent is
     * the money record and a merchant is the party. Nothing deletes an intent
     * today; this states what the consequence would be rather than leaving it
     * to whoever writes that statement.
     */
    paymentIntentId: text()
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
    /** The `evt_…` envelope id that was signed and sent. */
    eventId: text().notNull(),
    eventType: text().notNull(),
    /**
     * The event envelope, exactly as it will be signed.
     *
     * Persisted rather than rebuilt, and that is a correctness fix as much as an
     * outbox requirement: the redelivery route used to reconstruct the event
     * from the intent's state AT REDELIVERY TIME, so replaying a
     * `payment_intent.settled` from last week sent whatever the intent looks
     * like now. An event describes a moment; it does not get to change.
     *
     * The SIGNATURE is not stored — it is recomputed per attempt over a fresh
     * timestamp, because the receiver's tolerance window is measured against it.
     */
    payload: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * The URL actually POSTed to, as of the latest attempt.
     *
     * Re-read from the merchant on every attempt rather than frozen at enqueue:
     * a retry should reach where the merchant IS, not where they were when the
     * payment settled. A merchant who moves their endpoint mid-backoff would
     * otherwise have every in-flight event delivered to the old one.
     */
    url: text().notNull(),
    attempts: integer().notNull().default(0),
    delivered: boolean().notNull().default(false),
    lastStatus: text().notNull().default('pending'),
    /** Why the last attempt did not succeed. Operator-facing; never a secret. */
    lastError: text(),
    /**
     * When this row becomes claimable. NULL exactly when the row is terminal.
     *
     * Set to "now" at enqueue so the first attempt is immediate, and pushed out
     * by the backoff schedule after each transient failure.
     */
    nextAttemptAt: timestamptz(),
    /**
     * The lease. A dispatcher pass claims a row by stamping both of these, and
     * releases them when it records the outcome.
     *
     * Both or neither, always (`webhook_deliveries_lease_agrees_check`): a lease
     * owner with no expiry is a row nobody can ever reclaim, and an expiry with
     * no owner is a claim nobody made. The expiry is what makes a dispatcher
     * that died mid-attempt recoverable — the row becomes claimable again
     * instead of being stuck `pending` forever behind a lease held by a process
     * that no longer exists.
     */
    leaseOwner: text(),
    leaseExpiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('webhook_deliveries_merchant_id_idx').on(table.merchantId),
    /**
     * The dispatcher's claim query: due, pending, unleased. Partial, on
     * `next_attempt_at` — which is NULL for every terminal row, so the index
     * holds only the work queue rather than the whole delivery history. That
     * matters here more than it usually does: the queue is expected to be near
     * empty while the history grows without bound.
     */
    index('webhook_deliveries_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.nextAttemptAt} is not null`),
    check(
      'webhook_deliveries_event_type_check',
      sql.raw(`event_type in (${inList(WEBHOOK_EVENT_TYPES)})`)
    ),
    check(
      'webhook_deliveries_last_status_check',
      sql.raw(`last_status in (${inList(WEBHOOK_DELIVERY_STATUSES)})`)
    ),
    /**
     * Was `attempts > 0`, because a row only existed after `deliver()` had run
     * its first iteration. An outbox row exists BEFORE any attempt, so zero is
     * now the normal starting value and the bound is the one that was always
     * meant: never negative.
     */
    check('webhook_deliveries_attempts_check', sql`${table.attempts} >= 0`),
    /**
     * `delivered` and `last_status` are two spellings of one fact, and every
     * writer derives the second from the first. This is that derivation, in the
     * place where the two cannot come apart.
     */
    check(
      'webhook_deliveries_status_agrees_check',
      sql`${table.delivered} = (${table.lastStatus} = 'delivered')`
    ),
    /**
     * A row is scheduled exactly when it is pending.
     *
     * Both directions matter and neither is decoration. A `pending` row with no
     * `next_attempt_at` is an event that will never be attempted and that no
     * query will ever surface — the exact failure this whole table was rebuilt
     * to remove. A terminal row that kept its schedule would be re-delivered
     * forever after it had already succeeded.
     */
    check(
      'webhook_deliveries_schedule_agrees_check',
      sql`(${table.lastStatus} = 'pending') = (${table.nextAttemptAt} is not null)`
    ),
    check(
      'webhook_deliveries_lease_agrees_check',
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`
    ),
    /** A terminal row holds no lease — nothing may claim what is already done. */
    check(
      'webhook_deliveries_terminal_has_no_lease_check',
      sql`${table.lastStatus} = 'pending' or ${table.leaseOwner} is null`
    ),
    check(
      'webhook_deliveries_payload_object_check',
      sql`jsonb_typeof(${table.payload}) = 'object'`
    ),
    /**
     * A row that will be ATTEMPTED carries a real envelope.
     *
     * The column default is `'{}'`, and it exists for exactly one reason: rows
     * written before this table became an outbox stored only an `event_id`, not
     * the body — there was no body to store, because the old path built the
     * event, POSTed it and threw it away. Those rows are all terminal history
     * and are never attempted again, so an empty envelope on them is honest
     * rather than harmful.
     *
     * What must never happen is a PENDING row with an empty one: the dispatcher
     * would claim it and POST `{}` to a merchant, signed, as if it were an
     * event. That is the failure this CHECK exists for, and it is also why the
     * default is not simply removed — dropping it would make the migration
     * itself impossible to apply over existing rows.
     */
    check(
      'webhook_deliveries_pending_has_envelope_check',
      sql`${table.lastStatus} <> 'pending' or ${table.payload} <> '{}'::jsonb`
    ),
  ]
);
