import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { FILE_PURPOSE_POLICIES } from '@peable.to/shared-types';
import { merchants } from './merchants';
import {
  FILE_PURPOSES,
  FILE_REMOVAL_EVENT_TYPES,
  FILE_TYPES,
  FILE_WITHHELD_REASONS,
} from './valueSets';

/** The largest file any purpose takes — the CHECK's ceiling. */
const MAX_FILE_BYTES = Math.max(
  ...Object.values(FILE_PURPOSE_POLICIES).map((policy) => policy.max_bytes),
);

/**
 * An Orbit File (`file_…`, ADR 0016): bytes a merchant gave Orbit for one
 * purpose. The bytes live in Oxy Files — `oxy_file_id` is the binding and never
 * reaches the wire — and this row is what Orbit decided about them: whose they
 * are, what they are for, and whether they can still be used.
 *
 * ## Two ways a row comes to exist, one rule each
 *
 *  - An UPLOAD: Peable stores the bytes as its own application file (private,
 *    or public for a `business_logo`), registering the `file` reference in the
 *    same Oxy call. Ownership is Peable's by construction.
 *  - An IMPORT (`oxy_file`): an Oxy file the caller already owns becomes a File
 *    after `services/oxyFiles/fileOwnership.ts` — the one ownership check —
 *    accepts it and Oxy accepts the reference.
 *
 * Either way the row's insert queues its reference sync in the same
 * transaction (`db/files/fileRepository.ts`), so Oxy and this table converge
 * whatever crashes between them.
 *
 * ## Never deleted, and never re-pointed
 *
 * A File is referenced by evidence that may already have been submitted, and by
 * the merchant's logo; deleting it would leave those pointing at nothing, and
 * pointing it at other bytes would make a submitted response say something it
 * did not. What Oxy says about the bytes afterwards is recorded on the row:
 * `withheld` while its owner can bring it back, `removed_at` once it is gone.
 */
export const files = pgTable(
  'files',
  {
    id: generatedId(),
    /** The `file_…` the API returns, and the entity id of its Oxy reference. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    purpose: text().notNull(),
    /** The Oxy file holding the bytes — a binding, never serialized. */
    oxyFileId: text().notNull(),
    /** The name it was uploaded with, printable ASCII only. */
    filename: text(),
    size: integer().notNull(),
    type: text().notNull(),
    /** Why Oxy is not serving it right now, or NULL when it is (file events only). */
    withheld: text(),
    /** When Oxy said the file is gone for good. NULL while it exists. */
    removedAt: timestamptz(),
    /** The file event that removed it — the merchant's answer to "why". */
    removedBy: text(),
    /**
     * The `occurredAt` of the newest file event applied, or the creation time:
     * Oxy delivers at least once and in no promised order, so an older event is
     * ignored (`merchants.avatar_file_event_at` is the same rule).
     */
    oxyFileEventAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('files_public_id_key').on(table.publicId),
    /**
     * The target of every same-merchant reference to a File, with its purpose —
     * so dispute evidence can only name the merchant's OWN `dispute_evidence`
     * file (`dispute_evidence_files`), structurally rather than by a check
     * every writer must remember.
     */
    unique('files_id_merchant_id_purpose_key').on(table.id, table.merchantId, table.purpose),
    unique('files_id_merchant_id_key').on(table.id, table.merchantId),
    /** `GET /v1/files?purpose=` walks this, newest first. */
    index('files_merchant_id_purpose_created_idx').on(
      table.merchantId,
      table.purpose,
      table.createdAt,
    ),
    /** A file event names the Oxy file; this finds every File over it. */
    index('files_oxy_file_id_idx').on(table.oxyFileId),
    foreignKey({
      name: 'files_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check('files_purpose_check', sql.raw(`purpose in (${inList(FILE_PURPOSES)})`)),
    check('files_type_check', sql.raw(`type in (${inList(FILE_TYPES)})`)),
    check(
      'files_withheld_check',
      sql.raw(`withheld is null or withheld in (${inList(FILE_WITHHELD_REASONS)})`),
    ),
    check(
      'files_removed_by_check',
      sql.raw(`removed_by is null or removed_by in (${inList(FILE_REMOVAL_EVENT_TYPES)})`),
    ),
    // Removed and the event that removed it are one fact.
    check(
      'files_removed_agrees_check',
      sql`(${table.removedAt} is null) = (${table.removedBy} is null)`,
    ),
    // A removed file is not "withheld": it is not coming back.
    check(
      'files_removed_not_withheld_check',
      sql`${table.removedAt} is null or ${table.withheld} is null`,
    ),
    check('files_size_check', sql.raw(`size between 1 and ${String(MAX_FILE_BYTES)}`)),
    check(
      'files_filename_check',
      sql`${table.filename} is null or length(${table.filename}) between 1 and 255`,
    ),
  ],
);
