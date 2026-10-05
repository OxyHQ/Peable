import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { requireAuthenticated, sendError, wrap } from '../lib/http';
import { resolveMerchant } from './paymentIntents';
import { BillingError, billingIdempotencyKey, checkoutSchema, ensureCustomerSchema, portalSchema, type BillingOwner } from '../services/billing/contracts';
import type { BillingService } from '../services/billing/billingService';

/** Absent service/cohort is closed. Auth remains OxyServer middleware + registered scopes. */
export function createBillingRouter(deps: { requireMerchant: RequestHandler; service?: BillingService }): Router {
  const router = Router();
  const handle = (action: (service: BillingService, owner: BillingOwner, req: Request) => Promise<unknown>) => wrap(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const merchant = await resolveMerchant(req, res); if (!merchant) return;
    if (!deps.service) { sendError(res, 404, 'invalid_request_error', 'billing_not_enabled'); return; }
    try {
      const result = await action(deps.service, { merchantId: merchant.id, oxyAppId: merchant.oxyAppId, environment: merchant.environment }, req);
      res.json(result);
    } catch (error) {
      if (error instanceof BillingError) { sendError(res, error.status, 'invalid_request_error', error.code); return; }
      if (error instanceof z.ZodError) { sendError(res, 422, 'invalid_request_error', 'invalid_billing_request'); return; }
      // Raw provider errors can contain customer details or hosted URLs.
      sendError(res, 503, 'api_error', 'billing_provider_unavailable');
    }
  });
  const key = (req: Request) => billingIdempotencyKey.parse(req.header('Idempotency-Key'));
  const write = [deps.requireMerchant, requireAuthenticated, oxy.middleware.requireScope('payments:write')];
  const read = [deps.requireMerchant, requireAuthenticated, oxy.middleware.requireScope('payments:read')];
  router.post('/v1/billing/customers', ...write, handle((service, owner, req) => service.ensureCustomer(owner, ensureCustomerSchema.parse(req.body), key(req))));
  router.post('/v1/billing/checkout_sessions', ...write, handle((service, owner, req) => service.createCheckoutSession(owner, checkoutSchema.parse(req.body), key(req))));
  router.post('/v1/billing/portal_sessions', ...write, handle((service, owner, req) => service.createPortalSession(owner, portalSchema.parse(req.body), key(req))));
  router.get('/v1/billing/checkout_sessions/:id',...read,handle((service,owner,req)=>service.retrieveCheckout(owner,req.params.id??'')));
  router.get('/v1/billing/subscriptions/:id/paid_invoices/:invoiceId',...read,handle((service,owner,req)=>service.retrievePaidInvoice(owner,req.params.id??'',req.params.invoiceId??'')));
  router.get('/v1/billing/subscriptions/:id', ...read, handle((service, owner, req) => service.retrieveSubscription(owner, req.params.id ?? '')));
  router.post('/v1/billing/subscriptions/:id/cancel_at_period_end', ...write, handle((service, owner, req) => {
    z.object({}).strict().parse(req.body);
    return service.cancelAtPeriodEnd(owner, req.params.id ?? '', key(req));
  }));
  return router;
}
