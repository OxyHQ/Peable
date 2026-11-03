import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { CURRENCY_CODES, REPORT_RUN_STATUSES, REPORT_TYPE_IDS } from '@peable.to/shared-types';
import { files } from './files';
import { merchants } from './merchants';

/**
 * A report run (`frr_…`, Stripe's `reporting.report_run`): a merchant asked for
 * a report over an interval, and the background worker
 * (`services/reporting/reportRunWorker.ts`) produces its CSV as a File.
 *
 * ## Its lifecycle is three states and one writer each
 *
 *  - `pending` — written by `POST /v1/reporting/report_runs`. A worker CLAIMS
 *    it by setting `lease_token` / `lease_expires_at` in one statement
 *    (`claimReportRun`), so two workers never produce the same run at once;
 *    a worker that dies leaves a lease that simply expires.
 *  - `succeeded` — the worker stored the CSV and, in ONE statement gated on its
 *    own `lease_token`, names the file and records the event. A worker whose
 *    lease was taken over completes nothing.
 *  - `failed` — the report could not be produced (it exceeded the file
 *    ceiling, the merchant has no ledger to read, or every attempt failed).
 *
 * The CHECKs below are those three sentences restated where no writer can
 * break them.
 *
 * ## The result is a `finance_report_run` File of the same merchant
 *
 * `(result_file_id, merchant_id, result_file_purpose) → files (id,
 * merchant_id, purpose)` with the purpose pinned by a CHECK, the
 * `dispute_evidence_files` rule: a run can only ever name its own merchant's
 * report file, never an upload. `MATCH SIMPLE` switches it off while there is
 * no result.
 */
export const reportRuns = pgTable(
  'report_runs',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    reportType: text().notNull(),
    /** `parameters.interval_start`, inclusive. */
    intervalStart: timestamptz().notNull(),
    /** `parameters.interval_end`, exclusive. */
    intervalEnd: timestamptz().notNull(),
    /** `parameters.columns`, as asked; NULL means the report type's defaults. */
    columns: text().array(),
    /** `parameters.currency`. */
    currency: text(),
    status: text().notNull().default('pending'),
    error: text(),
    resultFileId: text(),
    resultFilePurpose: text().notNull().default('finance_report_run'),
    succeededAt: timestamptz(),
    /** How many times a worker has claimed it. */
    attempts: integer().notNull().default(0),
    /** The current claim — the compare half of the completing write. */
    leaseToken: text(),
    leaseExpiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('report_runs_public_id_key').on(table.publicId),
    /** `GET /v1/reporting/report_runs` walks this, newest first. */
    index('report_runs_merchant_id_id_idx').on(table.merchantId, table.id),
    /** The worker's queue: pending runs, oldest first. */
    index('report_runs_pending_idx').on(table.id).where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: 'report_runs_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'report_runs_result_file_fkey',
      columns: [table.resultFileId, table.merchantId, table.resultFilePurpose],
      foreignColumns: [files.id, files.merchantId, files.purpose],
    }).onDelete('restrict'),
    check('report_runs_report_type_check', sql.raw(`report_type in (${inList(REPORT_TYPE_IDS)})`)),
    check('report_runs_status_check', sql.raw(`status in (${inList(REPORT_RUN_STATUSES)})`)),
    check(
      'report_runs_result_file_purpose_check',
      sql`${table.resultFilePurpose} = 'finance_report_run'`,
    ),
    check(
      'report_runs_currency_check',
      sql.raw(`currency is null or currency in (${inList(CURRENCY_CODES)})`),
    ),
    check('report_runs_interval_check', sql`${table.intervalStart} < ${table.intervalEnd}`),
    check(
      'report_runs_columns_check',
      sql`${table.columns} is null or cardinality(${table.columns}) >= 1`,
    ),
    // Succeeded ⇔ a result and its instant; failed ⇔ a reason; only a pending
    // run holds a lease.
    check(
      'report_runs_succeeded_agrees_check',
      sql`(${table.status} = 'succeeded') = (${table.resultFileId} is not null) and (${table.status} = 'succeeded') = (${table.succeededAt} is not null)`,
    ),
    check(
      'report_runs_failed_agrees_check',
      sql`(${table.status} = 'failed') = (${table.error} is not null)`,
    ),
    check(
      'report_runs_lease_agrees_check',
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null) and (${table.status} = 'pending' or ${table.leaseToken} is null)`,
    ),
    check('report_runs_attempts_check', sql`${table.attempts} >= 0`),
  ],
);
