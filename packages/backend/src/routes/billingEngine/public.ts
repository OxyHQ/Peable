/**
 * The payer-facing billing routes (ADR 0018) — anonymous, authorized by an
 * unguessable bearer token in the path, like a payment link:
 *
 * - `/v1/invoices/public/:token` — a finalized invoice as its payer sees it,
 *   `/pay` (the PaymentIntent the payer completes on the hosted checkout) and
 *   `/pdf`;
 * - `/v1/billing_portal/public/:token` — the customer portal's session and its
 *   actions.
 *
 * Mounted behind the public rate limiter; nothing here reveals anything but
 * the one invoice or the one customer the token names. Every request schema
 * is the contract's (`@peable.to/contracts` `publicBillingRoutes`).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';
import {
  completePortalPaymentMethodUpdateParams,
  payPublicInvoiceParams,
  portalChangePlanParams,
  portalCustomerParams,
  portalSubscriptionParams,
  startPortalPaymentMethodUpdateParams,
  toAddress,
} from '@peable.to/contracts';
import type { PublicInvoice } from '@peable.to/shared-types';
import {
  findInvoiceByHostedToken,
  listLines,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { getDb } from '../../db/postgres';
import { sendError, sendValidationError, wrap } from '../../lib/http';
import { invoicePdfUrl } from '../../lib/serializeBilling';
import { toUnix, toUnixOrNull } from '../../lib/time';
import { resolveMerchantDisplay } from '../../services/merchantDisplay';
import { payerIntentForInvoice, railOf } from '../../services/billingEngine/collect';
import { faircoinAvailability } from '../../services/faircoin/quote';
import { invoicePdf } from '../../services/billingEngine/invoicePdf';
import {
  portalCancel,
  portalChangePlan,
  portalFinishPaymentMethodUpdate,
  portalRenew,
  portalStartPaymentMethodUpdate,
  portalUpdateCustomer,
  portalView,
} from '../../services/billingEngine/portal';
import { sendCatalogError } from '../catalogRoutes';

async function invoiceByToken(
  res: Response,
  token: string | undefined,
): Promise<InvoiceRow | null> {
  const invoice = token ? await findInvoiceByHostedToken(getDb(), token) : null;
  if (!invoice) {
    sendError(res, 404, 'invalid_request_error', 'invoice not found', 'resource_missing');
    return null;
  }
  return invoice;
}

async function publicInvoice(invoice: InvoiceRow): Promise<PublicInvoice> {
  const db = getDb();
  const merchant = await findMerchantById(db, invoice.merchantId);
  if (!merchant || !invoice.hostedToken)
    throw new Error('a hosted invoice without its merchant or token');
  const display = await resolveMerchantDisplay(merchant);
  const lines = await listLines(db, invoice.id);
  const remaining =
    invoice.status === 'paid' || invoice.status === 'void'
      ? 0n
      : BigInt(invoice.amountDue) -
        BigInt(invoice.amountPaid) -
        BigInt(invoice.prePaymentCreditNotesAmount);
  return {
    object: 'public_invoice',
    livemode: invoice.livemode,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    merchant: { name: display.name, avatar_url: display.avatar_url },
    customer_name: invoice.customerName,
    customer_email: invoice.customerEmail,
    description: invoice.description,
    lines: lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      amount: line.amount,
      period: { start: toUnix(line.periodStart), end: toUnix(line.periodEnd) },
      proration: line.proration,
    })),
    subtotal: invoice.subtotal,
    total_discount: invoice.totalDiscount,
    tax: invoice.tax,
    total: invoice.total,
    amount_due: invoice.amountDue,
    amount_paid: invoice.amountPaid,
    amount_remaining: (remaining > 0n ? remaining : 0n).toString(),
    due_date: toUnixOrNull(invoice.dueDate),
    created: toUnix(invoice.createdAt),
    finalized_at: toUnixOrNull(invoice.finalizedAt),
    paid_at: toUnixOrNull(invoice.paidAt),
    // FairCoin is always offered (ADR 0021 D1); a fiat invoice also takes a card.
    payment_method_types:
      railOf(invoice.currency) === 'faircoin' ? ['faircoin'] : ['card', 'faircoin'],
    faircoin: await faircoinAvailability({ network: merchant.network, currency: invoice.currency }),
    invoice_pdf: invoicePdfUrl(invoice.hostedToken),
  };
}

function guarded(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return wrap(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendCatalogError(res, error);
    }
  });
}

function body<T>(req: Request, res: Response, schema: z.ZodType<T, unknown>): T | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}

export function createPublicBillingRouter(deps: { publicRateLimit: RequestHandler }): Router {
  const router = Router();
  const limit = deps.publicRateLimit;

  router.get(
    '/v1/invoices/public/:token',
    limit,
    guarded(async (req, res) => {
      const invoice = await invoiceByToken(res, req.params.token);
      if (invoice) res.status(200).json(await publicInvoice(invoice));
    }),
  );

  router.post(
    '/v1/invoices/public/:token/pay',
    limit,
    guarded(async (req, res) => {
      const invoice = await invoiceByToken(res, req.params.token);
      if (!invoice) return;
      const parsed = body(req, res, payPublicInvoiceParams);
      if (!parsed) return;
      const intent = await payerIntentForInvoice(invoice, parsed.payment_method_type);
      res.status(200).json({
        object: 'public_invoice_payment',
        payment_intent: intent.publicId,
        client_secret: intent.clientSecret,
      });
    }),
  );

  router.get(
    '/v1/invoices/public/:token/pdf',
    limit,
    guarded(async (req, res) => {
      const invoice = await invoiceByToken(res, req.params.token);
      if (!invoice) return;
      const document = await invoicePdf(invoice);
      res
        .status(200)
        .type('application/pdf')
        .setHeader('Content-Disposition', `inline; filename="${invoice.number ?? 'invoice'}.pdf"`);
      res.end(Buffer.from(document));
    }),
  );

  const token = (req: Request) => req.params.token ?? '';

  router.get(
    '/v1/billing_portal/public/:token',
    limit,
    guarded(async (req, res) => {
      res.status(200).json(await portalView(token(req)));
    }),
  );

  router.post(
    '/v1/billing_portal/public/:token/cancel',
    limit,
    guarded(async (req, res) => {
      const input = body(req, res, portalSubscriptionParams);
      if (!input) return;
      await portalCancel(token(req), input.subscription);
      res.status(200).json(await portalView(token(req)));
    }),
  );
  router.post(
    '/v1/billing_portal/public/:token/renew',
    limit,
    guarded(async (req, res) => {
      const input = body(req, res, portalSubscriptionParams);
      if (!input) return;
      await portalRenew(token(req), input.subscription);
      res.status(200).json(await portalView(token(req)));
    }),
  );
  router.post(
    '/v1/billing_portal/public/:token/change_plan',
    limit,
    guarded(async (req, res) => {
      const input = body(req, res, portalChangePlanParams);
      if (!input) return;
      await portalChangePlan(token(req), {
        subscription: input.subscription,
        ...(input.price ? { price: input.price } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      });
      res.status(200).json(await portalView(token(req)));
    }),
  );
  router.post(
    '/v1/billing_portal/public/:token/customer',
    limit,
    guarded(async (req, res) => {
      const input = body(req, res, portalCustomerParams);
      if (!input) return;
      await portalUpdateCustomer(token(req), {
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.address ? { address: toAddress(input.address) } : {}),
      });
      res.status(200).json(await portalView(token(req)));
    }),
  );
  router.post(
    '/v1/billing_portal/public/:token/payment_method_update',
    limit,
    guarded(async (req, res) => {
      if (!body(req, res, startPortalPaymentMethodUpdateParams)) return;
      res.status(200).json(await portalStartPaymentMethodUpdate(token(req)));
    }),
  );
  router.post(
    '/v1/billing_portal/public/:token/payment_method_update/complete',
    limit,
    guarded(async (req, res) => {
      const input = body(req, res, completePortalPaymentMethodUpdateParams);
      if (!input) return;
      const status = await portalFinishPaymentMethodUpdate(token(req), input.setup_intent);
      res.status(200).json({ status, session: await portalView(token(req)) });
    }),
  );

  return router;
}
