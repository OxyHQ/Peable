import { z } from 'zod';
import { embedded, expandable } from '../../common/objects';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, describe, type Expand } from '../../common/objects';
import {
  emptyQuery,
  expandOnlyQuery,
  listQuery,
  queryInteger,
  unixSecondsParam,
} from '../../common/params';
import { currency, livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { CURRENCY_CODES } from '../../vocabulary/money';
import {
  REPORT_RUN_STATUSES,
  REPORT_SCHEDULE_INTERVALS,
  REPORT_SCHEDULE_LOCALES,
  REPORT_SCHEDULE_MAX_RECIPIENTS,
  REPORT_SCHEDULE_STATUSES,
  REPORT_SCHEDULE_WEEKDAYS,
  REPORT_TYPE_IDS,
} from '../../vocabulary/reporting';

/**
 * Reporting (Stripe's `reporting.*`): a merchant asks for a report over an
 * interval, Peable computes it in the background and stores the CSV as a
 * `file_…` of purpose `finance_report_run` — or downloads the same CSV at once,
 * streamed (`GET /v1/reporting/report_types/{id}/csv`). Both are ONE report:
 * the same layout, the same columns, the same computation. The layouts are
 * `REPORT_TYPE_LAYOUTS` in `@peable.to/shared-types/reporting`.
 */

const reportTypeId = z.enum(REPORT_TYPE_IDS);

/** `reporting.report_type` — what can be run, and over which interval data exists. */
export const reportTypeSchema = defineObject(
  'reporting.report_type',
  'ReportType',
  z
    .object({
      id: reportTypeId.describe(
        '`payments.itemized.1`, …; the trailing number is the layout version.',
      ),
      object: z.literal('reporting.report_type'),
      livemode,
      name: z.string(),
      version: z
        .number()
        .int()
        .describe("The column layout's version — the trailing number of the id."),
      columns: z
        .array(z.string())
        .describe('Every column `parameters.columns` may name, in the order they are written.'),
      default_columns: z.array(z.string()),
      data_available_start: unixSeconds.describe('The earliest `interval_start` with data.'),
      data_available_end: unixSeconds.describe(
        'The latest `interval_end` a run may ask for: now — the data is live.',
      ),
      updated: unixSeconds.describe('When the layout last changed.'),
    })
    .strict(),
  {
    examples: [
      {
        id: 'balance.summary.1',
        object: 'reporting.report_type',
        livemode: false,
        name: 'Balance summary',
        version: 1,
        columns: [
          'category',
          'description',
          'currency',
          'net_amount',
          'transaction_count',
          'net_amount_decimal',
        ],
        default_columns: ['category', 'description', 'currency', 'net_amount'],
        data_available_start: 1790000000,
        data_available_end: 1793750400,
        updated: 1793664000,
      },
    ],
  },
);
export type ReportType = Expand<z.output<typeof reportTypeSchema>>;

/** What a run was asked to cover. */
export const reportRunParametersSchema = defineComponent(
  'ReportRunParameters',
  z
    .object({
      interval_start: unixSeconds.describe('Inclusive.'),
      interval_end: unixSeconds.describe('Exclusive.'),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          "The columns, in the layout's order; the report type's `default_columns` when absent.",
        ),
      currency: currency.optional().describe('Only this currency.'),
    })
    .strict(),
);
export type ReportRunParameters = z.output<typeof reportRunParametersSchema>;

/** `reporting.report_run` (`frr_…`). */
export const reportRunSchema = defineObject(
  'reporting.report_run',
  'ReportRun',
  z
    .object({
      id: z.string(),
      object: z.literal('reporting.report_run'),
      livemode,
      created: unixSeconds,
      report_type: reportTypeId,
      parameters: reportRunParametersSchema,
      status: z.enum(REPORT_RUN_STATUSES),
      error: z.string().nullable().describe('Why a `failed` run failed; `null` otherwise.'),
      result: embedded('file')
        .nullable()
        .describe(
          'The CSV once `succeeded` — a File of purpose `finance_report_run` (`GET /v1/files/{id}/contents` reads it).',
        ),
      succeeded_at: unixSeconds.nullable(),
      report_schedule: expandable(
        'reporting.report_schedule',
        'The schedule that fired this run (`frs_…`); `null` for a run asked for directly.',
      ).nullable(),
    })
    .strict(),
  {
    examples: [
      {
        id: 'frr_0193b8f34d1e4a6b8c27',
        object: 'reporting.report_run',
        livemode: false,
        created: 1793750400,
        report_type: 'balance.summary.1',
        parameters: { interval_start: 1790985600, interval_end: 1793577600 },
        status: 'pending',
        error: null,
        result: null,
        succeeded_at: null,
        report_schedule: null,
      },
    ],
  },
);
export type ReportRun = Expand<z.output<typeof reportRunSchema>>;

