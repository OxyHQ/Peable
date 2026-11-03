import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import { findMerchantByAppEnvironment } from '../db/merchants/merchantRepository';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  findIdempotencyKey,
  releaseIdempotencyKey,
  type IdempotentRequest,
} from '../db/idempotency/idempotencyKeyRepository';
import { sendError } from './http';
import { requestIdOf } from './requestId';
import { runInRequestContext, setRequestIdempotencyKey } from './requestContext';

/**
 * Generic idempotency for every merchant `POST` (ADR 0014 D3).
 *
 * A merchant sends `Idempotency-Key` (optional, 1–255 printable characters).
 * For 24 hours, per merchant:
 *
 * - same key, same method + path + body → the STORED status and body, with
 *   `Idempotent-Replayed: true`, and the handler never runs;
 * - same key, a different request → 400 `idempotency_error`;
 * - same key while the first request is still running → 409 `idempotency_error`.
 *
 * A 2xx or 4xx answer is stored. A 5xx is not: the key is released so the
 * caller's retry runs the request again.
 *
 * ## Where it is mounted, and why there
 *
 * In each merchant route's chain, AFTER `requireMerchant` /
 * `requireAuthenticated` / `requireScope`. The scope is the merchant — the
 * (application, environment) the credential resolves to — so the key cannot be
 * read before the credential is; and a request refused by authentication or by
 * scope never reaches the store, so a key cannot be used to replay a response
 * to a caller who could not have made the request. A caller with no merchant
 * behind its credential passes straight through to the handler's own 403.
 *
 * `routes/__tests__/idempotencyCoverage.test.ts` walks the gateway and fails on
 * a merchant `POST` that neither mounts this nor is named as an exemption with
 * its reason.
 *
 * ## What it is not
 *
 * It does not replace business idempotency. `payment_intents (merchant_id,
 * idempotency_key)` and the `external_ref` of refunds, transfers and reversals
 * still decide whether money moves twice, for longer than 24 hours and for the
 * lease takeover below. This layer makes a retried REQUEST answer the same.
 */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** 1–255 printable ASCII characters (space through tilde), exactly as sent. */
export const IDEMPOTENCY_KEY_PATTERN = /^[ -~]{1,255}$/;

/** How many times a claim that lost to a just-released key is retried. */
const CLAIM_ATTEMPTS = 3;

/**
 * JSON with every object's keys sorted, so two bodies that differ only in key
 * order hash the same. Arrays keep their order: it is meaningful.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** Hex sha256 of the body's canonical JSON. A body-less POST hashes as `{}`. */
export function requestHashOf(body: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(body ?? {}))
    .digest('hex');
}

/**
 * The validated key of a request this layer admitted, for a route whose
 * BUSINESS idempotency is keyed by the same value (`payment_intents`,
 * `checkout_sessions`). One parser: a route reading the header itself could
 * accept a value this layer refused.
 */
export function idempotencyKeyOf(res: Response): string | undefined {
  const key: unknown = res.locals.idempotencyKey;
  return typeof key === 'string' ? key : undefined;
}

function sendIdempotencyError(res: Response, status: 400 | 409, message: string): void {
  sendError(res, status, 'invalid_request_error', message, 'idempotency_error');
}

