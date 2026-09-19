import type { NextFunction, Request, Response, RequestHandler } from "express";
import type { OxyAuthRequest, OxyServiceEnvironment } from "@oxy.so/core/server";
import type { MerchantEnvironment } from "@peable.to/shared-types";
import {
  EnvironmentModeMismatchError,
  assertEnvironmentMatchesProvider,
} from "../services/providers/environmentGuard";
import { ProviderError } from "../services/providers/provider";
import { redactProviderMessage } from "../services/providers/redact";

/**
 * Turn a provider failure into an HTTP answer without leaking its text raw.
 *
 * **502 for a retryable provider fault, 422 for a permanent refusal.** The
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
    error.retryable ? 502 : 422,
    error.retryable ? "api_error" : "invalid_request_error",
    redactProviderMessage(error.message),
  );
}

/** Stripe-ish error envelope: `{ error: { type, message } }`. */
export function sendError(
  res: Response,
  status: number,
  type: string,
  message: string,
): void {
  res.status(status).json({ error: { type, message } });
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
}

/**
 * Extract the authenticated service app's identity + environment from
 * `req.serviceApp` (populated by `oxyClient.serviceAuth()` or the optional
 * variant). Returns null AND writes a 401 when absent, so callers just
 * `if (!serviceApp) return`.
 */
export function requireServiceApp(req: Request, res: Response): ResolvedServiceApp | null {
  const { serviceApp } = req as OxyAuthRequest;
  if (!serviceApp?.appId || !serviceApp.environment) {
    sendError(res, 401, "authentication_error", "missing service app credentials");
    return null;
  }
  return { appId: serviceApp.appId, environment: serviceApp.environment };
}

/**
 * Merchant-route auth gate, shared by every scope-checked merchant-privileged
 * route (`merchants.ts`, `paymentIntents.ts`, `webhookDeliveries.ts`).
 * `oxyClient.requireScope()` answers 403 SERVICE_TOKEN_REQUIRED when
 * `req.serviceApp` is missing entirely, not 401 — gate on serviceApp
 * presence FIRST so a fully unauthenticated caller gets 401 like every other
 * route in this gateway, and requireScope's 403 is reserved for
 * "authenticated but missing the required scope".
 */
export const requireAuthenticated: RequestHandler = (req, res, next) => {
  if (!requireServiceApp(req, res)) return;
  next();
};

/**
 * Gate a money-moving route on the credential's mode, before it reads anything.
 *
 * The service layer checks this too, and that is defence in depth rather than
 * duplication — but the SERVICE is reached after the route has already resolved
 * the payment, the seller and the merchant's own refund history, and each of
 * those lookups answers 404 or 422 on its own. A wrong-mode credential could
 * therefore enumerate which `pi_…`, `ca_…` and `externalRef` values exist by
 * reading which refusal came back, without ever reaching the guard.
 *
 * Returns `false` AND writes the response, so callers read
 * `if (!requireProviderMode(...)) return;` — the same shape `resolveMerchant`
 * already uses.
 */
export function requireProviderMode(
  environment: MerchantEnvironment,
  res: Response,
): boolean {
  try {
    assertEnvironmentMatchesProvider(environment);
    return true;
  } catch (error) {
    if (error instanceof EnvironmentModeMismatchError) {
      sendEnvironmentMismatch(res, error.message);
      return false;
    }
    throw error;
  }
}

/**
 * Answer a credential that reached a deployment running the other mode.
 *
 * 403, not 422: the request is well-formed and the caller is authenticated,
 * they are simply not authorized to move money in this mode. A 422 would send
 * an integrator off editing a body that was never the problem.
 *
 * Shared because the branch appears in every route that can reach a provider,
 * and an omission is invisible — the operation succeeds, in the wrong mode.
 * `routes/__tests__/environmentIsolation.realdb.test.ts` walks the routes and
 * fails on one that answers anything else.
 */
export function sendEnvironmentMismatch(res: Response, message: string): void {
  sendError(res, 403, "permission_error", message);
}