/** When a schedule fires (Stripe's payout-schedule spelling). */
export const reportScheduleCadenceSchema = defineComponent(
  'ReportScheduleCadence',
  z
    .object({
      interval: z.enum(REPORT_SCHEDULE_INTERVALS),
      weekly_anchor: z
        .enum(REPORT_SCHEDULE_WEEKDAYS)
        .nullable()
        .describe('The day a `weekly` schedule fires; `null` otherwise.'),
      monthly_anchor: z
        .number()
        .int()
        .nullable()
        .describe(
          'The day of the month a `monthly` schedule fires (1–31; a shorter month fires on its last day); `null` otherwise.',
        ),
    })
    .strict(),
);

/**
 * `reporting.report_schedule` (`frs_…`): a report run on a cadence. Each
 * occurrence is local midnight in `timezone`; it creates an ordinary report
 * run over the time since the previous occurrence, and emails `recipients` a
 * link to it in Orbit once it succeeded (or failed). The CSV is never attached
 * and never public: a recipient signs in to Orbit to download it.
 */
export const reportScheduleSchema = defineObject(
  'reporting.report_schedule',
  'ReportSchedule',
  z
    .object({
      id: z.string(),
      object: z.literal('reporting.report_schedule'),
      livemode,
      created: unixSeconds,
      report_type: reportTypeId,
      parameters: z
        .object({
          columns: z.array(z.string()).optional(),
          currency: currency.optional(),
        })
        .strict()
        .describe(
          "Every run's `parameters` but the interval, which each occurrence sets: the time since the previous occurrence.",
        ),
      schedule: reportScheduleCadenceSchema,
      timezone: z
        .string()
        .describe('The IANA time zone whose midnight each occurrence is (`Europe/Madrid`).'),
      recipients: z
        .array(z.string())
        .describe('Who is emailed when a run of this schedule succeeds or fails.'),
      locale: z.enum(REPORT_SCHEDULE_LOCALES).describe('The language of those emails.'),
      status: z.enum(REPORT_SCHEDULE_STATUSES),
      next_run_at: unixSeconds
        .nullable()
        .describe('The next occurrence while `active`; `null` while paused or canceled.'),
      last_run: expandable(
        'reporting.report_run',
        'The newest run this schedule fired.',
      ).nullable(),
      canceled_at: unixSeconds.nullable(),
    })
    .strict(),
  {
    examples: [
      {
        id: 'frs_0193b8f34d1e4a6b8c27',
        object: 'reporting.report_schedule',
        livemode: false,
        created: 1793750400,
        report_type: 'balance.summary.1',
        parameters: {},
        schedule: { interval: 'monthly', weekly_anchor: null, monthly_anchor: 1 },
        timezone: 'Europe/Madrid',
        recipients: ['finance@example.com'],
        locale: 'en',
        status: 'active',
        next_run_at: 1796079600,
        last_run: null,
        canceled_at: null,
      },
    ],
  },
);
export type ReportSchedule = Expand<z.output<typeof reportScheduleSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'reporting.report_type': ReportType;
    'reporting.report_run': ReportRun;
    'reporting.report_schedule': ReportSchedule;
  }
}

const column = z.string().min(1).max(64);

/** `POST /v1/reporting/report_runs`. */
export const createReportRunParams = z
  .object({
    report_type: reportTypeId,
    parameters: z
      .object({
        interval_start: unixSecondsParam.describe('Inclusive, Unix seconds.'),
        interval_end: unixSecondsParam.describe(
          'Exclusive, Unix seconds; after `interval_start` and not in the future.',
        ),
        columns: z
          .array(column)
          .min(1)
          .max(64)
          .optional()
          .describe("Columns of the report type's layout, each once."),
        currency: z.enum(CURRENCY_CODES).optional(),
      })
      .strict(),
  })
  .strict();
export type CreateReportRunParams = z.input<typeof createReportRunParams>;

export const listReportRunsQuery = listQuery({
  report_type: reportTypeId.optional(),
  report_schedule: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Only the runs this schedule (`frs_…`) fired.'),
});
export type ListReportRunsParams = z.input<typeof listReportRunsQuery>;

/** A schedule's run template: a run's `parameters` without the interval. */
const scheduleParameters = z
  .object({
    columns: z
      .array(column)
      .min(1)
      .max(64)
      .optional()
      .describe("Columns of the report type's layout, each once."),
    currency: z.enum(CURRENCY_CODES).optional(),
  })
  .strict();

const cadenceParams = z
  .object({
    interval: z.enum(REPORT_SCHEDULE_INTERVALS),
    weekly_anchor: z
      .enum(REPORT_SCHEDULE_WEEKDAYS)
      .optional()
      .describe('Required for `weekly`, refused otherwise.'),
    monthly_anchor: z
      .number()
      .int()
      .min(1)
      .max(31)
      .optional()
      .describe(
        'Required for `monthly`, refused otherwise; a shorter month fires on its last day.',
      ),
  })
  .strict();

