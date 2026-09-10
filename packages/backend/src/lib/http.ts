import type { NextFunction, Request, Response, RequestHandler } from "express";
import type { OxyAuthRequest, OxyServiceEnvironment } from "@oxy.so/core/server";

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
