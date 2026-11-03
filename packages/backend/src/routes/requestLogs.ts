import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { REQUEST_LOG_METHODS, type RequestLogStatusFilter } from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findRequestLogByIdForMerchant,
  findRequestLogForMerchant,
  listRequestLogsForMerchant,
  requestLogMatches,
} from '../db/requestLogs/requestLogRepository';
import { serveLiveStream } from '../lib/liveStream';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { requireAuthenticated, sendError, wrap } from '../lib/http';
import { toRequestLogDTO } from '../lib/serialize';
import { LIVE_TAIL_CHANNELS } from '../services/liveTail';
import { resolveMerchant } from './paymentIntents';

/**
 * `/v1/request_logs` — the merchant's own API requests of the last 30 days
 * (`lib/requestLog.ts` writes them). Read-only. `id` is the `Request-Id`.
 */

/** `status=404` (one code) or `status=4xx` (a class). */
const statusFilter = z.union([
  z.coerce.number().int().min(100).max(599),
  z.enum(['2xx', '3xx', '4xx', '5xx']),
]) as z.ZodType<RequestLogStatusFilter, z.ZodTypeDef, unknown>;

const requestLogFilters = {
  status: statusFilter.optional(),
  method: z.enum(REQUEST_LOG_METHODS).optional(),
} as const;

const listRequestLogsQuery = surfaceListQuery(requestLogFilters);
const retrieveRequestLogQuery = surfaceRetrieveQuery();
const streamQuery = z.object(requestLogFilters).strict();

/** `GET /v1/request_logs`, newest first, filtered by `status`, `method` and `created`. */
export async function answerRequestLogList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listRequestLogsQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'request_log',
    merchantId: merchant.id,
    cursor: async (requestId) =>
      (await findRequestLogForMerchant(db, requestId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listRequestLogsForMerchant(db, {
        merchantId: merchant.id,
        page,
        status: query.status,
        method: query.method,
      }),
    serialize: toRequestLogDTO,
  });
}

/** `GET /v1/request_logs/:id` — by `Request-Id`; 404 once older than 30 days. */
export async function retrieveRequestLog(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return;
  }
  if (!parseQuery(req, res, retrieveRequestLogQuery[surface])) return;
  const row = await findRequestLogForMerchant(getDb(), id, merchant.id);
  if (!row) {
    sendError(res, 404, 'invalid_request_error', 'request log not found', 'resource_missing');
    return;
  }
  res.status(200).json(toRequestLogDTO(row));
}

/**
 * `GET /v1/request_logs/stream` — the merchant's requests as they are
 * answered, filtered by `status` / `method`. Test mode only; the wire and the
 * bounds are `lib/liveStream.ts`'s.
 */
export async function streamRequestLogs(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const query = parseQuery(req, res, streamQuery);
  if (!query) return;
  const db = getDb();
  await serveLiveStream(req, res, merchant, {
    channel: LIVE_TAIL_CHANNELS.requestLogs,
    eventName: 'request_log',
    load: (id) => findRequestLogByIdForMerchant(db, id, merchant.id),
    resolveCursor: async (requestId) =>
      (await findRequestLogForMerchant(db, requestId, merchant.id))?.id ?? null,
    after: async (internalId, limit) =>
      (
        await listRequestLogsForMerchant(db, {
          merchantId: merchant.id,
          page: { limit, before: internalId },
        })
      ).data.reverse(),
    matches: (row) => requestLogMatches(row, query),
    internalId: (row) => row.id,
    publicId: (row) => row.requestId,
    render: toRequestLogDTO,
  });
}

/** The service-authed `/v1/request_logs` router. */
export function createRequestLogsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const read = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const withMerchant = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await handler(req, res, merchant);
    });
  router.get('/v1/request_logs', ...read, withMerchant(answerRequestLogList));
  // Before `/:id`, which would otherwise read `stream` as a request id.
  router.get('/v1/request_logs/stream', ...read, withMerchant(streamRequestLogs));
  router.get('/v1/request_logs/:id', ...read, withMerchant(retrieveRequestLog));
  return router;
}
