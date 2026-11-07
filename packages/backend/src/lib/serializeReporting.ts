import type { ReportRun, ReportSchedule } from '@peable.to/shared-types';
import type { FileRow } from '../db/files/fileRepository';
import type { ReportRunRow } from '../db/reporting/reportRunRepository';
import type { ReportScheduleRow } from '../db/reporting/reportScheduleRepository';
import { toFileDTO } from '../services/files';
import { toUnix } from './time';

/** A report run on the wire; `result` is its CSV File, embedded (Stripe's shape). */
export function toReportRunDTO(row: ReportRunRow, result: FileRow | null): ReportRun {
  return {
    id: row.publicId,
    object: 'reporting.report_run',
    livemode: row.livemode,
    created: toUnix(row.createdAt),
    report_type: row.reportType,
    parameters: {
      interval_start: toUnix(row.intervalStart),
      interval_end: toUnix(row.intervalEnd),
      ...(row.columns !== null ? { columns: row.columns } : {}),
      ...(row.currency !== null ? { currency: row.currency } : {}),
    },
    status: row.status,
    error: row.error,
    result: result === null ? null : toFileDTO(result),
    succeeded_at: row.succeededAt === null ? null : toUnix(row.succeededAt),
    report_schedule: row.reportSchedulePublicId,
  };
}

/** A report schedule on the wire; `last_run` is the newest run's id (expandable). */
export function toReportScheduleDTO(row: ReportScheduleRow): ReportSchedule {
  return {
    id: row.publicId,
    object: 'reporting.report_schedule',
    livemode: row.livemode,
    created: toUnix(row.createdAt),
    report_type: row.reportType,
    parameters: {
      ...(row.columns !== null ? { columns: row.columns } : {}),
      ...(row.currency !== null ? { currency: row.currency } : {}),
    },
    schedule: {
      interval: row.interval,
      weekly_anchor: row.weeklyAnchor,
      monthly_anchor: row.monthlyAnchor,
    },
    timezone: row.timezone,
    recipients: row.recipients,
    locale: row.locale,
    status: row.status,
    next_run_at: row.nextRunAt === null ? null : toUnix(row.nextRunAt),
    last_run: row.lastRunPublicId,
    canceled_at: row.canceledAt === null ? null : toUnix(row.canceledAt),
  };
}
