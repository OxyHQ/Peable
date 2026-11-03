/**
 * Every merchant `POST` runs the generic idempotency layer, or says why not
 * (ADR 0014 D3).
 *
 * The layer is mounted per route, after the route's own authentication — so a
 * new route that forgets it is not an error anywhere: it answers, and a
 * merchant's retry after a timeout runs it twice. This walks the REAL gateway
 * and fails on a merchant `POST` whose chain neither contains `idempotent` nor
 * is named below with its reason. It also fails on a stale exemption, so the
 * list cannot outlive the route it excuses.
 */
import { expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { createGateway } from '../../server';
import { idempotent } from '../../lib/idempotency';

/** A merchant POST that does not take the generic layer, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  'POST /v1/merchants':
    'registration CREATES the merchant the key would be scoped to; the unique (application, environment) makes a retry a 409 and GET /v1/merchants/me recovers it',
  'POST /v1/payment_intents/:id/client_action':
    'a READ behind POST only to keep a credential out of the URL: nothing happens twice, and storing it would keep the provider confirmation secret for 24 hours',
  'POST /v1/setup_intents/:id/client_action':
    'a READ behind POST, like the payment intent one: it reads the provider confirmation credential fresh and must never store it',
  'POST /v1/billing/customers':
    "billing's own leased operation ledger (billing_operations): a durable key with recovery, not a 24-hour cache",
  'POST /v1/billing/embedded_checkout_sessions':
    "billing's own leased operation ledger pins presentation and recovers the same session",
  'POST /v1/billing/checkout_sessions':
    "billing's own leased operation ledger (billing_operations): a durable key with recovery, not a 24-hour cache",
  'POST /v1/billing/portal_sessions':
    "billing's own leased operation ledger (billing_operations): a durable key with recovery, not a 24-hour cache",
  'POST /v1/billing/subscriptions/:id/renew':
    "billing's own leased operation ledger (billing_operations): a durable key with recovery, not a 24-hour cache",
  'POST /v1/billing/subscriptions/:id/cancel_at_period_end':
    "billing's own leased operation ledger (billing_operations): a durable key with recovery, not a 24-hour cache",
  'POST /v1/billing/tax_quotes':
    'a quote is a computation the billing service owns end to end; billing routes are outside the generic layer as a whole',
};

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: unknown }[];
  };
  handle?: { stack?: RouteLayer[] };
}

function postRoutes(stack: readonly RouteLayer[]): { path: string; handlers: unknown[] }[] {
  const found: { path: string; handlers: unknown[] }[] = [];
  for (const layer of stack) {
    if (layer.route) {
      if (layer.route.methods.post) {
        found.push({
          path: layer.route.path,
          handlers: layer.route.stack.map((entry) => entry.handle),
        });
      }
    } else if (layer.handle?.stack) {
      found.push(...postRoutes(layer.handle.stack));
    }
  }
  return found;
}

test('every merchant POST runs the generic idempotency layer, or is exempt with a reason', () => {
  const requireMerchant: RequestHandler = (_req, _res, next) => next();
  const optionalServiceAuth: RequestHandler = (_req, _res, next) => next();
  const gateway = createGateway({ requireMerchant, optionalServiceAuth });
  try {
    const router = (gateway.app as unknown as { _router: { stack: RouteLayer[] } })._router;
    const merchantPosts = postRoutes(router.stack).filter(
      ({ path, handlers }) =>
        path.startsWith('/v1/') &&
        (handlers.includes(requireMerchant) || handlers.includes(optionalServiceAuth)),
    );
    // Vacuity floor: a walk that found nothing would pass every assertion.
    expect(merchantPosts.length).toBeGreaterThanOrEqual(31);
    // The webhook endpoint writes are found by the walk (and so held to it):
    // a create that is retried must not mint a second endpoint and secret.
    expect(merchantPosts.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '/v1/webhook_endpoints',
        '/v1/webhook_endpoints/:id',
        '/v1/webhook_endpoints/:id/roll_secret',
        '/v1/webhook_deliveries/:id/redeliver',
        // The catalog (ADR 0018): a retried create must not mint a second
        // product, price, coupon or promotion code — or a second event.
        '/v1/products',
        '/v1/products/:id',
        '/v1/prices',
        '/v1/prices/:id',
        '/v1/coupons',
        '/v1/coupons/:id',
        '/v1/promotion_codes',
        '/v1/promotion_codes/:id',
      ]),
    );

    const missing: string[] = [];
    const staleExemptions = new Set(Object.keys(EXEMPT));
    for (const { path, handlers } of merchantPosts) {
      const name = `POST ${path}`;
      const covered = handlers.includes(idempotent);
      if (name in EXEMPT) {
        staleExemptions.delete(name);
        if (covered) missing.push(`${name} is exempt AND mounts the layer`);
        continue;
      }
      if (!covered) missing.push(name);
      // After authentication: the scope is the merchant the credential names.
      else if (handlers.indexOf(idempotent) < handlers.indexOf(requireMerchant)) {
        missing.push(`${name} runs the layer before authentication`);
      }
    }
    expect(missing).toEqual([]);
    expect([...staleExemptions]).toEqual([]);
  } finally {
    gateway.io.close();
  }
});

test('a browser may read Idempotent-Replayed and Request-Id', async () => {
  const gateway = createGateway();
  gateway.httpServer.listen(0);
  const base = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/openapi.json`, {
      headers: { Origin: 'https://checkout.peable.to' },
    });
    const exposed = (response.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase();
    expect(exposed).toContain('idempotent-replayed');
    expect(exposed).toContain('request-id');
  } finally {
    gateway.io.close();
    gateway.httpServer.close();
  }
});
