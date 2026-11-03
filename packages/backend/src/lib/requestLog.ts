import type { Request, RequestHandler, Response } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { REQUEST_LOG_METHODS, type RequestLogMethod } from '@peable.to/shared-types';
import { getDb, PostgresNotConnectedError } from '../db/postgres';
import { findMerchantByAppEnvironment, type MerchantRow } from '../db/merchants/merchantRepository';
import { insertRequestLog } from '../db/requestLogs/requestLogRepository';
import { LIVE_TAIL_CHANNELS, notifyLiveTail } from '../services/liveTail';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_PATTERN } from './idempotency';
import { requestIdOf } from './requestId';

/**
 * The request log (`api_request_logs`): one row per answered merchant API
 * request — what Orbit's Developers › Logs page lists and `peable logs tail`
 * streams.
 *
 * ## Which requests
 *
 * A request to `/v1/…` (never `/v1/dashboard/…`, which a person makes, not an
 * integration) that a SERVICE credential authenticated and whose credential
 * resolves to a merchant. That includes a request the route then refused — a
 * missing scope, a validation error, a conflict — because those are exactly the
 * requests a developer opens the log to find. It cannot include one refused
 * before authentication (no credential, a bad token): there is no merchant to
 * file it under. A stream (`lib/liveStream.ts`) opts out.
 *
 * ## What it records
 *
 * Method, path without its query string, status, duration, and the
 * `Idempotency-Key` when it was a valid one. Nothing else — see
 * `db/schema/requestLogs.ts` for why bodies, headers and query strings are
 * never kept.
 *
 * ## When
 *
 * On the response's `finish`, after the merchant has their answer, so writing
 * the log can never delay or change it; a failed write is logged and dropped.
 * A test-mode row signals the live tail on the same transaction.
 */

const METHODS: ReadonlySet<string> = new Set(REQUEST_LOG_METHODS);
const PATH_MAX = 2_048;

function loggedPath(req: Request): string | null {
  const path = req.originalUrl.split('?')[0] ?? req.path;
  if (!path.startsWith('/v1/') || path.startsWith('/v1/dashboard/')) return null;
  return path.length > PATH_MAX ? path.slice(0, PATH_MAX) : path;
}

async function merchantOf(req: Request, res: Response): Promise<MerchantRow | null> {
  const resolved: unknown = res.locals.merchant;
  if (resolved) return resolved as MerchantRow;
  const { serviceApp } = req as OxyAuthRequest;
  if (!serviceApp?.appId || !serviceApp.environment) return null;
  return findMerchantByAppEnvironment(getDb(), serviceApp.appId, serviceApp.environment);
}

async function record(req: Request, res: Response, startedAt: number): Promise<void> {
  if (res.locals.skipRequestLog === true) return;
  const requestId = requestIdOf(res);
  const path = loggedPath(req);
  if (requestId === undefined || path === null || !METHODS.has(req.method)) return;
  // Only a service-authenticated request is an integration's: the payer and
  // Oxy-user routes under `/v1` carry no `serviceApp`.
  if (!(req as OxyAuthRequest).serviceApp) return;
  const merchant = await merchantOf(req, res);
  if (!merchant) return;

  const key = req.header(IDEMPOTENCY_KEY_HEADER);
  const params = {
    requestId,
    merchantId: merchant.id,
    method: req.method as RequestLogMethod,
    path,
    status: res.statusCode,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    idempotencyKey: key !== undefined && IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null,
  };
  const db = getDb();
  if (merchant.livemode) {
    await insertRequestLog(db, params);
    return;
  }
  await db.transaction(async (tx) => {
    const id = await insertRequestLog(tx, params);
    if (id !== null) await notifyLiveTail(tx, LIVE_TAIL_CHANNELS.requestLogs, merchant.id, id);
  });
}

/** Writes started and not yet settled — what {@link flushRequestLogs} waits for. */
const pending = new Set<Promise<void>>();

/**
 * Wait for every request log already being written. The shutdown path calls it
 * before closing the pool, so the last requests a task answered are not lost
 * to the close; a suite calls it before emptying the tables.
 */
export async function flushRequestLogs(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** Mounted once, before the routers. See the module comment. */
export const requestLogMiddleware: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  res.on('finish', () => {
    const write = record(req, res, startedAt)
      .catch((error: unknown) => {
        // A gateway assembled without a database (a unit suite) has no log.
        if (error instanceof PostgresNotConnectedError) return;
        console.error(
          `[${requestIdOf(res) ?? 'no-request-id'}] request log: could not record ${req.method} ${req.path}`,
          error,
        );
      })
      .finally(() => {
        pending.delete(write);
      });
    pending.add(write);
  });
  next();
};
