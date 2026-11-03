import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import {
  defineComponent,
  defineObject,
  describe,
  type Expand,
  type ObjectMap,
  resolveObject,
} from '../../common/objects';
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
import { REPORT_RUN_STATUSES, REPORT_TYPE_IDS } from '../../vocabulary/reporting';

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

/**
 * The result File, embedded (Stripe's shape). The schema is the Files
 * contract's (`resolveObject('file')`); the TYPE is `ObjectMap['file']` once
 * that module registers it.
 *
 * TRANSITIONAL: until it does, the File's documented fields stand in for it, so
 * the run type is usable on its own. Once `file` is registered this is
 * `Ref<'file'>` exactly, and should be written so.
 */
export type ReportRunResultFile = ObjectMap extends { file: infer F }
  ? F
  : {
      id: string;
      object: 'file';
      livemode: boolean;
      purpose: string;
      filename: string | null;
      size: number;
      type: string;
      status: string;
      url: string | null;
      created: number;
    };
const embeddedFile = z.lazy(() =>
  resolveObject('file'),
) as unknown as z.ZodType<ReportRunResultFile>;

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
      result: embeddedFile
        .nullable()
        .describe(
          'The CSV once `succeeded` — a File of purpose `finance_report_run` (`GET /v1/files/{id}/contents` reads it).',
        ),
      succeeded_at: unixSeconds.nullable(),
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
      },
    ],
  },
);
export type ReportRun = Expand<z.output<typeof reportRunSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'reporting.report_type': ReportType;
    'reporting.report_run': ReportRun;
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

export const listReportRunsQuery = listQuery({ report_type: reportTypeId.optional() });
export type ListReportRunsParams = z.input<typeof listReportRunsQuery>;

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
] as const;
