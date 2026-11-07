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

/**
 * A report schedule's lifecycle: `active` fires at each occurrence, `paused`
 * fires nothing until resumed (resuming never backfills), `canceled` is
 * terminal.
 */
export const REPORT_SCHEDULE_STATUSES = ['active', 'paused', 'canceled'] as const;
export type ReportScheduleStatus = (typeof REPORT_SCHEDULE_STATUSES)[number];

/**
 * How often a schedule fires — Stripe's payout-schedule spelling: every day,
 * once a week on `weekly_anchor`, once a month on `monthly_anchor`. Each
 * occurrence is local midnight in the schedule's timezone, and its run covers
 * the time since the previous occurrence.
 */
export const REPORT_SCHEDULE_INTERVALS = ['daily', 'weekly', 'monthly'] as const;
export type ReportScheduleInterval = (typeof REPORT_SCHEDULE_INTERVALS)[number];

/** A weekly schedule's day, Monday first (ISO 8601). */
export const REPORT_SCHEDULE_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type ReportScheduleWeekday = (typeof REPORT_SCHEDULE_WEEKDAYS)[number];

/** The languages a schedule's emails are written in — Orbit's own. */
export const REPORT_SCHEDULE_LOCALES = ['en', 'es'] as const;
export type ReportScheduleLocale = (typeof REPORT_SCHEDULE_LOCALES)[number];

/** How many addresses one schedule may email. */
export const REPORT_SCHEDULE_MAX_RECIPIENTS = 10;
