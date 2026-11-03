import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import type { ProviderError } from '../services/providers/provider';
import { type ErrorCode, type ErrorType, errorDocUrl } from '@peable.to/contracts/vocabulary';
import { oxy } from '../oxy';
import { redactProviderMessage } from '../services/providers/redact';
import { requestIdOf } from './requestId';

/**
 * Turn a provider failure into an HTTP answer without leaking its text raw.
 *
 * **502 for a retryable provider fault, 400 for a permanent refusal.** The
 * distinction is the merchant's to act on and it is the only thing this
 * function decides: one means try again, the other means the request as sent
 * will never work. Getting it backwards tells a merchant to retry something
 * that cannot succeed, or to give up on an outage that clears in a minute.
 *
 * It lives HERE because every route that calls a provider needs exactly this
 * mapping, and four of them had written it out: `refunds`, `transfers`,
 * `connectedAccounts` and — inlined a fourth time rather than copied — the
 * evidence handler in `disputes`. Four copies of a rule about what a status
 * code means is four places to disagree about it.
 *
 * The message is always passed through `redactProviderMessage`: a provider's
 * error text is written for the integrator holding the credential, not for a
 * merchant, and it quotes back identifiers and occasionally key prefixes.
 */
export function sendProviderError(res: Response, error: ProviderError): void {
  sendError(
    res,
    error.retryable ? 502 : 400,
    error.retryable ? 'api_error' : 'invalid_request_error',
    redactProviderMessage(error.message),
  );
}

/**
 * The one error envelope (ADR 0014 D1):
 * `{ error: { type, code?, param?, message, request_id } }`.
 *
 * - `type` is the broad class a caller branches on first.
 * - `code` is the machine-readable reason, for refusals a caller must tell apart
 *   (`account_not_ready`, `idempotency_error`, …).
 * - `param` names the offending request field in bracket notation
 *   (`metadata[order_id]`, `line_items[0][price]`), when there is one.
 * - `doc_url` is the code's entry on Peable's error-code page (`ERROR_DOCS_BASE_URL`). `code` is
 *   an `ErrorCode`, the contract's closed list the errors page is rendered
 *   from, so a code without documentation does not compile.
 * - `request_id` is the `Request-Id` of this response, so support can find it.
 *
 * 422 is never used: a request that is well-formed JSON but invalid is a 400,
 * as on Stripe.
 */
export function sendError(
  res: Response,
  status: number,
  type: ErrorType,
  message: string,
  code?: ErrorCode,
  param?: string,
  extra?: { readonly decline_code?: string },
): void {
  res.status(status).json(errorBody(res, type, message, code, param, extra));
}

/** The envelope `sendError` answers with, for a caller that writes the response itself. */
export function errorBody(
  res: Response,
  type: ErrorType,
  message: string,
  code?: ErrorCode,
  param?: string,
  extra?: { readonly decline_code?: string },
) {
  return {
    error: {
      type,
      ...(code ? { code } : {}),
      ...(extra?.decline_code ? { decline_code: extra.decline_code } : {}),
      ...(param ? { param } : {}),
      message,
      ...(code ? { doc_url: errorDocUrl(code) } : {}),
      request_id: requestIdOf(res) ?? null,
    },
  };
}

/** A Zod issue path in Stripe's bracket notation: `['metadata','a']` → `metadata[a]`. */
export function paramFromPath(path: readonly PropertyKey[]): string | undefined {
  const [head, ...rest] = path.map(String);
  if (head === undefined) return undefined;
  return head + rest.map((segment) => `[${segment}]`).join('');
}

/**
 * Answer a request that failed schema validation: 400 `invalid_request_error`
 * naming the first offending field. One helper so every route reports the same
 * `param` for the same mistake.
 */
export function sendValidationError(
  res: Response,
  error: {
    issues: readonly {
      path: readonly PropertyKey[];
      message: string;
      /** Set on an `unrecognized_keys` issue: the fields the schema does not accept. */
      keys?: readonly string[];
    }[];
  },
  fallback = 'invalid request',
): void {
  const issue = error.issues[0];
  // An unknown field is named by the field itself, not by the object holding
  // it: `param` points at what the caller must remove.
  const unknownKey = issue?.keys?.[0];
  const param = issue
    ? paramFromPath(unknownKey === undefined ? issue.path : [...issue.path, unknownKey])
    : undefined;
  sendError(
    res,
    400,
    'invalid_request_error',
    issue ? issue.message : fallback,
    'parameter_invalid',
    param,
  );
}

