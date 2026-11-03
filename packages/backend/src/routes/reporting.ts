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
 *   `result` File once it succeeded (`GET /v1/files/:id/contents` reads it).
 *
 * Every handler is a CORE `(req, res, merchant, surface)` shared with Orbit's
 * dashboard (`mountReportingDashboardRoutes`), as the money surface is.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
import {
  CURRENCY_CODES,
  REPORT_TYPE_IDS,
  REPORT_TYPE_LAYOUTS,
  type ReportType,
  type ReportTypeId,
} from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findFilesByIds } from '../db/files/fileRepository';
import { earliestReportData } from '../db/reporting/reportData';
import {
  findReportRunForMerchant,
  insertReportRun,
  listReportRunsForMerchant,
  type ReportRunRow,
} from '../db/reporting/reportRunRepository';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { idempotent, runIdempotent } from '../lib/idempotency';
import { newId } from '../lib/ids';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  completeList,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { sendMoneyRefusal } from '../lib/moneyHttp';
import { toReportRunDTO } from '../lib/serializeReporting';
import { toUnix } from '../lib/time';
import { requestContextMiddleware } from '../lib/requestContext';
import { AccountMissingError } from '../services/accounts/merchantAccount';
import { ledgerScopeForReport } from '../services/reporting/reports';
import { kickReportRunWorker } from '../services/reporting/reportRunWorker';
import { resolveMerchant } from './paymentIntents';

/** When the current layouts (`.1`) were defined — `ReportType.updated`. */
const LAYOUTS_UPDATED = Date.UTC(2026, 10, 3) / 1000;

const unixSeconds = z.number().int().nonnegative();

const createBodySchema = z
  .object({
    report_type: z.enum(REPORT_TYPE_IDS),
    parameters: z
      .object({
        interval_start: unixSeconds,
        interval_end: unixSeconds,
        columns: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
        currency: z.enum(CURRENCY_CODES).optional(),
      })
      .strict(),
  })
  .strict();

const listRunsQuery = surfaceListQuery({ report_type: z.enum(REPORT_TYPE_IDS).optional() });
const retrieveQuery = surfaceRetrieveQuery();
const reportTypesQuery = {
  api: z.object({}).strict(),
  dashboard: z.object({ environment: z.enum(OXY_SERVICE_ENVIRONMENTS) }).strict(),
} as const;

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
    'payouts.itemized.1': earliest.payouts,
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

/** `POST /v1/reporting/report_runs`. */
export async function createReportRun(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { report_type: reportType, parameters } = parsed.data;
  const refuse = (message: string, param: string) =>
    sendError(res, 400, 'invalid_request_error', message, 'parameter_invalid', param);
  if (parameters.interval_start >= parameters.interval_end) {
    refuse('interval_end must be after interval_start', 'parameters[interval_end]');
    return;
  }
  if (parameters.interval_end > Math.floor(Date.now() / 1000)) {
    refuse(
      'interval_end is in the future; a report covers time that has passed',
      'parameters[interval_end]',
    );
    return;
  }
  const layout = REPORT_TYPE_LAYOUTS[reportType];
  if (parameters.columns !== undefined) {
    const unknown = parameters.columns.find((column) => !layout.columns.includes(column));
    if (unknown !== undefined) {
      refuse(
        `${reportType} has no column '${unknown}'; it has ${layout.columns.join(', ')}`,
        'parameters[columns]',
      );
      return;
    }
    if (new Set(parameters.columns).size !== parameters.columns.length) {
      refuse('a column is named twice', 'parameters[columns]');
      return;
    }
  }
  if (layout.ledger && (await ledgerScopeForReport(merchant)) === null) {
    sendMoneyRefusal(res, new AccountMissingError());
    return;
  }
  const row = await insertReportRun(getDb(), {
    publicId: newId('frr'),
    merchantId: merchant.id,
    reportType,
    intervalStart: new Date(parameters.interval_start * 1000),
    intervalEnd: new Date(parameters.interval_end * 1000),
    columns: parameters.columns ?? null,
    currency: parameters.currency ?? null,
  });
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
        page,
      });
      // Serialized here, in one read of `files`, not one per run.
      return { data: await serializeRuns(merchant.id, result.data), hasMore: result.hasMore };
    },
    serialize: (dto) => dto,
  });
}

type Core = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;

export function createReportingRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  // A report reads what `payments:read` reads; running one writes nothing else.
  const read = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const api = (core: Core) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await core(req, res, merchant, 'api');
    });
  router.get('/v1/reporting/report_types', ...read, api(answerReportTypeList));
  router.get('/v1/reporting/report_types/:id', ...read, api(retrieveReportType));
  router.post(
    '/v1/reporting/report_runs',
    ...read,
    idempotent,
    api((req, res, merchant) => createReportRun(req, res, merchant)),
  );
  router.get('/v1/reporting/report_runs', ...read, api(answerReportRunList));
  router.get('/v1/reporting/report_runs/:id', ...read, api(retrieveReportRun));
  return router;
}

/** The same cores under Orbit's dashboard, behind its membership gate. */
export function mountReportingDashboardRoutes(
  router: Router,
  deps: {
    readonly base: string;
    readonly requireOxyUser: RequestHandler;
    readonly asMember: (
      core: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
    ) => RequestHandler;
  },
): void {
  const { base, requireOxyUser, asMember } = deps;
  const dashboard = (core: Core) =>
    asMember((req, res, merchant) => core(req, res, merchant, 'dashboard'));
  router.get(`${base}/reporting/report_types`, requireOxyUser, dashboard(answerReportTypeList));
  router.get(`${base}/reporting/report_types/:id`, requireOxyUser, dashboard(retrieveReportType));
  router.post(
    `${base}/reporting/report_runs`,
    requireOxyUser,
    requestContextMiddleware,
    asMember((req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => createReportRun(req, res, merchant)),
    ),
  );
  router.get(`${base}/reporting/report_runs`, requireOxyUser, dashboard(answerReportRunList));
  router.get(`${base}/reporting/report_runs/:id`, requireOxyUser, dashboard(retrieveReportRun));
}
