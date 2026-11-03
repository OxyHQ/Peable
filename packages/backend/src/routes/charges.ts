/**
 * Charges (ADR 0019) — READ-ONLY. A `ch_…` is the record of the authorization a
 * card payment obtained; it is written by the payment's own transitions and
 * never through this API. A FairCoin payment has none.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { expandOnlyQuery, listChargesQuery } from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { findChargeForMerchant, listChargesForMerchant } from '../db/payments/chargeRepository';
import { toChargeDTO } from '../lib/serialize';
import { requireAuthenticated, sendError, wrap, requireScope } from '../lib/http';
import { expandObjects, parseExpand } from '../lib/expand';
import { answerList, parseQuery, resolveListReference } from '../lib/list';
import { resolveMerchant } from './paymentIntents';

export function createChargesRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.get(
    '/v1/charges',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listChargesQuery);
      if (!query) return;
      const db = getDb();
      const intent = await resolveListReference(
        res,
        'payment_intent',
        query.payment_intent,
        async (publicId) => (await findIntentForMerchant(db, publicId, merchant.id))?.id ?? null,
      );
      if (!intent.ok) return;
      await answerList(req, res, {
        query,
        type: 'charge',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findChargeForMerchant(db, publicId, merchant.id))?.id ?? null,
        fetch: (page) =>
          listChargesForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          }),
        serialize: toChargeDTO,
      });
    }),
  );

  router.get(
    '/v1/charges/:id',
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
      const expand = parseExpand(res, 'charge', query.expand, { list: false });
      if (!expand) return;
      const charge = await findChargeForMerchant(getDb(), id, merchant.id);
      if (!charge) {
        sendError(res, 404, 'invalid_request_error', 'charge not found');
        return;
      }
      const dto = toChargeDTO(charge);
      await expandObjects([dto], 'charge', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  return router;
}
