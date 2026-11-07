/**
 * Reporting (Stripe's `reporting.*`): the report types and report runs.
 *
 * - `GET /v1/reporting/report_types` / `…/:id` — what can be run, with the
 *   interval data exists for;
 * - `POST /v1/reporting/report_runs` — ask for one; it answers `pending` at
 *   once and the worker (`services/reporting/reportRunWorker.ts`) produces the
 *   CSV in the background, announcing `reporting.report_run.succeeded` or
 *   `.failed`;
 * - `GET /v1/reporting/report_runs` / `…/:id` — the runs, each with its
 *   `result` File once it succeeded (`GET /v1/files/:id/contents` reads it);
 * - `GET /v1/reporting/report_types/:id/csv` — the SAME report, with the same
 *   parameters as a run, streamed at once instead of stored: no size ceiling,
 *   memory bounded by a batch (`streamReport`). Every refusal is the JSON error
 *   before the first byte; a read that fails afterwards destroys the response,
 *   so a truncated file never ends cleanly.
 *
 * A run and a download validate their parameters with ONE function and read
 * and render with ONE module (`services/reporting/reports.ts`).
 *
 * Every handler is a CORE `(req, res, merchant, surface)` shared with Orbit's
 * dashboard (`mountReportingDashboardRoutes`), as the money surface is.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  type CurrencyCode,
  createReportRunParams,
  createReportScheduleParams,
  listReportSchedulesQuery,
  reportScheduleActionParams,
  updateReportScheduleParams,
  downloadReportQuery,
  emptyQuery,
  expandOnlyQuery,
  listReportRunsQuery,
  REPORT_TYPE_IDS,
  type ReportType,
  type ReportTypeId,
} from '@peable.to/contracts';
import { REPORT_TYPE_LAYOUTS } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findFilesByIds } from '../db/files/fileRepository';
import { earliestReportData } from '../db/reporting/reportData';
import {
  findReportRunForMerchant,
  listReportRunsForMerchant,
  type ReportRunRow,
} from '../db/reporting/reportRunRepository';
import {
  cancelReportSchedule,
  findReportScheduleForMerchant,
  insertReportSchedule,
  listReportSchedulesForMerchant,
  pauseReportSchedule,
  type ReportScheduleRow,
  resumeReportSchedule,
  updateReportSchedule,
} from '../db/reporting/reportScheduleRepository';
import {
  requireAuthenticated,
  sendError,
  sendValidationError,
  wrap,
  requireScope,
} from '../lib/http';
import { idempotent, runIdempotent } from '../lib/idempotency';
import { newId } from '../lib/ids';
import { expandObjects, parseExpand } from '../lib/expand';
import { answerList, completeList, parseQuery, type QuerySurface, surfaceQuery } from '../lib/list';
import { sendMoneyRefusal } from '../lib/moneyHttp';
import { toReportRunDTO, toReportScheduleDTO } from '../lib/serializeReporting';
import { toUnix } from '../lib/time';
import { requestContextMiddleware } from '../lib/requestContext';
import { AccountMissingError } from '../services/accounts/merchantAccount';
import {
  downloadFilename,
  ledgerScopeForReport,
  openReport,
  reportColumnsProblem,
  ReportLedgerMissingError,
  type ReportRequest,
  streamReport,
} from '../services/reporting/reports';
import { enqueueReportRun } from '../services/reporting/reportRuns';
import {
  firstOccurrenceAfter,
  type ScheduleInput,
  scheduleFields,
  scheduleInputOf,
} from '../services/reporting/reportSchedules';
import { kickReportRunWorker } from '../services/reporting/reportRunWorker';
import { resolveMerchant } from './paymentIntents';
import type { DashboardGate } from './dashboardAccess';

/** When the current layouts (`.1`) were defined — `ReportType.updated`. */
const LAYOUTS_UPDATED = Date.UTC(2026, 10, 3) / 1000;

/**
 * Request schemas: the contract's (`@peable.to/contracts` `reportingRoutes`);
 * the dashboard surface accepts the same plus its `environment` toggle.
 */
const downloadQuery = surfaceQuery(downloadReportQuery);
const listRunsQuery = surfaceQuery(listReportRunsQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);
const listSchedulesQuery = surfaceQuery(listReportSchedulesQuery);
const reportTypesQuery = surfaceQuery(emptyQuery);