// Express 4 does not forward rejected promises to the error handler, so wrap
// each async handler and route any rejection to `next`.
type AsyncHandler = (req: Request, res: Response) => Promise<void>;
export function wrap(handler: AsyncHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export interface ResolvedServiceApp {
  appId: string;
  environment: OxyServiceEnvironment;
  /** Verified live by the shared middleware for an own workload (Oxy ADR 0049). */
  firstParty: boolean;
}

/**
 * Extract the authenticated service app's identity + environment from
 * `req.serviceApp` (populated by `oxy.middleware.service()` or the optional
 * variant). Returns null AND writes a 401 when absent, so callers just
 * `if (!serviceApp) return`.
 */
export function requireServiceApp(req: Request, res: Response): ResolvedServiceApp | null {
  const { serviceApp } = req as OxyAuthRequest;
  if (!serviceApp?.appId || !serviceApp.environment) {
    sendError(res, 401, 'authentication_error', 'missing service app credentials');
    return null;
  }
  return {
    appId: serviceApp.appId,
    environment: serviceApp.environment,
    firstParty: serviceApp.authority === 'first_party',
  };
}

/**
 * Merchant-route auth gate, shared by every scope-checked merchant-privileged
 * route (`merchants.ts`, `paymentIntents.ts`, `webhookDeliveries.ts`).
 * `oxy.middleware.requireScope()` answers 403 SERVICE_TOKEN_REQUIRED when
 * `req.serviceApp` is missing entirely, not 401 — gate on serviceApp
 * presence FIRST so a fully unauthenticated caller gets 401 like every other
 * route in this gateway, and requireScope's 403 is reserved for
 * "authenticated but missing the required scope".
 */
export const requireAuthenticated: RequestHandler = (req, res, next) => {
  if (!requireServiceApp(req, res)) return;
  next();
};

/** The `error.type` an HTTP status carries (ADR 0014 D1). */
function errorTypeForStatus(status: number): ErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

/** Whether a body already is the ONE error envelope. */
function isErrorEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { error } = body as { error?: unknown };
  return typeof error === 'object' && error !== null;
}

function refusalMessage(body: unknown): string {
  const message =
    typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : 'the request could not be authenticated';
}

/**
 * An Oxy middleware (`oxy.middleware.service()`, `.auth()`, `.requireScope()`,
 * `createOxyAuthMiddleware(oxy)`) that refuses in the ONE error envelope
 * (ADR 0014 D1).
 *
 * The library answers its refusals in its own shape —
 * `{ error: 'INSUFFICIENT_SCOPE', message, code, status }` — which no contract
 * describes and no SDK parses: a 401 or 403 on an Orbit route is
 * `{ error: { type, message, request_id } }` like every other refusal. The
 * library's status and message are kept; its code is not an `ErrorCode` and is
 * dropped (the status and `type` are what a caller branches on).
 */
export function oxyGuard(middleware: RequestHandler, code?: ErrorCode): RequestHandler {
  return (req, res, next) => {
    const json = res.json;
    const restore = () => {
      res.json = json;
    };
    res.json = function guardedJson(body?: unknown) {
      restore();
      if (res.statusCode >= 400 && !isErrorEnvelope(body)) {
        return res.json(
          errorBody(res, errorTypeForStatus(res.statusCode), refusalMessage(body), code),
        );
      }
      return res.json(body);
    } as Response['json'];
    return middleware(req, res, (err?: unknown) => {
      restore();
      next(err);
    });
  };
}

/**
 * `oxy.middleware.requireScope(scope)`, refusing in the ONE error envelope:
 * 403 `permission_error` / `insufficient_scope`. Oxy decides (the token's
 * scopes, a delegation narrowing them, first-party authority); only the
 * refusal's spelling is Peable's. Every scope-checked route uses this — never
 * the bare Oxy middleware, whose body no contract describes.
 */
export function requireScope(scope: string): RequestHandler {
  return oxyGuard(oxy.middleware.requireScope(scope), 'insufficient_scope');
}

/**
 * The scope check of a route EITHER party may call (a merchant credential or a
 * payer's `client_secret`): run only on the merchant branch, inline. Answers
 * the 403 itself and returns `false` when the scope is missing.
 */
export function hasScope(req: Request, res: Response, scope: string): boolean {
  let granted = false;
  requireScope(scope)(req, res, () => {
    granted = true;
  });
  return granted;
}
