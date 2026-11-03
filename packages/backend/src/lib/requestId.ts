import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { newId } from './ids';

/**
 * Every response carries a `Request-Id` (ADR 0014 D1).
 *
 * It is the one identifier a merchant can quote to support that names THIS
 * request — a payment id names an object that many requests touched. Minted
 * here, never taken from the caller: an inbound id would let anyone choose the
 * key our logs are searched by.
 *
 * Mounted first in `createGateway`, so a request refused by CORS, the rate
 * limiter or a provider-webhook signature still has one.
 */
export const REQUEST_ID_HEADER = 'Request-Id';

export const requestIdMiddleware: RequestHandler = (_req, res, next) => {
  const id = newId('req');
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};

/** The request id assigned by `requestIdMiddleware`, if it ran. */
export function requestIdOf(res: Response): string | undefined {
  const id: unknown = res.locals.requestId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The last-resort handler: an error nobody mapped.
 *
 * The body never carries `err.message`. An unmapped error is by definition one
 * no route decided to explain, and its text is written for us — a driver
 * message can quote SQL, a column, a constraint name or a provider's response.
 * The request id is what joins the generic answer to the logged cause.
 */
export function createInternalErrorHandler(
  log: (requestId: string | undefined, req: Request, err: unknown) => void = defaultLog,
): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = requestIdOf(res);
    log(requestId, req, err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({
      error: {
        type: 'api_error',
        message: requestId
          ? `An unexpected error occurred. Quote request ${requestId} to support.`
          : 'An unexpected error occurred.',
      },
    });
  };
}

function defaultLog(requestId: string | undefined, req: Request, err: unknown): void {
  console.error(`[${requestId ?? 'no-request-id'}] ${req.method} ${req.path} failed`, err);
}
