import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { merchants } from './merchants';
import { IDEMPOTENCY_KEY_STATUSES } from './valueSets';

/**
 * One `Idempotency-Key` a merchant presented, and what it answered (ADR 0014 D3).
 *
 * The generic layer in front of every merchant `POST` (`lib/idempotency.ts`).
 * It does not replace the business idempotency beneath it —
 * `payment_intents (merchant_id, idempotency_key)` and the `external_ref` of
 * refunds, transfers and reversals still decide whether money moves twice —
 * it makes a retried REQUEST answer what the first one answered, byte for
 * byte, for 24 hours.
 *
 * Decisions a reader would otherwise undo:
 *
 * - **Scoped by merchant, not by credential.** A merchant is an (application,
 *   environment) pair; two credentials of one application in one environment
 *   are one integration retrying, and a test key and a live key are two
 *   merchants that can never see each other's keys.
 * - **The row is the lease.** `in_progress` with `lease_expires_at` is a
 *   request still running; a second request with the same key is answered 409
 *   rather than run twice. A process that dies mid-request leaves the lease to
 *   run out, and the next retry of the SAME request takes the row over.
 * - **`id` names the CLAIM, not the key.** A takeover writes a fresh `id`, so a
 *   request that outlived its lease completes or releases nothing: its
 *   `where id = …` no longer matches. The compare half of the write, as
 *   `status = from` is for an intent.
 * - **A 5xx is never stored** (`idempotency_keys_response_status_check`): the
 *   server failed, the caller must be able to retry, so the row is DELETED.
 * - **`cascade` from the merchant.** A stored response is derived from a
 *   request to that merchant and means nothing without it — the same argument
 *   as `webhook_deliveries.payment_intent_id`. Nothing deletes a merchant.
 * - **Every instant is the DATABASE's clock** (the repository writes `now()`),
 *   because the lease is compared across tasks whose clocks may disagree.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    /** The header value, exactly as sent: 1–255 printable ASCII characters. */
    key: text().notNull(),
    method: text().notNull(),
    /** The request path without its query string. */
    path: text().notNull(),
    /** Hex sha256 of the canonical JSON of the request body (keys sorted). */
    requestHash: text().notNull(),
    status: text({ enum: IDEMPOTENCY_KEY_STATUSES }).notNull(),
    responseStatus: integer(),
    /** The JSON body answered, replayed as-is. May carry a `client_secret`. */
    responseBody: jsonb().$type<unknown>(),
    /** While `in_progress`: when another request may take the key over. */
    leaseExpiresAt: timestamptz(),
    createdAt: createdAt(),
    /** `created_at` + 24 hours. After it the key is free and the sweeper deletes the row. */
    expiresAt: timestamptz().notNull(),
  },
  (table) => [
    unique('idempotency_keys_merchant_id_key_key').on(table.merchantId, table.key),
    // The sweeper deletes on `expires_at <= now()`; `@oxy.so/db/expiry`
    // requires the column to be indexed.
    index('idempotency_keys_expires_at_idx').on(table.expiresAt),
    check(
      'idempotency_keys_status_check',
      sql.raw(`status in (${inList(IDEMPOTENCY_KEY_STATUSES)})`),
    ),
    // The header's own rule, restated where it is true of the data.
    check('idempotency_keys_key_check', sql`${table.key} ~ '^[ -~]{1,255}$'`),
    check('idempotency_keys_request_hash_check', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check('idempotency_keys_method_check', sql`${table.method} in ('POST')`),
    // A stored answer is a 2xx or a 4xx. A 5xx releases the key instead.
    check(
      'idempotency_keys_response_status_check',
      sql`${table.responseStatus} is null or ${table.responseStatus} between 200 and 499`,
    ),
    check(
      'idempotency_keys_completed_has_response_check',
      sql`(${table.status} = 'completed') = (${table.responseStatus} is not null and ${table.responseBody} is not null)`,
    ),
    check(
      'idempotency_keys_in_progress_has_lease_check',
      sql`(${table.status} = 'in_progress') = (${table.leaseExpiresAt} is not null)`,
    ),
  ],
);
