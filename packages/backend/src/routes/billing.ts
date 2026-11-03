import { billingTaxQuoteRequestSchema } from '../services/billing/tax-quote';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { resolveMerchant } from './paymentIntents';
import {
  BILLING_ERROR_MESSAGES,
  BillingError,
  billingIdempotencyKey,
  checkoutSchema,
  checkoutOperationRequestSchema,
  ensureCustomerSchema,
  portalSchema,
  type BillingOwner,
} from '../services/billing/contracts';
import type { BillingService } from '../services/billing/billingService';

/** A request the route itself refused, as opposed to a schema failure deeper down. */
class BillingRequestError extends Error {
  constructor(readonly issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
    super('invalid billing request');
    this.name = 'BillingRequestError';
  }
}
/** Parse what the caller sent; a failure names the offending field. */
function input<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BillingRequestError(parsed.error.issues);
  return parsed.data;
}

/** Absent service/cohort is closed. OxyServer verifies own authority or bounded external scopes. */
export function createBillingRouter(deps: {
  requireMerchant: RequestHandler;
  service?: BillingService;
}): Router {
  const router = Router();
  const handle = (
    action: (service: BillingService, owner: BillingOwner, req: Request) => Promise<unknown>,
  ) =>
    wrap(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      if (!deps.service) {
        sendError(
          res,
          404,
          'invalid_request_error',
          'Billing is not enabled for this merchant.',
          'billing_not_enabled',
        );
        return;
      }
      try {
        const result = await action(
          deps.service,
          {
            merchantId: merchant.id,
            oxyAppId: merchant.oxyAppId,
            environment: merchant.environment,
          },
          req,
        );
        res.json(result);
      } catch (error) {
        if (error instanceof BillingError) {
          sendError(
            res,
            error.status,
            error.status >= 500 ? 'api_error' : 'invalid_request_error',
            BILLING_ERROR_MESSAGES[error.code],
            error.code,
          );
          return;
        }
        if (error instanceof BillingRequestError) {
          sendValidationError(res, error);
          return;
        }
        if (error instanceof z.ZodError) {
          sendError(
            res,
            400,
            'invalid_request_error',
            'The billing request is invalid.',
            'invalid_billing_request',
          );
          return;
        }
        // Raw provider errors can contain customer details or hosted URLs.
        sendError(
          res,
          503,
          'api_error',
          'The billing provider is unavailable. Try again later.',
          'billing_provider_unavailable',
        );
      }
    });
  const key = (req: Request) => {
    const parsed = billingIdempotencyKey.safeParse(req.header('Idempotency-Key'));
    if (!parsed.success)
      throw new BillingRequestError([
        {
          path: [],
          message: 'A valid Idempotency-Key header is required.',
        },
      ]);
    return parsed.data;
  };
  const write = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
  ];
  const read = [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  // The rails this merchant's payers can choose between, default first.
  router.get(
    '/v1/billing/rails',
    ...read,
    handle((service, owner) => {
      if (!service.listRails) throw new BillingError('not_found', 404);
      return service.listRails(owner);
    }),
  );
  router.post(
    '/v1/billing/tax_quotes',
    ...read,
    handle((service, owner, req) =>
      service.createTaxQuote(owner, input(billingTaxQuoteRequestSchema, req.body)),
    ),
  );
  router.post(
    '/v1/billing/customers',
    ...write,
    handle((service, owner, req) =>
      service.ensureCustomer(owner, input(ensureCustomerSchema, req.body), key(req)),
    ),
  );
  router.post(
    '/v1/billing/checkout_sessions',
    ...write,
    handle((service, owner, req) =>
      service.createCheckoutSession(owner, input(checkoutSchema, req.body), key(req)),
    ),
  );
  router.post(
    '/v1/billing/portal_sessions',
    ...write,
    handle((service, owner, req) =>
      service.createPortalSession(owner, input(portalSchema, req.body), key(req)),
    ),
  );
  router.get(
    '/v1/billing/checkout_operations/:key',
    ...read,
    handle((service, owner, req) =>
      service.retrieveCheckoutOperation(
        owner,
        input(checkoutOperationRequestSchema, { ...req.query, idempotency_key: req.params.key }),
      ),
    ),
  );
  router.get(
    '/v1/billing/checkout_sessions/:id',
    ...read,
    handle((service, owner, req) => service.retrieveCheckout(owner, req.params.id ?? '')),
  );
  router.get(
    '/v1/billing/subscriptions/:id/invoice_authorities/:invoiceId',
    ...read,
    handle((service, owner, req) => {
      // `?include=tax_lines`: the frozen Peable Tax lines, inside the signature.
      const { include } = input(z.object({ include: z.literal('tax_lines').optional() }), {
        include: req.query.include,
      });
      return service.retrieveFinalInvoiceAuthority(
        owner,
        req.params.id ?? '',
        req.params.invoiceId ?? '',
        include ? { taxLines: true } : undefined,
      );
    }),
  );
  router.get(
    '/v1/billing/subscriptions/:id/invoice_states/:invoiceId',
    ...read,
    handle((service, owner, req) =>
      service.retrieveInvoiceState(owner, req.params.id ?? '', req.params.invoiceId ?? ''),
    ),
  );
  router.get(
    '/v1/billing/subscriptions/:id/paid_invoices/:invoiceId',
    ...read,
    handle((service, owner, req) =>
      service.retrievePaidInvoice(owner, req.params.id ?? '', req.params.invoiceId ?? ''),
    ),
  );
  router.get(
    '/v1/billing/subscriptions/:id',
    ...read,
    handle((service, owner, req) => service.retrieveSubscription(owner, req.params.id ?? '')),
  );
  router.post(
    '/v1/billing/subscriptions/:id/renew',
    ...write,
    handle((service, owner, req) => {
      if (!service.renew) throw new BillingError('not_found', 404);
      return service.renew(owner, req.params.id ?? '', input(checkoutSchema, req.body), key(req));
    }),
  );
  router.post(
    '/v1/billing/subscriptions/:id/cancel_at_period_end',
    ...write,
    handle((service, owner, req) => {
      input(z.object({}).strict(), req.body);
      return service.cancelAtPeriodEnd(owner, req.params.id ?? '', key(req));
    }),
  );
  return router;
}
