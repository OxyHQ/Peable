/**
 * Reads and writes for `report_runs` (`schema/reporting.ts` has the lifecycle).
 *
 * Three writers move a run, each ONE statement:
 *  - {@link claimReportRun} — the worker's claim, `for update skip locked`
 *    inside the `UPDATE`, so concurrent workers take different runs;
 *  - {@link completeReportRun} / {@link failReportRun} — gated on the claim's
 *    `lease_token`, so a worker that outlived its lease writes nothing;
 *  - {@link deferReportRun} — keeps the claim but lets it lapse later, so a
 *    run whose attempt failed for a passing reason waits before the next.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CurrencyCode, ReportRunStatus, ReportTypeId } from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { reportRuns } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';

export interface ReportRunRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly reportType: ReportTypeId;
  readonly intervalStart: Date;
  readonly intervalEnd: Date;
  readonly columns: string[] | null;
  readonly currency: CurrencyCode | null;
  readonly status: ReportRunStatus;
  readonly error: string | null;
  /** INTERNAL id of the result File. */
  readonly resultFileId: string | null;
  readonly succeededAt: Date | null;
  readonly attempts: number;
  /** INTERNAL id of the schedule that fired it, and the occurrence it fired for. */
  readonly reportScheduleId: string | null;
  readonly reportSchedulePublicId: string | null;
  readonly scheduledFor: Date | null;
  readonly createdAt: Date;
}

/** A claimed run: the row plus the token its completing write is gated on. */
export interface ClaimedReportRun extends ReportRunRow {
  readonly leaseToken: string;
}

const COLUMNS = {
  id: reportRuns.id,
  publicId: reportRuns.publicId,
  merchantId: reportRuns.merchantId,
  livemode: merchantLivemodeOf(reportRuns.merchantId),
  reportType: reportRuns.reportType,
  intervalStart: reportRuns.intervalStart,
  intervalEnd: reportRuns.intervalEnd,
  columns: reportRuns.columns,
  currency: reportRuns.currency,
  status: reportRuns.status,
  error: reportRuns.error,
  resultFileId: reportRuns.resultFileId,
  succeededAt: reportRuns.succeededAt,
  attempts: reportRuns.attempts,
  reportScheduleId: reportRuns.reportScheduleId,
  // A scalar subquery so RETURNING can carry it (see `merchantLivemodeOf`).
  reportSchedulePublicId: sql<
    string | null
  >`(select s.public_id from report_schedules s where s.id = report_runs.report_schedule_id)`,
  scheduledFor: reportRuns.scheduledFor,
  createdAt: reportRuns.createdAt,
} as const;

/** The CHECKs keep every narrowed column in its closed set. */
function toRow(row: Record<string, unknown>): ReportRunRow {
  return row as unknown as ReportRunRow;
}

export interface InsertReportRunParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly reportType: ReportTypeId;
  readonly intervalStart: Date;
  readonly intervalEnd: Date;
  readonly columns: readonly string[] | null;
  readonly currency: CurrencyCode | null;
  /** The schedule firing it and the occurrence — a direct request has neither. */
  readonly schedule?: { readonly id: string; readonly occurrence: Date } | undefined;
}

/**
 * Insert a pending run. A SCHEDULED run is unique per (schedule, occurrence):
 * an occurrence that already fired answers `null` and inserts nothing.
 */
export async function insertReportRun(
  db: DatabaseOrTransaction,
  params: InsertReportRunParams,
): Promise<ReportRunRow | null> {
  const [row] = await db
    .insert(reportRuns)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      reportType: params.reportType,
      intervalStart: params.intervalStart,
      intervalEnd: params.intervalEnd,
      columns: params.columns === null ? null : [...params.columns],
      currency: params.currency,
      reportScheduleId: params.schedule?.id ?? null,
      scheduledFor: params.schedule?.occurrence ?? null,
    })
    .onConflictDoNothing()
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

/** By primary key — an owed email's `report_run_id`. */
export async function findReportRunById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReportRunRow | null> {
  const [row] = await db.select(COLUMNS).from(reportRuns).where(eq(reportRuns.id, id));
  return row ? toRow(row) : null;
}