const recipientsParam = z
  .array(z.email().max(254))
  .max(REPORT_SCHEDULE_MAX_RECIPIENTS)
  .describe(
    `At most ${String(REPORT_SCHEDULE_MAX_RECIPIENTS)} addresses, each once. They receive a link to the run in Orbit, never the file.`,
  );

const timezoneParam = z
  .string()
  .min(1)
  .max(64)
  .describe('An IANA time zone (`Europe/Madrid`); `UTC` when absent.');

/** `POST /v1/reporting/report_schedules`. */
export const createReportScheduleParams = z
  .object({
    report_type: reportTypeId,
    parameters: scheduleParameters.optional(),
    schedule: cadenceParams,
    timezone: timezoneParam.optional(),
    recipients: recipientsParam.optional(),
    locale: z.enum(REPORT_SCHEDULE_LOCALES).optional().describe('`en` when absent.'),
  })
  .strict();
export type CreateReportScheduleParams = z.input<typeof createReportScheduleParams>;

/** `POST /v1/reporting/report_schedules/{id}`: each field sent replaces the stored one. */
export const updateReportScheduleParams = z
  .object({
    report_type: reportTypeId.optional(),
    parameters: scheduleParameters.optional(),
    schedule: cadenceParams.optional(),
    timezone: timezoneParam.optional(),
    recipients: recipientsParam.optional(),
    locale: z.enum(REPORT_SCHEDULE_LOCALES).optional(),
  })
  .strict();
export type UpdateReportScheduleParams = z.input<typeof updateReportScheduleParams>;

/** Pause, resume and cancel take no parameters. */
export const reportScheduleActionParams = z.object({}).strict();

export const listReportSchedulesQuery = listQuery({
  status: z.enum(REPORT_SCHEDULE_STATUSES).optional(),
});
export type ListReportSchedulesParams = z.input<typeof listReportSchedulesQuery>;

/**
 * A download's query: a run's `parameters`, spelled as a query string
 * (`columns[]=a&columns[]=b`, or one `columns=a`).
 */
export const downloadReportQuery = z
  .object({
    interval_start: queryInteger({ min: 0 }).describe('Inclusive, Unix seconds.'),
    interval_end: queryInteger({ min: 0 }).describe('Exclusive, Unix seconds.'),
    columns: describe(
      z
        .union([z.string(), z.array(z.string())])
        .transform((value) => (typeof value === 'string' ? [value] : value))
        .pipe(z.array(column).min(1).max(64)),
      {
        description: "Columns of the report type's layout, each once.",
        jsonSchema: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 64 },
          minItems: 1,
          maxItems: 64,
        },
      },
    ).optional(),
    currency: z.enum(CURRENCY_CODES).optional(),
  })
  .strict();
export type DownloadReportParams = z.input<typeof downloadReportQuery>;

const reportTypeIdParam = { id: 'The report type (`payments.itemized.1`, …).' } as const;
const reportScheduleIdParam = { id: 'The report schedule (`frs_…`).' } as const;

