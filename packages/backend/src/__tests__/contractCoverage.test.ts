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
  payments: [],
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
  billingEngine: [
    'GET /v1/subscriptions/search',
    'GET /v1/invoices/search',
    'POST /v1/subscriptions',
    'GET /v1/subscriptions',
    'GET /v1/subscriptions/:id',
    'POST /v1/subscriptions/:id',
    'DELETE /v1/subscriptions/:id',
    'POST /v1/subscriptions/:id/resume',
    'POST /v1/subscription_items',
    'GET /v1/subscription_items',
    'GET /v1/subscription_items/:id',
    'POST /v1/subscription_items/:id',
    'DELETE /v1/subscription_items/:id',
    'POST /v1/invoices',
    'GET /v1/invoices',
    'GET /v1/invoices/upcoming',
    'GET /v1/invoices/:id',
    'POST /v1/invoices/:id',
    'DELETE /v1/invoices/:id',
    'POST /v1/invoices/:id/finalize',
    'POST /v1/invoices/:id/pay',
    'POST /v1/invoices/:id/send',
    'POST /v1/invoices/:id/void',
    'POST /v1/invoices/:id/mark_uncollectible',
    'GET /v1/invoices/:id/lines',
    'GET /v1/invoices/:id/pdf',
    'POST /v1/invoiceitems',
    'GET /v1/invoiceitems',
    'GET /v1/invoiceitems/:id',
    'POST /v1/invoiceitems/:id',
    'DELETE /v1/invoiceitems/:id',
    'POST /v1/credit_notes',
    'GET /v1/credit_notes',
    'GET /v1/credit_notes/preview',
    'GET /v1/credit_notes/:id',
    'POST /v1/credit_notes/:id/void',
    'POST /v1/customers/:id/balance_transactions',
    'GET /v1/customers/:id/balance_transactions',
    'GET /v1/customers/:id/balance_transactions/:transaction',
    'POST /v1/billing_portal/configurations',
    'GET /v1/billing_portal/configurations',
    'GET /v1/billing_portal/configurations/:id',
    'POST /v1/billing_portal/configurations/:id',
    'POST /v1/billing_portal/sessions',
    'GET /v1/invoices/public/:token',
    'POST /v1/invoices/public/:token/pay',
    'GET /v1/invoices/public/:token/pdf',
    'GET /v1/billing_portal/public/:token',
    'POST /v1/billing_portal/public/:token/cancel',
    'POST /v1/billing_portal/public/:token/renew',
    'POST /v1/billing_portal/public/:token/change_plan',
    'POST /v1/billing_portal/public/:token/customer',
    'POST /v1/billing_portal/public/:token/payment_method_update',
    'POST /v1/billing_portal/public/:token/payment_method_update/complete',
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
  connect: [
    'POST /v1/connected_accounts',
    'GET /v1/connected_accounts',
    'GET /v1/connected_accounts/by_ref/:externalRef',
    'GET /v1/connected_accounts/:accountId',
    'POST /v1/connected_accounts/:accountId/refresh',
    'POST /v1/connected_accounts/:accountId/account_links',
    'GET /v1/account',
    'POST /v1/account',
    'POST /v1/account_links',
    'GET /v1/balance',
    'GET /v1/balance_transactions',
    'GET /v1/balance_transactions/:id',
    'GET /v1/payouts',
    'POST /v1/payouts',
    'GET /v1/payouts/:id',
    'POST /v1/payouts/:id/cancel',
    'GET /v1/reports/payout_reconciliation',
    'GET /v1/application_fees',
    'GET /v1/application_fees/:id',
    'GET /v1/application_fees/:id/refunds',
    'GET /v1/connect/onboarding/:token',
    'POST /v1/connect/onboarding/:token/faircoin',
    'POST /v1/transfers',
    'POST /v1/transfers/:transferId/reversals',
    'GET /v1/transfers/:transferId/reversals',
    'GET /v1/transfers',
    'GET /v1/transfers/:transferId',
    'GET /v1/payment_intents/:intentId/transfers',
    'GET /v1/request_logs',
    'GET /v1/request_logs/stream',
    'GET /v1/request_logs/:id',
    'GET /v1/reporting/report_types',
    'GET /v1/reporting/report_types/:id',
    'GET /v1/reporting/report_types/:id/csv',
    'POST /v1/reporting/report_runs',
    'GET /v1/reporting/report_runs',
    'GET /v1/reporting/report_runs/:id',
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
  tax: [
    'GET /v1/tax/codes',
    'GET /v1/tax/settings',
    'GET /v1/tax/registrations',
    'GET /v1/tax/products',
    'PUT /v1/tax/products/:productRef',
    'POST /v1/tax/location_evidence',
    'GET /v1/tax/location_evidence/:id',
    'POST /v1/tax/calculations',
    'GET /v1/tax/calculations/:id',
    'GET /v1/tax/transactions',
    'POST /v1/tax/transactions/:id/reversals',
    'GET /v1/tax/reports/summary',
    'GET /v1/tax/business_profile',
    'GET /v1/tax/operating_locations',
    'GET /v1/tax/operating_locations/:id',
    'GET /v1/tax/sales_destinations',
    'GET /v1/tax/sales_destinations/:id',
    'GET /v1/tax/registration_declarations',
    'GET /v1/tax/registration_declarations/:id',
    'GET /v1/tax/documents',
    'GET /v1/tax/documents/:id',
    'GET /v1/tax/document_checklist',
    'GET /v1/tax/rule_set',
    'GET /v1/tax/capabilities',
    'GET /v1/tax/deadlines',
    'GET /v1/tax/assessments',
    'POST /v1/tax/assessments',
    'GET /v1/tax/assessments/:id',
    'GET /v1/tax/assessments/:id/replay',
    'GET /v1/tax/review_items',
    'GET /v1/tax/review_items/:id',
    'GET /v1/tax/compliance_actions',
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
