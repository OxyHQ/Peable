/**
 * Reads and writes for `report_schedules` (`schema/reporting.ts` has the
 * lifecycle). Every status write is ONE statement guarded on the status it
 * leaves, and the scheduler's two writes are the report run worker's pair:
 *
 *  - {@link claimDueReportSchedule} — the claim, `for update skip locked`
 *    inside the `UPDATE`, stamping a fresh `lease_token`;
 *  - {@link advanceReportSchedule} — moves `next_run_at` in the transaction
 *    that inserts the occurrence's run, gated on that token and on the
 *    schedule still being active, so a pause or cancel that landed in between
 *    rolls the fire back.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  ReportScheduleInterval,
  ReportScheduleLocale,
  ReportScheduleStatus,
  ReportScheduleWeekday,
  ReportTypeId,
} from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { reportSchedules } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';

export interface ReportScheduleRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly reportType: ReportTypeId;
  readonly columns: string[] | null;
  readonly currency: CurrencyCode | null;
  readonly interval: ReportScheduleInterval;
  readonly weeklyAnchor: ReportScheduleWeekday | null;
  readonly monthlyAnchor: number | null;
  readonly timezone: string;
  readonly recipients: string[];
  readonly locale: ReportScheduleLocale;
  readonly status: ReportScheduleStatus;
  readonly nextRunAt: Date | null;
  readonly canceledAt: Date | null;
  /** `frr_…` of the newest run it fired — read, never stored. */
  readonly lastRunPublicId: string | null;
  readonly createdAt: Date;
}

/** A claimed schedule, the token its advancing write is gated on, and the database's now. */
export interface ClaimedReportSchedule extends ReportScheduleRow {
  readonly leaseToken: string;
  readonly claimedAt: Date;
}

const COLUMNS = {
  id: reportSchedules.id,
  publicId: reportSchedules.publicId,
  merchantId: reportSchedules.merchantId,
  livemode: merchantLivemodeOf(reportSchedules.merchantId),
  reportType: reportSchedules.reportType,
  columns: reportSchedules.columns,
  currency: reportSchedules.currency,
  interval: reportSchedules.interval,
  weeklyAnchor: reportSchedules.weeklyAnchor,
  monthlyAnchor: reportSchedules.monthlyAnchor,
  timezone: reportSchedules.timezone,
  recipients: reportSchedules.recipients,
  locale: reportSchedules.locale,
  status: reportSchedules.status,
  nextRunAt: reportSchedules.nextRunAt,
  canceledAt: reportSchedules.canceledAt,
  // A scalar subquery so RETURNING can carry it (see `merchantLivemodeOf`);
  // `report_runs_schedule_occurrence_key` serves it. The outer column is
  // spelled by hand: drizzle renders a column in a select list unqualified,
  // and a bare `id` would bind to the inner `report_runs`.
  lastRunPublicId: sql<
    string | null
  >`(select r.public_id from report_runs r where r.report_schedule_id = report_schedules.id order by r.scheduled_for desc limit 1)`,
  createdAt: reportSchedules.createdAt,
} as const;

/** The CHECKs keep every narrowed column in its closed set. */
function toRow(row: Record<string, unknown>): ReportScheduleRow {
  return row as unknown as ReportScheduleRow;
}

/** What a schedule is: everything a create sets and an update may replace. */
export interface ReportScheduleFields {
  readonly reportType: ReportTypeId;
  readonly columns: readonly string[] | null;
  readonly currency: CurrencyCode | null;
  readonly interval: ReportScheduleInterval;
  readonly weeklyAnchor: ReportScheduleWeekday | null;
  readonly monthlyAnchor: number | null;
  readonly timezone: string;
  readonly recipients: readonly string[];
  readonly locale: ReportScheduleLocale;
}

function fieldValues(fields: ReportScheduleFields) {
  return {
    reportType: fields.reportType,
    columns: fields.columns === null ? null : [...fields.columns],
    currency: fields.currency,
    interval: fields.interval,
    weeklyAnchor: fields.weeklyAnchor,
    monthlyAnchor: fields.monthlyAnchor,
    timezone: fields.timezone,
    recipients: [...fields.recipients],
    locale: fields.locale,
  };
}

export async function insertReportSchedule(
  db: DatabaseOrTransaction,
  params: ReportScheduleFields & {
    readonly publicId: string;
    readonly merchantId: string;
    readonly nextRunAt: Date;
  },
): Promise<ReportScheduleRow> {
  const [row] = await db
    .insert(reportSchedules)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      ...fieldValues(params),
      status: 'active',
      nextRunAt: params.nextRunAt,
    })
    .returning(COLUMNS);
  if (!row) throw new Error('insertReportSchedule: no row returned');
  return toRow(row);
}

/** By `frs_…`, scoped to the merchant: another merchant's schedule is "not found". */
export async function findReportScheduleForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<ReportScheduleRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(reportSchedules)
    .where(and(eq(reportSchedules.merchantId, merchantId), eq(reportSchedules.publicId, publicId)));
  return row ? toRow(row) : null;
}