/** By `frr_…`, many at once, inside the merchant (`expand[]`). */
export async function findReportRunsByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<ReportRunRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(COLUMNS)
    .from(reportRuns)
    .where(
      and(eq(reportRuns.merchantId, merchantId), inArray(reportRuns.publicId, [...publicIds])),
    );
  return rows.map(toRow);
}

/** By `frr_…`, scoped to the merchant: another merchant's run is "not found". */
export async function findReportRunForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<ReportRunRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(reportRuns)
    .where(and(eq(reportRuns.merchantId, merchantId), eq(reportRuns.publicId, publicId)));
  return row ? toRow(row) : null;
}

/** One page of a merchant's runs, newest first (`db/keyset.ts`). */
export async function listReportRunsForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly reportType?: ReportTypeId | undefined;
    /** `frs_…`: only the runs that schedule fired (none for an unknown id). */
    readonly reportSchedule?: string | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: ReportRunRow[]; hasMore: boolean }> {
  const walk = keyset(reportRuns.id, reportRuns.createdAt, params.page);
  const rows = await db
    .select(COLUMNS)
    .from(reportRuns)
    .where(
      and(
        eq(reportRuns.merchantId, params.merchantId),
        params.reportType === undefined ? undefined : eq(reportRuns.reportType, params.reportType),
        params.reportSchedule === undefined
          ? undefined
          : eq(
              reportRuns.reportScheduleId,
              sql`(select s.id from report_schedules s where s.public_id = ${params.reportSchedule} and s.merchant_id = ${params.merchantId})`,
            ),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/**
 * Claim the oldest pending run nobody holds (or whose holder's lease ran out),
 * in ONE statement: the inner `for update skip locked` picks a row no
 * concurrent claim is taking, and the `UPDATE` stamps a fresh token on it.
 * Every instant is the database's, because the lease is compared across tasks
 * whose clocks may disagree.
 */
export async function claimReportRun(
  db: DatabaseOrTransaction,
  leaseSeconds: number,
): Promise<ClaimedReportRun | null> {
  const token = uuidv7();
  const [row] = await db
    .update(reportRuns)
    .set({
      leaseToken: token,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      attempts: sql`${reportRuns.attempts} + 1`,
    })
    .where(
      eq(
        reportRuns.id,
        sql`(select r.id from report_runs r where r.status = 'pending' and (r.lease_expires_at is null or r.lease_expires_at < now()) order by r.id limit 1 for update skip locked)`,
      ),
    )
    .returning(COLUMNS);
  return row ? { ...toRow(row), leaseToken: token } : null;
}

/** The run as its claim left it, or `null` when the claim is no longer this one's. */
export async function completeReportRun(
  db: DatabaseOrTransaction,
  run: ClaimedReportRun,
  resultFileId: string,
): Promise<ReportRunRow | null> {
  const [row] = await db
    .update(reportRuns)
    .set({
      status: 'succeeded',
      resultFileId,
      succeededAt: sql`date_trunc('milliseconds', now())`,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(reportRuns.id, run.id),
        eq(reportRuns.status, 'pending'),
        eq(reportRuns.leaseToken, run.leaseToken),
      ),
    )
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

export async function failReportRun(
  db: DatabaseOrTransaction,
  run: ClaimedReportRun,
  error: string,
): Promise<ReportRunRow | null> {
  const [row] = await db
    .update(reportRuns)
    .set({ status: 'failed', error, leaseToken: null, leaseExpiresAt: null })
    .where(
      and(
        eq(reportRuns.id, run.id),
        eq(reportRuns.status, 'pending'),
        eq(reportRuns.leaseToken, run.leaseToken),
      ),
    )
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Put a claimed run back to wait `seconds` before any worker retries it: the
 * lease is moved, not cleared, so the run is claimable again exactly when it
 * lapses — a backoff with no second column.
 */
export async function deferReportRun(
  db: DatabaseOrTransaction,
  run: ClaimedReportRun,
  seconds: number,
): Promise<void> {
  await db
    .update(reportRuns)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${seconds})` })
    .where(and(eq(reportRuns.id, run.id), eq(reportRuns.leaseToken, run.leaseToken)));
}
