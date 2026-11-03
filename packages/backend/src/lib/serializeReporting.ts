import type { ReportRun } from '@peable.to/shared-types';
import type { FileRow } from '../db/files/fileRepository';
import type { ReportRunRow } from '../db/reporting/reportRunRepository';
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
  };
}