/** By primary key — a run's `report_schedule_id`. */
export async function findReportScheduleById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReportScheduleRow | null> {
  const [row] = await db.select(COLUMNS).from(reportSchedules).where(eq(reportSchedules.id, id));
  return row ? toRow(row) : null;
}

/** By `frs_…`, many at once, inside the merchant (`expand[]`). */
export async function findReportSchedulesByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<ReportScheduleRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(COLUMNS)
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.merchantId, merchantId),
        inArray(reportSchedules.publicId, [...publicIds]),
      ),
    );
  return rows.map(toRow);
}

/** One page of a merchant's schedules, newest first (`db/keyset.ts`). */
export async function listReportSchedulesForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly status?: ReportScheduleStatus | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: ReportScheduleRow[]; hasMore: boolean }> {
  const walk = keyset(reportSchedules.id, reportSchedules.createdAt, params.page);
  const rows = await db
    .select(COLUMNS)
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.merchantId, params.merchantId),
        params.status === undefined ? undefined : eq(reportSchedules.status, params.status),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/**
 * Replace what the schedule is, unless it is canceled. `nextRunAt` is the
 * caller's: a new occurrence for an ACTIVE schedule whose cadence or zone
 * changed (`null` keeps the stored one), never set on a paused one.
 * `null` when the schedule is canceled (or gone).
 */
export async function updateReportSchedule(
  db: DatabaseOrTransaction,
  schedule: Pick<ReportScheduleRow, 'id' | 'status'>,
  fields: ReportScheduleFields,
  nextRunAt: Date | null,
): Promise<ReportScheduleRow | null> {
  const [row] = await db
    .update(reportSchedules)
    .set({
      ...fieldValues(fields),
      ...(nextRunAt !== null && schedule.status === 'active'
        ? { nextRunAt, leaseToken: null, leaseExpiresAt: null }
        : {}),
    })
    .where(
      and(
        eq(reportSchedules.id, schedule.id),
        // The status the caller computed `nextRunAt` for.
        eq(reportSchedules.status, schedule.status),
        ne(reportSchedules.status, 'canceled'),
      ),
    )
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

/** `active → paused`: no next occurrence, no claim. `null` unless it was active. */
export async function pauseReportSchedule(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReportScheduleRow | null> {
  const [row] = await db
    .update(reportSchedules)
    .set({ status: 'paused', nextRunAt: null, leaseToken: null, leaseExpiresAt: null })
    .where(and(eq(reportSchedules.id, id), eq(reportSchedules.status, 'active')))
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

/** `paused → active` at `nextRunAt`, the first occurrence after now. `null` unless it was paused. */
export async function resumeReportSchedule(
  db: DatabaseOrTransaction,
  id: string,
  nextRunAt: Date,
): Promise<ReportScheduleRow | null> {
  const [row] = await db
    .update(reportSchedules)
    .set({ status: 'active', nextRunAt })
    .where(and(eq(reportSchedules.id, id), eq(reportSchedules.status, 'paused')))
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

/** `active|paused → canceled`, for good. `null` when it already was. */
export async function cancelReportSchedule(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ReportScheduleRow | null> {
  const [row] = await db
    .update(reportSchedules)
    .set({
      status: 'canceled',
      canceledAt: sql`date_trunc('milliseconds', now())`,
      nextRunAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(reportSchedules.id, id), ne(reportSchedules.status, 'canceled')))
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Claim the most overdue active schedule nobody holds (or whose holder's lease
 * ran out), in ONE statement. Every instant is the database's — `claimedAt`
 * included, which is the "now" the scheduler computes the due occurrence
 * from — because tasks' clocks may disagree.
 */
export async function claimDueReportSchedule(
  db: DatabaseOrTransaction,
  leaseSeconds: number,
): Promise<ClaimedReportSchedule | null> {
  const token = uuidv7();
  const [row] = await db
    .update(reportSchedules)
    .set({
      leaseToken: token,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
    })
    .where(
      eq(
        reportSchedules.id,
        sql`(select s.id from report_schedules s where s.status = 'active' and s.next_run_at <= now() and (s.lease_expires_at is null or s.lease_expires_at < now()) order by s.next_run_at limit 1 for update skip locked)`,
      ),
    )
    .returning({ ...COLUMNS, claimedAt: sql<Date>`now()`.mapWith(reportSchedules.createdAt) });
  return row ? { ...toRow(row), leaseToken: token, claimedAt: row.claimedAt } : null;
}

/**
 * Move a claimed schedule to its next occurrence and release the claim —
 * `false` when the claim is no longer this one's or the schedule stopped
 * being active, and the caller's transaction must not fire.
 */
export async function advanceReportSchedule(
  db: DatabaseOrTransaction,
  schedule: ClaimedReportSchedule,
  nextRunAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(reportSchedules)
    .set({ nextRunAt, leaseToken: null, leaseExpiresAt: null })
    .where(
      and(
        eq(reportSchedules.id, schedule.id),
        eq(reportSchedules.status, 'active'),
        eq(reportSchedules.leaseToken, schedule.leaseToken),
      ),
    )
    .returning({ id: reportSchedules.id });
  return rows.length === 1;
}
