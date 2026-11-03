/**
 * Payment methods (`pm_…`, ADR 0016): retrieve, update (billing details and
 * metadata), list a customer's, detach. There is no create and no attach — a
 * `pm_…` is born attached when a SetupIntent (or a payment saving its card)
 * succeeds, and a detached one is dead (`services/customers/paymentMethodService.ts`).
 *
 * Request schemas: the contract's (`@peable.to/contracts` `paymentMethodRoutes`).
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import {
  type BillingDetails,
  METADATA_LIMIT_MESSAGE,
  detachPaymentMethodParams,
  expandOnlyQuery,
  listPaymentMethodsQuery,
  toAddress,
  updatePaymentMethodParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import { findCustomerForMerchant } from '../db/customers/customerRepository';
import {
  findPaymentMethodForMerchant,
  listPaymentMethodsForCustomer,
  updatePaymentMethod,
} from '../db/customers/paymentMethodRepository';
import {
  PaymentMethodsUnavailableError,
  detachPaymentMethodForMerchant,
} from '../services/customers/paymentMethodService';
import { ProviderError } from '../services/providers/provider';
import { recordCustomerObjectEvent } from '../services/intentTransition';
import { kickWebhookOutbox } from '../services/webhookOutbox';
import { toPaymentMethodDTO } from '../lib/serialize';
import {
  requireAuthenticated,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
  requireScope,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { expandObjects, parseExpand } from '../lib/expand';
import { answerList, parseQuery, resolveListReference } from '../lib/list';
import { resolveMerchant } from './paymentIntents';

export function createPaymentMethodsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.get(
    '/v1/payment_methods',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listPaymentMethodsQuery);
      if (!query) return;
      const db = getDb();
      const customer = await resolveListReference(
        res,
        'customer',
        query.customer,
        async (publicId) => (await findCustomerForMerchant(db, publicId, merchant.id))?.id ?? null,
      );
      if (!customer.ok || customer.id === undefined) return;
      const customerId = customer.id;
      await answerList(req, res, {
        query,
        type: 'payment_method',
        merchantId: merchant.id,
        cursor: async (publicId) => {
          const row = await findPaymentMethodForMerchant(db, publicId, merchant.id);
          return row && row.customerId === customerId ? row.id : null;
        },
        fetch: (page) => listPaymentMethodsForCustomer(db, { customerId, page }),
        serialize: toPaymentMethodDTO,
      });
    }),
  );

  router.get(
    '/v1/payment_methods/:id',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const query = parseQuery(req, res, expandOnlyQuery);
      if (!query) return;
      const expand = parseExpand(res, 'payment_method', query.expand, { list: false });
      if (!expand) return;
      const method = await findPaymentMethodForMerchant(getDb(), id, merchant.id);
      if (!method) {
        sendError(res, 404, 'invalid_request_error', 'payment method not found');
        return;
      }
      const dto = toPaymentMethodDTO(method);
      await expandObjects([dto], 'payment_method', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /**
   * Update billing details (each named field replaces that field) and metadata
   * (a patch). Orbit's record of the card holder; the provider's copy is not
   * rewritten — the card was verified against what the payer entered there.
   */
  router.post(
    '/v1/payment_methods/:id',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = updatePaymentMethodParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const body = parsed.data;
      const expand = parseExpand(res, 'payment_method', body.expand, { list: false });
      if (!expand) return;
      const db = getDb();
      const method = await findPaymentMethodForMerchant(db, id, merchant.id);
      if (!method) {
        sendError(res, 404, 'invalid_request_error', 'payment method not found');
        return;
      }
      const given = body.billing_details;
      const billingDetails: BillingDetails | undefined =
        given === undefined
          ? undefined
          : {
              address:
                given.address !== undefined
                  ? toAddress(given.address)
                  : method.billingDetails.address,
              email: given.email ?? method.billingDetails.email,
              name: given.name ?? method.billingDetails.name,
              phone: given.phone ?? method.billingDetails.phone,
            };
      const result = await db.transaction(async (tx) => {
        const updated = await updatePaymentMethod(tx, id, merchant.id, {
          billingDetails,
          metadata: body.metadata,
        });
        if (typeof updated !== 'string') {
          await recordCustomerObjectEvent(
            tx,
            merchant.id,
            'payment_method.updated',
            toPaymentMethodDTO(updated),
          );
        }
        return updated;
      });
      if (result === 'missing') {
        sendError(res, 404, 'invalid_request_error', 'payment method not found');
        return;
      }
      if (result !== 'limit_exceeded') kickWebhookOutbox();
      if (result === 'limit_exceeded') {
        sendError(
          res,
          400,
          'invalid_request_error',
          METADATA_LIMIT_MESSAGE,
          'parameter_invalid',
          'metadata',
        );
        return;
      }
      const dto = toPaymentMethodDTO(result);
      await expandObjects([dto], 'payment_method', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /** Detach — permanently. A second detach answers the detached method. */
  router.post(
    '/v1/payment_methods/:id/detach',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = detachPaymentMethodParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const expand = parseExpand(res, 'payment_method', parsed.data.expand, { list: false });
      if (!expand) return;
      try {
        const result = await detachPaymentMethodForMerchant(merchant.id, id);
        if (!result) {
          sendError(res, 404, 'invalid_request_error', 'payment method not found');
          return;
        }
        const dto = toPaymentMethodDTO(result.row);
        await expandObjects([dto], 'payment_method', expand, merchant.id);
        res.status(200).json(dto);
      } catch (error) {
        if (error instanceof PaymentMethodsUnavailableError) {
          sendError(res, 503, 'api_error', error.message);
          return;
        }
        if (error instanceof ProviderError) {
          sendProviderError(res, error);
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
