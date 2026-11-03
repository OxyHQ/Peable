import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { CatalogError } from '../services/catalog/catalogService';
import { CheckoutError, sendCheckoutError } from '../services/checkout/errors';
import { requireAuthenticated, sendError, wrap } from '../lib/http';
import { requestIdOf } from '../lib/requestId';
import { requireScope } from '../lib/scope';
import { BillingEngineError } from '../services/billingEngine/errors';
import { StaleTransitionError } from '../services/billingEngine/transitions';
import { idempotent } from '../lib/idempotency';
import type { QuerySurface } from '../lib/list';
import { requestContextMiddleware } from '../lib/requestContext';
import { resolveMerchant } from './paymentIntents';

/**
 * The catalog's routes (ADR 0018) as DATA: each resource file lists its
 * routes once, as cores taking the merchant, and this module mounts that list
 * twice — on the service-authed `/v1/<resource>` surface and on Orbit's
 * `/v1/dashboard/applications/:applicationId/<resource>` — so the two can
 * never validate, write or answer differently.
 */

export type CatalogCore = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;

export interface CatalogRoute {
  readonly method: 'get' | 'post' | 'delete';
  /** Relative to `/v1` (service) or the dashboard base: `/products/:id`. */
  readonly path: string;
  readonly core: CatalogCore;
}

/**
 * The ADR 0014 answer for a {@link CatalogError} or a billing engine refusal
 * ({@link BillingEngineError}, ADR 0018); anything else is rethrown.
 */
export function sendCatalogError(res: Response, error: unknown): void {
  // Checkout's routes (sessions, payment links, branding) ride the same mount.
  if (error instanceof CheckoutError) {
    sendCheckoutError(res, error);
    return;
  }
  if (error instanceof BillingEngineError) {
    res.status(error.status).json({
      error: {
        type: error.type,
        code: error.code,
        ...(error.param ? { param: error.param } : {}),
        message: error.message,
        ...error.extra,
        request_id: requestIdOf(res) ?? null,
      },
    });
    return;
  }
  if (error instanceof StaleTransitionError) {
    sendError(res, 409, 'invalid_request_error', error.message, 'resource_conflict');
    return;
  }
  if (!(error instanceof CatalogError)) throw error;
  sendError(res, error.status, 'invalid_request_error', error.message, error.code, error.param);
}

/** Run a core, answering a {@link CatalogError} as its envelope. */
async function run(
  core: CatalogCore,
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  try {
    await core(req, res, merchant, surface);
  } catch (error) {
    sendCatalogError(res, error);
  }
}

/**
 * Mount on the merchant API. Reads need `payments:read`; writes
 * `payments:write`, every `POST` behind the generic idempotency layer (which
 * also opens the request context an event records), every `DELETE` behind the
 * request context alone.
 */
export function createCatalogApiRouter(
  routes: readonly CatalogRoute[],
  deps: { requireMerchant: RequestHandler },
): Router {
  const router = Router();
  const auth = (scope: 'payments:read' | 'payments:write') => [
    deps.requireMerchant,
    requireAuthenticated,
    requireScope(scope),
  ];
  for (const route of routes) {
    const handler = wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await run(route.core, req, res, merchant, 'api');
    });
    const path = `/v1${route.path}`;
    if (route.method === 'get') router.get(path, ...auth('payments:read'), handler);
    else if (route.method === 'post') {
      router.post(path, ...auth('payments:write'), idempotent, handler);
    } else router.delete(path, ...auth('payments:write'), requestContextMiddleware, handler);
  }
  return router;
}

/**
 * Mount on Orbit's dashboard router: `asMember` is the dashboard's access gate
 * (membership of the application, then its merchant in the environment);
 * every write opens the request context.
 */
export function mountCatalogDashboardRoutes(
  router: Router,
  routes: readonly CatalogRoute[],
  deps: {
    base: string;
    requireOxyUser: RequestHandler;
    asMember: (
      core: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
    ) => RequestHandler;
  },
): void {
  for (const route of routes) {
    const path = `${deps.base}${route.path}`;
    const handler = deps.asMember((req, res, merchant) =>
      run(route.core, req, res, merchant, 'dashboard'),
    );
    if (route.method === 'get') router.get(path, deps.requireOxyUser, handler);
    else if (route.method === 'post') {
      router.post(path, deps.requireOxyUser, requestContextMiddleware, handler);
    } else router.delete(path, deps.requireOxyUser, requestContextMiddleware, handler);
  }
}
