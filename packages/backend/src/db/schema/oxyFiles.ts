import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import {
  MERCHANT_AVATAR_AUDIT_ACTIONS,
  OXY_FILE_ENTITY_TYPES,
  OXY_FILE_EVENT_TYPES,
  OXY_FILE_RECONCILIATION_STATUSES,
} from './valueSets';

/**
 * Peable's side of Oxy Files (ADR 0043): which of its rows USE an Oxy file,
 * kept in step with Oxy's `file_references`, and what Oxy told it about them.
 *
 * Oxy is told about a use with `OxyServer.assets.references.add` and told it
 * ended with `.remove`. Both are network calls, and the row that decides the
 * use (`merchants.avatar_file_id`) is written in a database transaction — so
 * neither call can be made atomically with the write. These tables are what
 * makes that safe, in the same shape as the merchant webhook outbox (ADR 0001
 * D7): the INTENT to sync is written in the transaction that changes the use,
 * and a loop makes Oxy agree afterwards.
 */

/**
 * One (file, entity) pair whose reference at Oxy must be brought in line with
 * this database. Not "add" or "remove": the loop READS what the database wants
 * at the moment it acts (`isReferenceWanted`) and does that, so a pair that was
 * set, cleared and set again while a retry was pending ends up referenced,
 * whatever order the three syncs would have run in as separate operations.
 *
 * One row per pair. A second change to a pair already queued bumps `version`
 * instead of adding a row, and the loop deletes the row only if `version` is
 * still the one it claimed — a change that landed while the call was in flight
 * leaves the row in place and it runs again.
 */
export const oxyFileReferenceSyncs = pgTable(
  'oxy_file_reference_syncs',
  {
    fileId: text().notNull(),
    entityType: text().notNull(),
    entityId: text().notNull(),
    /** Bumped by every enqueue; the claim's compare half. */
    version: integer().notNull().default(0),
    /** Failed attempts since the last enqueue, for the backoff. */
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull(),
    /** Set while one pass holds the pair, so two passes never act on it at once. */
    leaseExpiresAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'oxy_file_reference_syncs_pkey',
      columns: [table.fileId, table.entityType, table.entityId],
    }),
    index('oxy_file_reference_syncs_due_idx').on(table.nextAttemptAt),
    check(
      'oxy_file_reference_syncs_entity_type_check',
      sql.raw(`entity_type in (${inList(OXY_FILE_ENTITY_TYPES)})`),
    ),
    check('oxy_file_reference_syncs_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

/**
 * Every file event Oxy delivered and this gateway accepted (ADR 0043 D9).
 *
 * The primary key IS the dedupe: delivery is at least once, the event id is the
 * same for a redelivery, and the effect of an event is applied in the same
 * transaction that inserts this row — so a redelivery converges on the key and
 * applies nothing twice. Rows older than Oxy's own 30-day delivery expiry can
 * never be redelivered and are pruned by the reconciliation loop.
 */
export const oxyFileEvents = pgTable(
  'oxy_file_events',
  {
    eventId: text().primaryKey(),
    eventType: text().notNull(),
    fileId: text().notNull(),
    occurredAt: timestamptz().notNull(),
    receivedAt: createdAt(),
  },
  (table) => [
    index('oxy_file_events_received_at_idx').on(table.receivedAt),
    check(
      'oxy_file_events_event_type_check',
      sql.raw(`event_type in (${inList(OXY_FILE_EVENT_TYPES)})`),
    ),
  ],
);

/**
 * What a file event did to a merchant's avatar, and why — the audit record of
 * a change no merchant asked for.
 *
 * A takedown or an owner's deletion makes Peable stop showing a logo the
 * merchant set. The merchant will ask why their checkout lost it, and the
 * answer has to exist somewhere other than a log line: which file, which event,
 * what was done, when.
 */
export const merchantAvatarAudit = pgTable(
  'merchant_avatar_audit',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    fileId: text().notNull(),
    action: text().notNull(),
    eventId: text().notNull(),
    eventType: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('merchant_avatar_audit_merchant_id_idx').on(table.merchantId),
    check(
      'merchant_avatar_audit_action_check',
      sql.raw(`action in (${inList(MERCHANT_AVATAR_AUDIT_ACTIONS)})`),
    ),
    check(
      'merchant_avatar_audit_event_type_check',
      sql.raw(`event_type in (${inList(OXY_FILE_EVENT_TYPES)})`),
    ),
  ],
);

/**
 * One run of the scheduled reconciliation of one entity type (ADR 0043 D6) —
 * the lease that keeps two tasks from running it at once, and the report.
 *
 * Oxy itself refuses a second open reconciliation per (application, entity
 * type) with a 409, but a refusal is the wrong place to discover a sibling task:
 * the partial unique index on `status = 'running'` makes the second task's claim
 * fail here, before anything is sent.
 */
export const oxyFileReconciliationRuns = pgTable(
  'oxy_file_reconciliation_runs',
  {
    id: generatedId(),
    entityType: text().notNull(),
    dryRun: boolean().notNull(),
    status: text().notNull(),
    startedAt: createdAt(),
    finishedAt: timestamptz(),
    added: integer(),
    removed: integer(),
    unchanged: integer(),
    refused: integer(),
    error: text(),
  },
  (table) => [
    uniqueIndex('oxy_file_reconciliation_runs_one_running_key')
      .on(table.entityType)
      .where(sql`${table.status} = 'running'`),
    index('oxy_file_reconciliation_runs_entity_started_idx').on(table.entityType, table.startedAt),
    check(
      'oxy_file_reconciliation_runs_entity_type_check',
      sql.raw(`entity_type in (${inList(OXY_FILE_ENTITY_TYPES)})`),
    ),
    check(
      'oxy_file_reconciliation_runs_status_check',
      sql.raw(`status in (${inList(OXY_FILE_RECONCILIATION_STATUSES)})`),
    ),
    // A finished run has a finish time and a running one does not.
    check(
      'oxy_file_reconciliation_runs_finished_check',
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
  ],
);
