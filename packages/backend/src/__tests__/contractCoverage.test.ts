/**
 * The contracts and the mounted gateway are the SAME set of routes (ADR 0014
 * D5).
 *
 * Every public route Express serves has a `RouteContract` in
 * `@peable.to/contracts` (so it is validated with the contract's schemas, in
 * the OpenAPI document and in the SDK), and every contract names a route that
 * is actually mounted. The dashboard's routes (`/v1/dashboard/…`) are Orbit's
 * private surface and are not contracts; neither are the infrastructure
 * routes below.
 */
import { afterAll, expect, test } from 'bun:test';
import { expressPath, routes } from '@peable.to/contracts';
import { createGateway } from '../server';

/** Mounted, deliberately not public API: probes, the document itself, inbound provider webhooks. */
const INFRASTRUCTURE = new Set([
  'GET /health',
  'GET /ready',
  'GET /openapi.json',
  'POST /v1/webhooks/stripe',
  'POST /v1/webhooks/stripe/connect',
  'POST /v1/webhooks/oxy/files',
]);

/**
 * TRANSITIONAL: mounted public routes whose contract is still being written,
 * by group. Each list only ever shrinks, and the test fails on a stale entry,
 * so a route leaves this list in the change that contracts it. Empty at 1.0.
 */
const PENDING: Record<string, readonly string[]> = {
  payments: [
    'GET /v1/payment_intents/search',
    'GET /v1/charges/search',
    'GET /v1/refunds/search',
    'POST /v1/payment_intents',
    'GET /v1/payment_intents',
    'GET /v1/payment_intents/:id',
    'POST /v1/payment_intents/:id',
    'POST /v1/payment_intents/:id/client_action',
    'POST /v1/payment_intents/:id/confirm',
    'POST /v1/payment_intents/:id/capture',
    'POST /v1/payment_intents/:id/cancel',
    'POST /v1/payment_intents/:id/submit_tx',
    'POST /v1/social/:username/next_address',
    'GET /v1/social/me/cursor',
    'GET /v1/social/me/payments',
    'POST /v1/enrich',
    'POST /v1/refunds',
    'GET /v1/refunds',
    'GET /v1/refunds/:id',
    'POST /v1/refunds/:id',
    'POST /v1/refunds/:id/cancel',
    'GET /v1/payment_intents/:intentId/refunds',
    'GET /v1/payment_intents/:intentId/settlement',
    'GET /v1/charges',
    'GET /v1/charges/:id',
    'POST /v1/setup_intents',
    'GET /v1/setup_intents',
    'GET /v1/setup_intents/:id',
    'POST /v1/setup_intents/:id/cancel',
    'POST /v1/setup_intents/:id/client_action',
    'GET /v1/payment_intents/:intentId/disputes',
    'GET /v1/disputes',
    'GET /v1/disputes/:disputeId',
    'POST /v1/disputes/:disputeId',
    'POST /v1/disputes/:disputeId/close',
    'POST /v1/test_helpers/payment_intents/:id/simulate_faircoin_payment',
  ],
  catalog: [
    'GET /v1/products/search',
    'GET /v1/prices/search',
    'POST /v1/products',
    'GET /v1/products',
    'GET /v1/products/:id',
    'POST /v1/products/:id',
    'DELETE /v1/products/:id',
    'POST /v1/prices',
    'GET /v1/prices',
    'GET /v1/prices/:id',
    'POST /v1/prices/:id',
    'POST /v1/coupons',
    'GET /v1/coupons',
    'GET /v1/coupons/:id',
    'POST /v1/coupons/:id',
    'DELETE /v1/coupons/:id',
    'POST /v1/promotion_codes',
    'GET /v1/promotion_codes',
    'GET /v1/promotion_codes/:id',
    'POST /v1/promotion_codes/:id',
    'POST /v1/test_helpers/test_clocks',
    'GET /v1/test_helpers/test_clocks',
    'GET /v1/test_helpers/test_clocks/:id',
    'POST /v1/test_helpers/test_clocks/:id/advance',
    'DELETE /v1/test_helpers/test_clocks/:id',
    'GET /v1/billing_settings',
    'POST /v1/billing_settings',
    'POST /v1/billing/meters',
    'GET /v1/billing/meters',
    'GET /v1/billing/meters/:id',
    'POST /v1/billing/meters/:id',
    'POST /v1/billing/meters/:id/deactivate',
    'POST /v1/billing/meters/:id/reactivate',
    'GET /v1/billing/meters/:id/event_summaries',
    'POST /v1/billing/meter_events',
    'POST /v1/entitlements/features',
    'GET /v1/entitlements/features',
    'GET /v1/entitlements/features/:id',
    'POST /v1/entitlements/features/:id',
    'POST /v1/products/:id/features',
    'GET /v1/products/:id/features',
    'DELETE /v1/products/:id/features/:feature',
    'GET /v1/entitlements/active_entitlements',
    'GET /v1/billing/rails',
    'POST /v1/billing/tax_quotes',
    'POST /v1/billing/customers',
    'POST /v1/billing/checkout_sessions',
    'GET /v1/billing/embedded_checkout_configuration',
    'POST /v1/billing/embedded_checkout_sessions',
    'GET /v1/billing/embedded_checkout_sessions/:id/client_action',
    'POST /v1/billing/portal_sessions',
    'GET /v1/billing/checkout_operations/:key',
    'GET /v1/billing/checkout_sessions/:id',
    'GET /v1/billing/subscriptions/:id/invoice_authorities/:invoiceId',
    'GET /v1/billing/subscriptions/:id/invoice_states/:invoiceId',
    'GET /v1/billing/subscriptions/:id/paid_invoices/:invoiceId',
    'GET /v1/billing/subscriptions/:id',
    'POST /v1/billing/subscriptions/:id/renew',
    'POST /v1/billing/subscriptions/:id/cancel_at_period_end',
  ],
  checkout: [
    'POST /v1/merchants',
    'GET /v1/merchants/me',
    'POST /v1/merchants/me',
    'POST /v1/files',
    'GET /v1/files',
    'GET /v1/files/:id',
    'GET /v1/files/:id/contents',
    'GET /v1/payment_method_configurations',
    'POST /v1/payment_method_configurations',
    'GET /v1/payment_method_configurations/:id',
    'POST /v1/payment_method_configurations/:id',
    'GET /v1/payment_method_domains',
    'POST /v1/payment_method_domains',
    'GET /v1/payment_method_domains/:id',
    'POST /v1/payment_method_domains/:id',
    'POST /v1/payment_method_domains/:id/validate',
    'POST /v1/test_helpers/checkout_sessions/:id/expire',
    'POST /v1/organizations/:organizationId/applications/:applicationId/contributions',
    'GET /v1/organizations/:organizationId/applications/:applicationId/contributions',
    'POST /v1/organizations/:organizationId/applications/:applicationId/contributions/:id',
    'GET /v1/organizations/:organizationId/applications/:applicationId/contributions/:id/collections',
    'POST /v1/payment_links',
    'GET /v1/payment_links',
    'GET /v1/payment_links/:id',
    'POST /v1/payment_links/:id',
    'GET /v1/payment_links/:id/line_items',
    'GET /v1/payment_links/:id/public',
    'POST /v1/payment_links/:id/checkout_sessions',
    'POST /v1/checkout_sessions',
    'GET /v1/checkout_sessions',
    'GET /v1/checkout_sessions/:id',
    'POST /v1/checkout_sessions/:id',
    'POST /v1/checkout_sessions/:id/expire',
    'GET /v1/checkout_sessions/:id/line_items',
    'GET /v1/checkout_sessions/:id/public',
    'POST /v1/checkout_sessions/:id/public',
    'POST /v1/checkout_sessions/:id/public/confirm',
    'GET /v1/merchants/me/branding',
    'POST /v1/merchants/me/branding',
    'GET /v1/merchants/me/email_settings',
    'POST /v1/merchants/me/email_settings',
  ],
  events: [
    'GET /v1/webhook_deliveries',
    'POST /v1/webhook_deliveries/:id/redeliver',
    'POST /v1/webhook_endpoints',
    'GET /v1/webhook_endpoints',
    'GET /v1/webhook_endpoints/:id',
    'POST /v1/webhook_endpoints/:id',
    'DELETE /v1/webhook_endpoints/:id',
    'POST /v1/webhook_endpoints/:id/roll_secret',
    'POST /v1/webhook_endpoints/:id/test',
    'GET /v1/events',
    'GET /v1/events/stream',
    'GET /v1/events/:id',
  ],
};

