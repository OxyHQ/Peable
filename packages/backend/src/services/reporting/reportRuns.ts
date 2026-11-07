/**
 * The ONE way a report run comes to exist: `POST /v1/reporting/report_runs`
 * and every occurrence of a schedule (`reportScheduler.ts`) insert their
 * `pending` row here, and the report run worker produces both alike — one
 * queue, one CSV path, one column list.
 */
import type { DatabaseOrTransaction } from '../../db/postgres';
import { insertReportRun, type ReportRunRow } from '../../db/reporting/reportRunRepository';
import { newId } from '../../lib/ids';
import type { ReportRequest } from './reports';

/**
 * Queue a run of an admitted request. A scheduled run names its schedule and
 * occurrence, unique together: an occurrence that already fired answers
 * `null`. A direct request always answers its row.
 */
export async function enqueueReportRun(
  db: DatabaseOrTransaction,
  merchantId: string,
  request: ReportRequest,
  schedule?: { readonly id: string; readonly occurrence: Date },
): Promise<ReportRunRow | null> {
  return insertReportRun(db, {
    publicId: newId('frr'),
    merchantId,
    reportType: request.reportType,
    intervalStart: request.intervalStart,
    intervalEnd: request.intervalEnd,
    columns: request.columns === null ? null : [...request.columns],
    currency: request.currency,
    schedule,
  });
}