export const reportingRoutes = [
  defineRoute({
    operationId: 'listReportTypes',
    method: 'get',
    path: '/v1/reporting/report_types',
    tag: 'Reporting',
    summary: 'List report types',
    description:
      'Every report Peable produces (a complete set), with the interval data exists for.',
    auth: 'service',
    scope: 'payments:read',
    query: emptyQuery,
    response: listOf(reportTypeSchema),
    sdk: 'reporting.reportTypes.list',
  }),
  defineRoute({
    operationId: 'retrieveReportType',
    method: 'get',
    path: '/v1/reporting/report_types/{id}',
    tag: 'Reporting',
    summary: 'Retrieve a report type',
    auth: 'service',
    scope: 'payments:read',
    params: reportTypeIdParam,
    query: emptyQuery,
    response: reportTypeSchema,
    sdk: 'reporting.reportTypes.retrieve',
  }),
  defineRoute({
    operationId: 'downloadReport',
    method: 'get',
    path: '/v1/reporting/report_types/{id}/csv',
    tag: 'Reporting',
    summary: 'Download a report',
    description:
      'The same report a run produces, with the same parameters, streamed at once as CSV instead of stored. Every refusal is the JSON error before the first byte; a read that fails afterwards aborts the response, so a truncated file never ends cleanly.',
    auth: 'service',
    scope: 'payments:read',
    params: reportTypeIdParam,
    query: downloadReportQuery,
    response: { kind: 'binary', contentType: 'text/csv' },
    sdk: 'reporting.reportTypes.download',
  }),
  defineRoute({
    operationId: 'createReportRun',
    method: 'post',
    path: '/v1/reporting/report_runs',
    tag: 'Reporting',
    summary: 'Create a report run',
    description:
      'Answers `pending` at once; the CSV is produced in the background and announced with `reporting.report_run.succeeded` (or `.failed`).',
    auth: 'service',
    scope: 'payments:read',
    idempotent: true,
    body: createReportRunParams,
    response: reportRunSchema,
    sdk: 'reporting.reportRuns.create',
  }),
  defineRoute({
    operationId: 'listReportRuns',
    method: 'get',
    path: '/v1/reporting/report_runs',
    tag: 'Reporting',
    summary: 'List report runs',
    auth: 'service',
    scope: 'payments:read',
    query: listReportRunsQuery,
    response: listOf(reportRunSchema),
    sdk: 'reporting.reportRuns.list',
    expandable: 'reporting.report_run',
  }),
  defineRoute({
    operationId: 'retrieveReportRun',
    method: 'get',
    path: '/v1/reporting/report_runs/{id}',
    tag: 'Reporting',
    summary: 'Retrieve a report run',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The report run (`frr_…`).' },
    query: expandOnlyQuery,
    response: reportRunSchema,
    sdk: 'reporting.reportRuns.retrieve',
    expandable: 'reporting.report_run',
  }),
  defineRoute({
    operationId: 'createReportSchedule',
    method: 'post',
    path: '/v1/reporting/report_schedules',
    tag: 'Reporting',
    summary: 'Create a report schedule',
    description:
      'A report run at local midnight in `timezone` every day, week or month, each over the time since the previous occurrence. `next_run_at` is the first occurrence after now; nothing is backfilled.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createReportScheduleParams,
    response: reportScheduleSchema,
    sdk: 'reporting.reportSchedules.create',
  }),
  defineRoute({
    operationId: 'listReportSchedules',
    method: 'get',
    path: '/v1/reporting/report_schedules',
    tag: 'Reporting',
    summary: 'List report schedules',
    description: 'Newest first; a canceled schedule is listed too.',
    auth: 'service',
    scope: 'payments:read',
    query: listReportSchedulesQuery,
    response: listOf(reportScheduleSchema),
    sdk: 'reporting.reportSchedules.list',
    expandable: 'reporting.report_schedule',
  }),
  defineRoute({
    operationId: 'retrieveReportSchedule',
    method: 'get',
    path: '/v1/reporting/report_schedules/{id}',
    tag: 'Reporting',
    summary: 'Retrieve a report schedule',
    auth: 'service',
    scope: 'payments:read',
    params: reportScheduleIdParam,
    query: expandOnlyQuery,
    response: reportScheduleSchema,
    sdk: 'reporting.reportSchedules.retrieve',
    expandable: 'reporting.report_schedule',
  }),
  defineRoute({
    operationId: 'updateReportSchedule',
    method: 'post',
    path: '/v1/reporting/report_schedules/{id}',
    tag: 'Reporting',
    summary: 'Update a report schedule',
    description:
      'A new `schedule` or `timezone` moves an active schedule to its first occurrence after now. A canceled schedule cannot change (409 `report_schedule_unexpected_state`).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: reportScheduleIdParam,
    body: updateReportScheduleParams,
    response: reportScheduleSchema,
    sdk: 'reporting.reportSchedules.update',
  }),
  defineRoute({
    operationId: 'pauseReportSchedule',
    method: 'post',
    path: '/v1/reporting/report_schedules/{id}/pause',
    tag: 'Reporting',
    summary: 'Pause a report schedule',
    description:
      'Nothing fires until it is resumed. Pausing a paused schedule answers it as it is.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: reportScheduleIdParam,
    body: reportScheduleActionParams,
    response: reportScheduleSchema,
    sdk: 'reporting.reportSchedules.pause',
  }),
  defineRoute({
    operationId: 'resumeReportSchedule',
    method: 'post',
    path: '/v1/reporting/report_schedules/{id}/resume',
    tag: 'Reporting',
    summary: 'Resume a paused report schedule',
    description:
      'It fires again from its first occurrence after now; the occurrences it missed while paused are not run.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: reportScheduleIdParam,
    body: reportScheduleActionParams,
    response: reportScheduleSchema,
    sdk: 'reporting.reportSchedules.resume',
  }),
  defineRoute({
    operationId: 'cancelReportSchedule',
    method: 'post',
    path: '/v1/reporting/report_schedules/{id}/cancel',
    tag: 'Reporting',
    summary: 'Cancel a report schedule',
    description:
      'For good: it never fires again, and a run it fires no longer emails anyone. Its runs and their files stay.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: reportScheduleIdParam,
    body: reportScheduleActionParams,
    response: reportScheduleSchema,
    sdk: 'reporting.reportSchedules.cancel',
  }),
] as const;