function paramId(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

/** The runs with their result Files, in one read of `files`. */
async function serializeRuns(merchantId: string, rows: readonly ReportRunRow[]) {
  const ids = rows.map((row) => row.resultFileId).filter((id): id is string => id !== null);
  const files = new Map(
    (await findFilesByIds(getDb(), merchantId, ids)).map((file) => [file.id, file]),
  );
  return rows.map((row) =>
    toReportRunDTO(row, row.resultFileId === null ? null : (files.get(row.resultFileId) ?? null)),
  );
}

async function reportTypes(merchant: MerchantRow): Promise<ReportType[]> {
  const earliest = await earliestReportData(getDb(), merchant.id);
  const now = Math.floor(Date.now() / 1000);
  const start = (at: Date | null) => toUnix(at ?? merchant.createdAt);
  const from: Record<ReportTypeId, Date | null> = {
    'payments.itemized.1': earliest.payments,
    'balance.summary.1': earliest.ledger,
    'balance_transactions.itemized.1': earliest.ledger,
    'payouts.itemized.1': earliest.payouts,
    'refunds.itemized.1': earliest.refunds,
    'disputes.itemized.1': earliest.disputes,
  };
  return REPORT_TYPE_IDS.map((id) => {
    const layout = REPORT_TYPE_LAYOUTS[id];
    return {
      id,
      object: 'reporting.report_type',
      livemode: merchant.livemode,
      name: layout.name,
      version: Number(id.slice(id.lastIndexOf('.') + 1)),
      columns: [...layout.columns],
      default_columns: [...layout.default_columns],
      data_available_start: Math.min(start(from[id]), now),
      data_available_end: now,
      updated: LAYOUTS_UPDATED,
    };
  });
}

export async function answerReportTypeList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, reportTypesQuery[surface])) return;
  res.status(200).json(completeList(req, await reportTypes(merchant)));
}

export async function retrieveReportType(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, reportTypesQuery[surface])) return;
  const id = paramId(req, res);
  if (!id) return;
  const type = (await reportTypes(merchant)).find((candidate) => candidate.id === id);
  if (!type) {
    sendError(res, 404, 'invalid_request_error', 'report type not found', 'resource_missing', 'id');
    return;
  }
  res.status(200).json(type);
}

/**
 * The one check of what a report is asked to cover, for a run (`parameters[…]`)
 * and a download (the query) alike: a real interval that has passed, columns
 * the layout has (each once), and an account for a ledger report. Answers the
 * refusal and returns `null`, or the request.
 */
async function admitReportRequest(
  res: Response,
  merchant: MerchantRow,
  reportType: ReportTypeId,
  parameters: {
    readonly interval_start: number;
    readonly interval_end: number;
    readonly columns?: readonly string[] | undefined;
    readonly currency?: CurrencyCode | undefined;
  },
  paramPrefix: 'parameters' | null,
): Promise<ReportRequest | null> {
  const name = (field: string) => (paramPrefix ? `${paramPrefix}[${field}]` : field);
  const refuse = (message: string, field: string) => {
    sendError(res, 400, 'invalid_request_error', message, 'parameter_invalid', name(field));
    return null;
  };
  if (parameters.interval_start >= parameters.interval_end) {
    return refuse('interval_end must be after interval_start', 'interval_end');
  }
  if (parameters.interval_end > Math.floor(Date.now() / 1000)) {
    return refuse(
      'interval_end is in the future; a report covers time that has passed',
      'interval_end',
    );
  }
  const columnsProblem = reportColumnsProblem(reportType, parameters.columns);
  if (columnsProblem !== null) return refuse(columnsProblem, 'columns');
  if (REPORT_TYPE_LAYOUTS[reportType].ledger && (await ledgerScopeForReport(merchant)) === null) {
    sendMoneyRefusal(res, new AccountMissingError());
    return null;
  }
  return {
    reportType,
    intervalStart: new Date(parameters.interval_start * 1000),
    intervalEnd: new Date(parameters.interval_end * 1000),
    columns: parameters.columns ?? null,
    currency: parameters.currency ?? null,
  };
}