const gateway = createGateway();

afterAll(() => {
  gateway.io.close();
});

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
}

function mounted(): Set<string> {
  const found = new Set<string>();
  const walk = (stack: readonly Layer[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods))
          found.add(`${method.toUpperCase()} ${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  const app = gateway.app as unknown as { _router: { stack: Layer[] } };
  walk(app._router.stack);
  return found;
}

const contracted = new Set(
  routes.map((route) => `${route.method.toUpperCase()} ${expressPath(route.path)}`),
);

test('every contract names a mounted route', () => {
  const served = mounted();
  expect([...contracted].filter((key) => !served.has(key))).toEqual([]);
});

test('every mounted public route has a contract (or is pending, by name)', () => {
  const pending = new Set(Object.values(PENDING).flat());
  const uncontracted = [...mounted()].filter(
    (key) => !INFRASTRUCTURE.has(key) && !key.includes(' /v1/dashboard/') && !contracted.has(key),
  );
  expect(uncontracted.filter((key) => !pending.has(key))).toEqual([]);
  // A pending entry that now has a contract (or no longer exists) is stale.
  expect([...pending].filter((key) => !uncontracted.includes(key))).toEqual([]);
});

test('no two contracts declare the same operation', () => {
  const ids = routes.map((route) => route.operationId);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
});
