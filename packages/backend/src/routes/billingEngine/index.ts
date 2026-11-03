import type { RequestHandler, Router } from 'express';
import { type CatalogRoute, createCatalogApiRouter } from '../catalogRoutes';
import { INVOICE_ROUTES } from './invoices';
import { PLATFORM_ROUTES } from './platform';
import { PORTAL_ROUTES } from './portal';
import { SUBSCRIPTION_ROUTES } from './subscriptions';

/**
 * Every route of the native billing engine (ADR 0018), as data: mounted once
 * on the merchant API (`/v1/…`) and once on Orbit's dashboard
 * (`routes/dashboard.ts`), so the two cannot validate, write or answer
 * differently. Beside — never instead of — the Stripe-Billing proxy's
 * `/v1/billing/*` routes, whose paths these do not collide with
 * (`/v1/billing/meters` and `/v1/billing/meter_events` are new names there).
 */
export const BILLING_ENGINE_ROUTES: readonly CatalogRoute[] = [
  ...SUBSCRIPTION_ROUTES,
  ...INVOICE_ROUTES,
  ...PLATFORM_ROUTES,
  ...PORTAL_ROUTES,
];

export function createBillingEngineRouter(deps: { requireMerchant: RequestHandler }): Router {
  return createCatalogApiRouter(BILLING_ENGINE_ROUTES, deps);
}

export { createPublicBillingRouter } from './public';

export { DASHBOARD_CUSTOMER_ROUTES } from './dashboardCustomers';
