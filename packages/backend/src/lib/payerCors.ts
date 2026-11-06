/**
 * CORS for the PAYER routes: any origin, never credentials.
 *
 * A payer route's authority is the capability it is called with — the
 * order's `client_secret` in `X-Peable-Client-Secret`, or the unguessable
 * token in its path — never the page it is called from. A merchant's own site
 * (any origin, not only Oxy's) runs Pay with Peable in its payer's browser, so
 * those routes answer `Access-Control-Allow-Origin: *` (Stripe's posture for
 * its publishable-key API). `*` is exactly "no credentials": a browser sends
 * no cookie with it and the gateway sets none.
 *
 * Every other route keeps the Oxy CORS (`createOxyCors`): Oxy origins only.
 *
 * ## What makes a request a payer request
 *
 *  - its (method, path) resolves to a payer route of the CONTRACTS: every
 *    `auth: 'public'` route, plus the four dual-auth reads a payer makes with
 *    the intent's own client secret ({@link PAYER_OPERATIONS}) — the
 *    contracts are the route list, so a new public route is covered by
 *    declaring it, and a merchant route can never be by accident;
 *  - it carries NO `Authorization` (a preflight that asks for one is not a
 *    payer's). The dual-auth routes also serve the merchant's service token;
 *    a browser holding one on a foreign origin falls through to the Oxy CORS
 *    and is refused, as before. The payer allow-list never names
 *    `Authorization`, so a foreign page cannot send one through it either.
 *
 * Rate limits are unchanged: CORS only decides whether a browser may READ the
 * answer, and every payer route still passes its limiter.
 */
import { expressPath, routeOf, routes, type AnyRoute } from '@peable.to/contracts';
import type { Request, RequestHandler } from 'express';
import { IDEMPOTENT_REPLAYED_HEADER } from './idempotency';
import { REQUEST_ID_HEADER } from './requestId';

/**
 * The dual-auth routes a payer calls with the intent's `client_secret` (the
 * browser SDK's `getPaymentIntent` / `getClientAction` and the SetupIntent
 * pair). `routeOf` throws on an unknown id, so a rename fails at load.
 */
export const PAYER_OPERATIONS = [
  'retrievePaymentIntent',
  'retrievePaymentIntentClientAction',
  'retrieveSetupIntent',
  'retrieveSetupIntentClientAction',
] as const;

/** The headers a payer's browser sends — never `Authorization`. */
export const PAYER_ALLOWED_HEADERS = [
  'Content-Type',
  'Idempotency-Key',
  'X-Peable-Client-Secret',
  'Peable-Version',
] as const;

const PAYER_METHODS = 'GET, POST, OPTIONS';
const MAX_AGE_SECONDS = 600;

interface CompiledRoute {
  readonly route: AnyRoute;
  readonly method: string;
  readonly pattern: RegExp;
  /** Path parameters: a literal segment is more specific than a parameter. */
  readonly params: number;
}

function compile(route: AnyRoute): CompiledRoute {
  const source = expressPath(route.path)
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return {
    route,
    method: route.method.toUpperCase(),
    pattern: new RegExp(`^${source}/?$`),
    params: (route.path.match(/\{[^}]+\}/g) ?? []).length,
  };
}

const COMPILED: readonly CompiledRoute[] = routes.map(compile);
const PAYER: ReadonlySet<AnyRoute> = new Set<AnyRoute>([
  ...routes.filter((route) => route.auth === 'public'),
  ...PAYER_OPERATIONS.map((operationId) => routeOf(operationId) as AnyRoute),
]);

/**
 * The contract a (method, path) resolves to: the most specific match, as the
 * gateway mounts them (`/v1/payment_intents/search` before `…/:id`).
 */
export function contractFor(method: string, path: string): AnyRoute | null {
  const verb = method.toUpperCase();
  let best: CompiledRoute | null = null;
  for (const candidate of COMPILED) {
    if (candidate.method !== verb || !candidate.pattern.test(path)) continue;
    if (best === null || candidate.params < best.params) best = candidate;
  }
  return best?.route ?? null;
}

/** Whether (method, path) is a payer route. */
export function isPayerRoute(method: string, path: string): boolean {
  const route = contractFor(method, path);
  return route !== null && PAYER.has(route);
}

function asksForAuthorization(req: Request): boolean {
  const requested = req.headers['access-control-request-headers'];
  return (
    typeof requested === 'string' &&
    requested
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .includes('authorization')
  );
}

/** The payer request this is, or `null` for one the Oxy CORS answers. */
function payerRequest(req: Request): 'preflight' | 'request' | null {
  if (typeof req.headers.origin !== 'string' || req.headers.origin.length === 0) return null;
  if (req.method === 'OPTIONS') {
    const method = req.headers['access-control-request-method'];
    if (typeof method !== 'string' || asksForAuthorization(req)) return null;
    return isPayerRoute(method, req.path) ? 'preflight' : null;
  }
  if (req.headers.authorization !== undefined) return null;
  return isPayerRoute(req.method, req.path) ? 'request' : null;
}

/**
 * `oxyCors` for every route, with the payer routes answering any origin
 * without credentials.
 */
export function payerAwareCors(oxyCors: RequestHandler): RequestHandler {
  const exposed = [REQUEST_ID_HEADER, IDEMPOTENT_REPLAYED_HEADER].join(', ');
  const allowed = PAYER_ALLOWED_HEADERS.join(', ');
  return (req, res, next) => {
    const kind = payerRequest(req);
    if (kind === null) {
      oxyCors(req, res, next);
      return;
    }
    // The answer differs by whether a credential was sent; caches must keep them apart.
    res.setHeader('Vary', 'Origin, Authorization, Access-Control-Request-Headers');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', exposed);
    if (kind === 'preflight') {
      res.setHeader('Access-Control-Allow-Methods', PAYER_METHODS);
      res.setHeader('Access-Control-Allow-Headers', allowed);
      res.setHeader('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
      res.sendStatus(204);
      return;
    }
    next();
  };
}