/** `GET /v1/reporting/report_types/:id/csv` — the report, streamed. */
export async function downloadReport(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, downloadQuery[surface]);
  if (!query) return;
  const id = paramId(req, res);
  if (!id) return;
  if (!(REPORT_TYPE_IDS as readonly string[]).includes(id)) {
    sendError(res, 404, 'invalid_request_error', 'report type not found', 'resource_missing', 'id');
    return;
  }
  const request = await admitReportRequest(res, merchant, id as ReportTypeId, query, null);
  if (!request) return;
  let report: Awaited<ReturnType<typeof openReport>>;
  try {
    report = await openReport(request, merchant);
  } catch (error) {
    if (error instanceof ReportLedgerMissingError) {
      sendMoneyRefusal(res, new AccountMissingError());
      return;
    }
    throw error;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${downloadFilename(request, merchant.livemode)}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (await streamReport(res, report)) res.end();
  } catch (error) {
    // Past the header row there is no error envelope to send; the error
    // handler would `end()` the response and the file would look complete.
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/** `POST /v1/reporting/report_runs`. */
export async function createReportRun(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createReportRunParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { report_type: reportType, parameters } = parsed.data;
  const request = await admitReportRequest(res, merchant, reportType, parameters, 'parameters');
  if (!request) return;
  const row = await enqueueReportRun(getDb(), merchant.id, request);
  if (!row) throw new Error('createReportRun: a direct run was not inserted');
  kickReportRunWorker();
  res.status(200).json(toReportRunDTO(row, null));
}

export async function retrieveReportRun(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  const expand = parseExpand(res, 'reporting.report_run', query.expand, { list: false });
  if (!expand) return;
  const id = paramId(req, res);
  if (!id) return;
  const row = await findReportRunForMerchant(getDb(), merchant.id, id);
  if (!row) {
    sendError(res, 404, 'invalid_request_error', 'report run not found', 'resource_missing', 'id');
    return;
  }
  const [dto] = await serializeRuns(merchant.id, [row]);
  if (dto) await expandObjects([dto], 'reporting.report_run', expand, merchant.id);
  res.status(200).json(dto);
}

export async function answerReportRunList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, listRunsQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'reporting.report_run',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findReportRunForMerchant(db, merchant.id, publicId))?.id ?? null,
    fetch: async (page) => {
      const result = await listReportRunsForMerchant(db, {
        merchantId: merchant.id,
        reportType: query.report_type,
        reportSchedule: query.report_schedule,
        page,
      });
      // Serialized here, in one read of `files`, not one per run.
      return { data: await serializeRuns(merchant.id, result.data), hasMore: result.hasMore };
    },
    serialize: (dto) => dto,
  });
}

// ---- Report schedules ---------------------------------------------------------------

/** The schedule the path names, or the 404 answered. */
async function scheduleOf(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<ReportScheduleRow | null> {
  const id = paramId(req, res);
  if (!id) return null;
  const row = await findReportScheduleForMerchant(getDb(), merchant.id, id);
  if (!row) {
    sendError(
      res,
      404,
      'invalid_request_error',
      'report schedule not found',
      'resource_missing',
      'id',
    );
  }
  return row;
}

function refuseCanceled(res: Response): void {
  sendError(
    res,
    409,
    'invalid_request_error',
    'a canceled report schedule never changes; create a new one',
    'report_schedule_unexpected_state',
  );
}

/**
 * The checks a create and an update share: the schedule's own rule
 * (`scheduleFields`), then — for a ledger report — an account to read, as a
 * run asks. Answers the refusal and returns `null`, or the fields.
 */
async function admitSchedule(res: Response, merchant: MerchantRow, input: ScheduleInput) {
  const checked = scheduleFields(input);
  if (!checked.ok) {
    const { code, message, param } = checked.refusal;
    sendError(res, 400, 'invalid_request_error', message, code, param);
    return null;
  }
  if (
    REPORT_TYPE_LAYOUTS[checked.fields.reportType].ledger &&
    (await ledgerScopeForReport(merchant)) === null
  ) {
    sendMoneyRefusal(res, new AccountMissingError());
    return null;
  }
  return checked.fields;
}

/** `POST /v1/reporting/report_schedules`. */
export async function createReportSchedule(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createReportScheduleParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const fields = await admitSchedule(res, merchant, parsed.data);
  if (!fields) return;
  const row = await insertReportSchedule(getDb(), {
    ...fields,
    publicId: newId('frs'),
    merchantId: merchant.id,
    nextRunAt: firstOccurrenceAfter(fields, new Date()),
  });
  res.status(200).json(toReportScheduleDTO(row));
}

export async function retrieveReportSchedule(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  const expand = parseExpand(res, 'reporting.report_schedule', query.expand, { list: false });
  if (!expand) return;
  const row = await scheduleOf(req, res, merchant);
  if (!row) return;
  const dto = toReportScheduleDTO(row);
  await expandObjects([dto], 'reporting.report_schedule', expand, merchant.id);
  res.status(200).json(dto);
}

export async function answerReportScheduleList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, listSchedulesQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'reporting.report_schedule',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findReportScheduleForMerchant(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) =>
      listReportSchedulesForMerchant(db, { merchantId: merchant.id, status: query.status, page }),
    serialize: toReportScheduleDTO,
  });
}

