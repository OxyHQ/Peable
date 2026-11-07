import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  CURRENCY_CODES,
  REPORT_RUN_STATUSES,
  REPORT_SCHEDULE_INTERVALS,
  REPORT_SCHEDULE_LOCALES,
  REPORT_SCHEDULE_MAX_RECIPIENTS,
  REPORT_SCHEDULE_STATUSES,
  REPORT_SCHEDULE_WEEKDAYS,
  REPORT_TYPE_IDS,
} from '@peable.to/shared-types';
import { files } from './files';
import { merchants } from './merchants';

/**
 * A report schedule (`frs_…`): a merchant's report run on a cadence
 * (`services/reporting/reportScheduler.ts`).
 *
 * ## Firing is a leased claim, and an occurrence fires once
 *
 * The scheduler CLAIMS a due schedule (`status = 'active' and next_run_at <=
 * now()`) in one statement, `for update skip locked`, stamping its own
 * `lease_token`; then ONE transaction inserts the occurrence's ordinary
 * `report_runs` row and moves `next_run_at` to the following occurrence,
 * gated on that token. `report_runs (report_schedule_id, scheduled_for)` is
 * unique, so even two claimers that both believed they held the lease cannot
 * fire one occurrence twice. A scheduler that was down fires the LATEST due
 * occurrence once and moves on: missed occurrences are not backfilled.
 *
 * `next_run_at` is set exactly while `active`: a paused or canceled schedule
 * has none, and resuming computes the first occurrence after now. A canceled
 * schedule is terminal (`canceled_at`). The last run is not stored: it is the
 * newest run naming the schedule.
 *
 * `recipients` are validated addresses (the API's rule; a CHECK bounds the
 * count): what they receive is a link to the run in Orbit, never the file.
 */
export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    reportType: text().notNull(),
    /** The run template: `parameters.columns` (NULL: the defaults) and `.currency`. */
    columns: text().array(),
    currency: text(),
    interval: text().notNull(),
    weeklyAnchor: text(),
    monthlyAnchor: integer(),
    /** IANA; validated by the API (the database has no zone list to check it against). */
    timezone: text().notNull(),
    recipients: text().array().notNull().default(sql`'{}'::text[]`),
    locale: text().notNull().default('en'),
    status: text().notNull().default('active'),
    nextRunAt: timestamptz(),
    canceledAt: timestamptz(),
    /** The current firing claim — the compare half of the advancing write. */
    leaseToken: text(),
    leaseExpiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('report_schedules_public_id_key').on(table.publicId),
    /** The target of `report_runs`' same-merchant foreign key. */
    unique('report_schedules_id_merchant_id_key').on(table.id, table.merchantId),
    index('report_schedules_merchant_id_id_idx').on(table.merchantId, table.id),
    /** The scheduler's queue: active schedules by their next occurrence. */
    index('report_schedules_due_idx').on(table.nextRunAt).where(sql`${table.status} = 'active'`),
    foreignKey({
      name: 'report_schedules_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'report_schedules_report_type_check',
      sql.raw(`report_type in (${inList(REPORT_TYPE_IDS)})`),
    ),
    check(
      'report_schedules_currency_check',
      sql.raw(`currency is null or currency in (${inList(CURRENCY_CODES)})`),
    ),
    check(
      'report_schedules_columns_check',
      sql`${table.columns} is null or cardinality(${table.columns}) >= 1`,
    ),
    check(
      'report_schedules_interval_check',
      sql.raw(`interval in (${inList(REPORT_SCHEDULE_INTERVALS)})`),
    ),
    // The anchor the interval needs, and no other.
    check(
      'report_schedules_anchor_check',
      sql.raw(
        `(interval = 'weekly') = (weekly_anchor is not null) and (interval = 'monthly') = (monthly_anchor is not null) and (weekly_anchor is null or weekly_anchor in (${inList(REPORT_SCHEDULE_WEEKDAYS)})) and (monthly_anchor is null or monthly_anchor between 1 and 31)`,
      ),
    ),
    check('report_schedules_timezone_check', sql`length(${table.timezone}) between 1 and 64`),
    check(
      'report_schedules_recipients_check',
      sql.raw(`cardinality(recipients) <= ${String(REPORT_SCHEDULE_MAX_RECIPIENTS)}`),
    ),
    check(
      'report_schedules_locale_check',
      sql.raw(`locale in (${inList(REPORT_SCHEDULE_LOCALES)})`),
    ),
    check(
      'report_schedules_status_check',
      sql.raw(`status in (${inList(REPORT_SCHEDULE_STATUSES)})`),
    ),
    // Active ⇔ a next occurrence; canceled ⇔ its instant; only an active
    // schedule is claimed.
    check(
      'report_schedules_next_run_agrees_check',
      sql`(${table.status} = 'active') = (${table.nextRunAt} is not null)`,
    ),
    check(
      'report_schedules_canceled_agrees_check',
      sql`(${table.status} = 'canceled') = (${table.canceledAt} is not null)`,
    ),
    check(
      'report_schedules_lease_agrees_check',
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null) and (${table.status} = 'active' or ${table.leaseToken} is null)`,
    ),
  ],
);

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
    /** The schedule that fired it (`report_schedules`), with the occurrence it fired for. */
    reportScheduleId: text(),
    scheduledFor: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('report_runs_public_id_key').on(table.publicId),
    /** One run per occurrence of a schedule: the single-fire guarantee. */
    uniqueIndex('report_runs_schedule_occurrence_key').on(
      table.reportScheduleId,
      table.scheduledFor,
    ),
    foreignKey({
      name: 'report_runs_report_schedule_fkey',
      columns: [table.reportScheduleId, table.merchantId],
      foreignColumns: [reportSchedules.id, reportSchedules.merchantId],
    }).onDelete('restrict'),
    check(
      'report_runs_schedule_agrees_check',
      sql`(${table.reportScheduleId} is null) = (${table.scheduledFor} is null)`,
    ),
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