/** Answer with what the first request answered. */
function replay(res: Response, status: number, body: unknown): void {
  res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
  // A stored answer can carry a `client_secret`; nothing in between keeps it.
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

/**
 * Hold the claim until the handler answers, then store or release it — BEFORE
 * the answer is written. Stored first, a crash between the two leaves an answer
 * the retry replays; written first, it would leave a lease the retry waits out
 * and then runs the request again.
 *
 * Every route answers through `res.json` (`sendError` and the internal error
 * handler included). A response finished any other way is not captured, so its
 * key is released rather than replayed as something it was not.
 */
function captureResponse(res: Response, claimId: string): void {
  const db = getDb();
  const sendJson = res.json.bind(res);
  let settled = false;

  res.json = ((body: unknown) => {
    if (settled) return sendJson(body);
    settled = true;
    const status = res.statusCode;
    const stored =
      status >= 500 || body === undefined
        ? releaseIdempotencyKey(db, claimId)
        : completeIdempotencyKey(db, claimId, { status, body });
    void stored
      .catch((error: unknown) => {
        // The answer still goes out: the operation happened. The claim is left
        // to its lease, and a retry after it runs the request again — which the
        // business idempotency beneath this layer is there to absorb.
        log(res, 'could not record the answer', error);
      })
      .then(() => {
        sendJson(body);
      })
      .catch((error: unknown) => {
        log(res, 'could not write the answer', error);
      });
    return res;
  }) as Response['json'];

  res.on('finish', () => {
    if (settled) return;
    settled = true;
    void releaseIdempotencyKey(db, claimId).catch((error: unknown) => {
      log(res, 'could not release the key', error);
    });
  });
}

function log(res: Response, what: string, error: unknown): void {
  console.error(`[${requestIdOf(res) ?? 'no-request-id'}] idempotency: ${what}`, error);
}

async function handle(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined) {
    next();
    return;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    sendError(
      res,
      400,
      'invalid_request_error',
      'Idempotency-Key must be 1 to 255 printable ASCII characters.',
      'idempotency_key_invalid',
    );
    return;
  }

  const { serviceApp } = req as OxyAuthRequest;
  if (!serviceApp?.appId || !serviceApp.environment) {
    next();
    return;
  }
  const db = getDb();
  const merchant = await findMerchantByAppEnvironment(db, serviceApp.appId, serviceApp.environment);
  // No merchant: the handler answers its own 403, and there is no scope to
  // store anything under.
  if (!merchant) {
    next();
    return;
  }
  // The request log reads it at the end instead of looking it up again.
  res.locals.merchant = merchant;

  const request: IdempotentRequest = {
    merchantId: merchant.id,
    key,
    method: req.method,
    path: req.originalUrl.split('?')[0] ?? req.path,
    requestHash: requestHashOf(req.body),
  };

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const claimId = await claimIdempotencyKey(db, request);
    if (claimId) {
      res.locals.idempotencyKey = key;
      setRequestIdempotencyKey(key);
      captureResponse(res, claimId);
      next();
      return;
    }

    const existing = await findIdempotencyKey(db, merchant.id, key);
    // Released (a 5xx) or expired between the claim and this read: claim again.
    if (!existing) continue;

    if (
      existing.method !== request.method ||
      existing.path !== request.path ||
      existing.requestHash !== request.requestHash
    ) {
      sendIdempotencyError(
        res,
        400,
        'Keys for idempotent requests can only be used with the same parameters they were first used with. Use a new Idempotency-Key for a different request.',
      );
      return;
    }
    if (existing.status === 'completed' && existing.responseStatus !== null) {
      replay(res, existing.responseStatus, existing.responseBody);
      return;
    }
    sendIdempotencyError(
      res,
      409,
      'A request with this Idempotency-Key is still in progress. Retry once it has finished.',
    );
    return;
  }

  // Three claims each lost to a key that vanished before it could be read: a
  // tight release/claim race with another request. Answer as in progress.
  sendIdempotencyError(
    res,
    409,
    'A request with this Idempotency-Key is still in progress. Retry once it has finished.',
  );
}

/**
 * The middleware. See the module comment.
 *
 * It also opens the request context (`lib/requestContext.ts`): every merchant
 * `POST` passes through here after authentication, so an event the handler's
 * change produces records this request's `Request-Id` and, once admitted, its
 * `Idempotency-Key` as `event.request`.
 */
export const idempotent: RequestHandler = (req, res, next) => {
  const run = () => {
    handle(req, res, next).catch(next);
  };
  const requestId = requestIdOf(res);
  if (requestId === undefined) run();
  else runInRequestContext(requestId, run);
};