/**
 * `POST /v1/reporting/report_schedules/:id`: each field sent replaces the
 * stored one; a new cadence or zone moves an active schedule to its first
 * occurrence after now.
 */
export async function updateReportScheduleCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateReportScheduleParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await scheduleOf(req, res, merchant);
  if (!row) return;
  if (row.status === 'canceled') {
    refuseCanceled(res);
    return;
  }
  const base = scheduleInputOf(row);
  const update = parsed.data;
  const fields = await admitSchedule(res, merchant, {
    report_type: update.report_type ?? base.report_type,
    parameters: update.parameters ?? base.parameters,
    schedule: update.schedule ?? base.schedule,
    timezone: update.timezone ?? base.timezone,
    recipients: update.recipients ?? base.recipients,
    locale: update.locale ?? base.locale,
  });
  if (!fields) return;
  const moved = update.schedule !== undefined || update.timezone !== undefined;
  const updated = await updateReportSchedule(
    getDb(),
    row,
    fields,
    moved ? firstOccurrenceAfter(fields, new Date()) : null,
  );
  if (!updated) {
    sendError(
      res,
      409,
      'invalid_request_error',
      'the report schedule changed while it was being updated; read it and try again',
      'report_schedule_unexpected_state',
    );
    return;
  }
  res.status(200).json(toReportScheduleDTO(updated));
}

type ScheduleAction = 'pause' | 'resume' | 'cancel';

/**
 * `POST …/pause|resume|cancel`. Asking for the status a schedule already has
 * answers it as it is; anything the status machine refuses (resuming or
 * pausing a canceled schedule) is 409.
 */
function scheduleAction(action: ScheduleAction) {
  return async (req: Request, res: Response, merchant: MerchantRow): Promise<void> => {
    const parsed = reportScheduleActionParams.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const row = await scheduleOf(req, res, merchant);
    if (!row) return;
    const already = { pause: 'paused', resume: 'active', cancel: 'canceled' }[action];
    if (row.status === already) {
      res.status(200).json(toReportScheduleDTO(row));
      return;
    }
    if (row.status === 'canceled') {
      refuseCanceled(res);
      return;
    }
    const db = getDb();
    const moved =
      action === 'pause'
        ? await pauseReportSchedule(db, row.id)
        : action === 'resume'
          ? await resumeReportSchedule(db, row.id, firstOccurrenceAfter(row, new Date()))
          : await cancelReportSchedule(db, row.id);
    if (!moved) {
      sendError(
        res,
        409,
        'invalid_request_error',
        'the report schedule changed while this was asked; read it and try again',
        'report_schedule_unexpected_state',
      );
      return;
    }
    res.status(200).json(toReportScheduleDTO(moved));
  };
}

export const pauseReportScheduleCore = scheduleAction('pause');
export const resumeReportScheduleCore = scheduleAction('resume');
export const cancelReportScheduleCore = scheduleAction('cancel');

type Core = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;

