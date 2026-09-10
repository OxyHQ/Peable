import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { PROVIDER_IDS } from './valueSets';

/**
 * The immutable envelope of everything a payment provider has told this
 * gateway.
 *
 * **Receipt is separate from processing, and that separation is the point.** A
 * verified delivery is written here and answered `200` immediately; what it
 * MEANS is worked out afterwards. The alternative — process inside the request
 * — makes every downstream failure look to Stripe like a delivery failure, so
 * Stripe retries, so the work happens twice, and the only defence left is
 * whatever idempotency the handler happens to have.
 *
 * Ported in shape from Mercaria's `payment_provider_events` (ADR 0001 D11).
 */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: generatedId(),
    provider: text().notNull(),
    /** The provider's own event id. What the dedupe is keyed on. */
    providerEventId: text().notNull(),
    /**
     * The connected account this event is scoped to; NULL for platform scope.
     *
     * Part of the dedupe key rather than a plain column, because two connected
     * accounts can be told about the same underlying object and a platform-scope
     * event can share an id space with a connect-scope one.
     */
    providerAccountId: text(),
    type: text().notNull(),
    /**
     * Whether the provider says this is live money.
     *
     * Stored rather than filtered away, so a test event that reached a live
     * deployment is EVIDENCE of a misconfigured endpoint rather than a silent
     * drop nobody can investigate.
     */
    livemode: boolean().notNull(),
    apiVersion: text(),
    /** The provider object ids the event refers to, under the provider's own names. */
    objectIds: jsonb().$type<Record<string, string>>().notNull(),
    /**
     * The redacted body.
     *
     * REDACTED, not raw: a provider payload carries payer names, addresses and
     * card fingerprints, and this table is the one place a support query looks.
     * Storing it whole would make every such query a disclosure.
     */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /**
     * When this event was acted on. NULL means received and not yet processed —
     * which is a normal, momentary state, not an error.
     */
    processedAt: timestamptz(),
    /** Why processing failed, when it did. Operator-facing. */
    processingError: text(),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * The dedupe, and the reason it is a database constraint rather than an
     * application check.
     *
     * Stripe retries a delivery it did not get a 2xx for, and a retry that
     * arrives while the first is still being written would pass any
     * read-then-write guard — a `SELECT` cannot see an uncommitted row.
     * Converging on this constraint is what makes "an event is stored at most
     * once" true under concurrency rather than usually.
     *
     * `provider_account_id` is in the key: a platform-scope and a connect-scope
     * event are different deliveries even where their ids collide.
     *
     * **`NULLS NOT DISTINCT`, and it is load-bearing.** A platform-scope event
     * carries no account, so this column is NULL — and under PostgreSQL's
     * default every NULL is distinct from every other, which means a plain
     * unique index would let the SAME platform event be stored twice. Measured
     * against a real server before it was written this way: two inserts of
     * `('stripe', NULL, 'evt_1')` both succeed under a plain unique index and
     * the second is refused under this one. The dedupe would have been broken
     * for exactly the deliveries that have no account — which on this gateway is
     * most of them. `payment_provider_events` in Mercaria carries the same
     * decision for the same reason.
     *
     * A `unique` CONSTRAINT rather than a `uniqueIndex` because `NULLS NOT
     * DISTINCT` is what drizzle exposes on the constraint builder.
     */
    unique('provider_events_identity_key')
      .on(table.provider, table.providerAccountId, table.providerEventId)
      .nullsNotDistinct(),
    /** The drain query: unprocessed, oldest first. Partial — processed rows are history. */
    index('provider_events_unprocessed_idx')
      .on(table.createdAt)
      .where(sql`${table.processedAt} is null`),
    check('provider_events_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check(
      'provider_events_payload_object_check',
      sql`jsonb_typeof(${table.payload}) = 'object'`
    ),
    check(
      'provider_events_object_ids_object_check',
      sql`jsonb_typeof(${table.objectIds}) = 'object'`
    ),
  ]
);
