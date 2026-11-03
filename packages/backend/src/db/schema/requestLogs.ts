import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxy.so/db';
import { merchants } from './merchants';
import { REQUEST_LOG_METHODS } from './valueSets';

/**
 * One merchant API request, as answered — the request log Orbit lists and
 * `peable logs tail` streams (`GET /v1/request_logs`).
 *
 * Written once per service-authenticated `/v1` request, after it is answered,
 * by `lib/requestLog.ts` — the one writer. Decisions a reader would otherwise
 * undo:
 *
 * - **What it holds is the whole list.** Method, path WITHOUT its query string,
 *   status, duration and the `Idempotency-Key`. Never a body, a header, a query
 *   string or a caller address: a log the merchant reads back is a log that
 *   must not hold what a request carried (a customer's email in a query, a
 *   client secret in a body).
 * - **`request_id` is the public id.** It is the `Request-Id` the response
 *   carried (`req_…`), so the id a merchant quotes to support names this row.
 *   Minted by `requestIdMiddleware`, never taken from the caller, and unique.
 * - **Not written inside any business transaction.** A log row records that a
 *   request was ANSWERED, and is written after the answer — a failure to write
 *   it never changes what the merchant was told.
 * - **`livemode` is not a column** (ADR 0017): it is the merchant's, read in the
 *   row's own statement.
 * - **`cascade` from the merchant**, as `idempotency_keys`: a log of requests
 *   to a merchant means nothing without it. Nothing deletes a merchant.
 * - **Retention is 30 days** (`services/requestLogSweeper.ts`, through
 *   `@oxy.so/db/expiry` on the indexed `created_at`), and every read filters
 *   on the same horizon, so correctness never waits on the sweep.
 */
export const apiRequestLogs = pgTable(
  'api_request_logs',
  {
    id: generatedId(),
    /** The `Request-Id` (`req_…`) — what the wire calls `id`. */
    requestId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    method: text({ enum: REQUEST_LOG_METHODS }).notNull(),
    /** The requested path, without its query string. */
    path: text().notNull(),
    status: integer().notNull(),
    durationMs: integer().notNull(),
    /** The `Idempotency-Key` the request carried, when it was a valid one. */
    idempotencyKey: text(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('api_request_logs_request_id_key').on(table.requestId),
    /** `GET /v1/request_logs`: one merchant's requests, walked by primary key. */
    index('api_request_logs_merchant_id_id_idx').on(table.merchantId, table.id),
    /** The retention sweep's `created_at <= now() - 30 days`. */
    index('api_request_logs_created_at_idx').on(table.createdAt),
    check('api_request_logs_request_id_check', sql`${table.requestId} ~ '^req_[0-9a-f]+$'`),
    check('api_request_logs_method_check', sql.raw(`method in (${inList(REQUEST_LOG_METHODS)})`)),
    check(
      'api_request_logs_path_check',
      sql`${table.path} like '/v1/%' and length(${table.path}) <= 2048 and position('?' in ${table.path}) = 0`,
    ),
    check('api_request_logs_status_check', sql`${table.status} between 100 and 599`),
    check('api_request_logs_duration_ms_check', sql`${table.durationMs} >= 0`),
    // The header's own rule (`lib/idempotency.ts`), restated where it is true.
    check(
      'api_request_logs_idempotency_key_check',
      sql`${table.idempotencyKey} is null or ${table.idempotencyKey} ~ '^[ -~]{1,255}$'`,
    ),
  ],
);