export function createReportingRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  // A report reads what `payments:read` reads; running one writes nothing else.
  const read = [deps.requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const api = (core: Core) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await core(req, res, merchant, 'api');
    });
  router.get('/v1/reporting/report_types', ...read, api(answerReportTypeList));
  router.get('/v1/reporting/report_types/:id', ...read, api(retrieveReportType));
  router.get('/v1/reporting/report_types/:id/csv', ...read, api(downloadReport));
  router.post(
    '/v1/reporting/report_runs',
    ...read,
    idempotent,
    api((req, res, merchant) => createReportRun(req, res, merchant)),
  );
  router.get('/v1/reporting/report_runs', ...read, api(answerReportRunList));
  router.get('/v1/reporting/report_runs/:id', ...read, api(retrieveReportRun));
  // A schedule is standing configuration that mails people on the merchant's
  // behalf, so writing one takes `payments:write`; reading it, `payments:read`.
  const write = [deps.requireMerchant, requireAuthenticated, requireScope('payments:write')];
  const writeCore = (core: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>) =>
    api((req, res, merchant) => core(req, res, merchant));
  router.post(
    '/v1/reporting/report_schedules',
    ...write,
    idempotent,
    writeCore(createReportSchedule),
  );
  router.get('/v1/reporting/report_schedules', ...read, api(answerReportScheduleList));
  router.get('/v1/reporting/report_schedules/:id', ...read, api(retrieveReportSchedule));
  router.post(
    '/v1/reporting/report_schedules/:id',
    ...write,
    idempotent,
    writeCore(updateReportScheduleCore),
  );
  for (const [action, core] of [
    ['pause', pauseReportScheduleCore],
    ['resume', resumeReportScheduleCore],
    ['cancel', cancelReportScheduleCore],
  ] as const) {
    router.post(
      `/v1/reporting/report_schedules/:id/${action}`,
      ...write,
      idempotent,
      writeCore(core),
    );
  }
  return router;
}

/**
 * The same cores under Orbit's dashboard, all `read`: a run materialises the
 * same rows a download streams, so keeping one needs no more than reading it.
 */
export function mountReportingDashboardRoutes(
  router: Router,
  deps: {
    readonly base: string;
    readonly requireOxyUser: RequestHandler;
    readonly gate: DashboardGate;
  },
): void {
  const { base, requireOxyUser, gate } = deps;
  const dashboard = (core: Core) =>
    gate('read', (req, res, merchant) => core(req, res, merchant, 'dashboard'));
  router.get(`${base}/reporting/report_types`, requireOxyUser, dashboard(answerReportTypeList));
  router.get(`${base}/reporting/report_types/:id`, requireOxyUser, dashboard(retrieveReportType));
  router.get(`${base}/reporting/report_types/:id/csv`, requireOxyUser, dashboard(downloadReport));
  router.post(
    `${base}/reporting/report_runs`,
    requireOxyUser,
    requestContextMiddleware,
    gate('read', (req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => createReportRun(req, res, merchant)),
    ),
  );
  router.get(`${base}/reporting/report_runs`, requireOxyUser, dashboard(answerReportRunList));
  router.get(`${base}/reporting/report_runs/:id`, requireOxyUser, dashboard(retrieveReportRun));
  // A schedule is `configure`, not `read`: it is standing configuration of the
  // application that keeps producing runs and mails addresses outside Oxy's
  // membership in the merchant's name. Reading schedules is `read`.
  const configure = (core: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>) =>
    gate('configure', (req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => core(req, res, merchant)),
    );
  router.post(
    `${base}/reporting/report_schedules`,
    requireOxyUser,
    requestContextMiddleware,
    configure(createReportSchedule),
  );
  router.get(
    `${base}/reporting/report_schedules`,
    requireOxyUser,
    dashboard(answerReportScheduleList),
  );
  router.get(
    `${base}/reporting/report_schedules/:id`,
    requireOxyUser,
    dashboard(retrieveReportSchedule),
  );
  router.post(
    `${base}/reporting/report_schedules/:id`,
    requireOxyUser,
    requestContextMiddleware,
    configure(updateReportScheduleCore),
  );
  for (const [action, core] of [
    ['pause', pauseReportScheduleCore],
    ['resume', resumeReportScheduleCore],
    ['cancel', cancelReportScheduleCore],
  ] as const) {
    router.post(
      `${base}/reporting/report_schedules/:id/${action}`,
      requireOxyUser,
      requestContextMiddleware,
      configure(core),
    );
  }
}
