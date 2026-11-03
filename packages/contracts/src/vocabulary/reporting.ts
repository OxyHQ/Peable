// Reporting and request-log vocabulary: the report types Peable produces, a
// run's lifecycle, and the methods and status classes a request log is
// filtered by. Zod-free, like every vocabulary module.

/**
 * Every report Peable produces, by Stripe's versioned id: the trailing `.1` is
 * the column layout's version, so a layout can change under a new id without
 * changing a report a merchant already parses. The layouts themselves are
 * `REPORT_TYPE_LAYOUTS` in `@peable.to/shared-types/reporting`.
 */
export const REPORT_TYPE_IDS = [
  'payments.itemized.1',
  'balance.summary.1',
  'balance_transactions.itemized.1',
  'payouts.itemized.1',
  'refunds.itemized.1',
  'disputes.itemized.1',
] as const;
export type ReportTypeId = (typeof REPORT_TYPE_IDS)[number];

export const REPORT_RUN_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

/** The HTTP methods a request log records. */
export const REQUEST_LOG_METHODS = ['GET', 'POST', 'DELETE', 'PATCH', 'PUT'] as const;
export type RequestLogMethod = (typeof REQUEST_LOG_METHODS)[number];

/** A request-log `status` filter's class form (`4xx` is 400–499). */
export const REQUEST_LOG_STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
export type RequestLogStatusClass = (typeof REQUEST_LOG_STATUS_CLASSES)[number];

/** How long a request log is kept (and served). */
export const REQUEST_LOG_RETENTION_DAYS = 30;
