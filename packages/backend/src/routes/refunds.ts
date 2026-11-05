/**
 * The refund surface: `/v1/refunds`.
 *
 * Merchant-authed, merchant-scoped, and the one route in this API where a
 * duplicate is unrecoverable: a payer sent their money twice has no reason to
 * report it, and nothing reverses the second automatically. Every path here
 * converges on the merchant's own refund id rather than erroring.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import {
  METADATA_LIMIT_MESSAGE,
  cancelRefundParams,
  createRefundParams,
  expandOnlyQuery,
  listPaymentIntentRefundsQuery,
  listRefundsQuery,
  updateRefundParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import {
  findRefundByExternalRef,
  findRefundByPublicId,
  listRefundsForMerchant,
  updateRefundMetadata,
} from '../db/refunds/refundRepository';
import {
  cancelRefund,
  createRefund,
  RefundNotCancelableError,
  PaymentNotRefundableError,
  RefundExceedsRemainingError,
  RefundsUnavailableError,
  remainingRefundable,
} from '../services/refunds/refundService';
import { reportRefundSettlement, reportSettlement } from '../services/settlementReport';
import { ProviderError } from '../services/providers/provider';
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
import { toRefundDTO, toSettlementDTO } from '../lib/serialize';
import { answerList, parseQuery, resolveListReference } from '../lib/list';
import { resolveMerchant } from './paymentIntents';

/**
 * Every request schema and the wire shape are the contract's
 * (`@peable.to/contracts` `refundRoutes`) — the provider's own refund id never
 * appears in it.
 */
export function createRefundsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.post(
    '/v1/refunds',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const parsed = createRefundParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const body = parsed.data;
      const db = getDb();

      // Scoped in the PREDICATE: a payment that does not exist and one that
      // belongs to another merchant are the same answer.
      const intent = await findIntentForMerchant(db, body.payment_intent, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      /**
       * The idempotency check comes BEFORE the amount is examined.
       *
       * A retry of a refund already made is a question about history: the money
       * is gone, and the answer must not change because the remaining balance
       * no longer accommodates it — which it will not, since this very refund
       * consumed it.
       */
      const existing = await findRefundByExternalRef(db, merchant.id, body.external_ref);
      /**
       * A FINISHED refund is history and is answered as such. One that never
       * reached the provider falls THROUGH to `createRefund`, which resumes it
       * under the same provider idempotency key.
       *
       * The distinction is `providerObjectId`: a refund that reached the
       * provider has one whatever its state, and one that did not is `pending`
       * with nothing behind it. Answering 200 for that second case — which is
       * what used to happen — told a merchant their refund existed while the
       * payer's money had not moved and no path would ever retry it.
       */
      if (existing && (existing.providerObjectId !== null || existing.status === 'failed')) {
        res.status(200).json(toRefundDTO(existing, intent.publicId));
        return;
      }

      try {
        const { refund, created } = await createRefund({
          merchantId: merchant.id,
          intent,
          externalRef: body.external_ref,
          amount: body.amount,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          ...(body.refund_application_fee ? { refundApplicationFee: true } : {}),
          ...(body.reverse_transfer ? { reverseTransfer: true } : {}),
        });
        res.status(created ? 201 : 200).json(toRefundDTO(refund, intent.publicId));
      } catch (error) {
        if (
          error instanceof PaymentNotRefundableError ||
          error instanceof RefundExceedsRemainingError
        ) {
          sendError(res, 400, 'invalid_request_error', error.message);
          return;
        }
        if (error instanceof RefundsUnavailableError) {
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

  /**
   * Every refund of the merchant, newest first — or of one payment, with
   * `payment_intent=pi_…`. Includes refunds made OUTSIDE Peable (imported,
   * `origin: 'provider'`).
   */
  router.get(
    '/v1/refunds',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listRefundsQuery);
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
        type: 'refund',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findRefundByPublicId(db, merchant.id, publicId))?.id ?? null,
        fetch: (page) =>
          listRefundsForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          }),
        serialize: (row) => toRefundDTO(row, row.paymentIntentPublicId),
      });
    }),
  );

  /** One refund, by `re_…`, scoped to the merchant in the predicate. */
  router.get(
    '/v1/refunds/:id',
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
      const expand = parseExpand(res, 'refund', query.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const refund = await findRefundByPublicId(db, merchant.id, id);
      if (!refund) {
        sendError(res, 404, 'invalid_request_error', 'refund not found');
        return;
      }
      const intent = await findIntentById(db, refund.paymentIntentId);
      if (!intent) {
        // `refunds.payment_intent_id` carries a foreign key; stated rather
        // than asserted away, so loosening it fails loudly.
        throw new Error(`refund ${refund.publicId} names an intent that cannot be read`);
      }
      const dto = toRefundDTO(refund, intent.publicId);
      await expandObjects([dto], 'refund', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /** The merchant's own bookkeeping on a refund (ADR 0014 D1): `metadata`, a patch. */
  router.post(
    '/v1/refunds/:id',
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
      const parsed = updateRefundParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const db = getDb();
      const refund = await findRefundByPublicId(db, merchant.id, id);
      if (!refund) {
        sendError(res, 404, 'invalid_request_error', 'refund not found');
        return;
      }
      const intent = await findIntentById(db, refund.paymentIntentId);
      if (!intent) throw new Error(`refund ${refund.publicId} names an intent that cannot be read`);
      if (parsed.data.metadata === undefined) {
        res.status(200).json(toRefundDTO(refund, intent.publicId));
        return;
      }
      const updated = await updateRefundMetadata(db, merchant.id, refund.id, parsed.data.metadata);
      if (!updated) {
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
      res.status(200).json(toRefundDTO(updated, intent.publicId));
    }),
  );

  /** Cancel a refund the provider still holds (`requires_action` at the provider). */
  router.post(
    '/v1/refunds/:id/cancel',
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
      const parsed = cancelRefundParams.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const db = getDb();
      const refund = await findRefundByPublicId(db, merchant.id, id);
      if (!refund) {
        sendError(res, 404, 'invalid_request_error', 'refund not found');
        return;
      }
      const intent = await findIntentById(db, refund.paymentIntentId);
      if (!intent) throw new Error(`refund ${refund.publicId} names an intent that cannot be read`);
      try {
        res.status(200).json(toRefundDTO(await cancelRefund(intent, refund), intent.publicId));
      } catch (error) {
        if (error instanceof RefundNotCancelableError) {
          sendError(res, 400, 'invalid_request_error', error.message, 'refund_not_cancelable');
          return;
        }
        if (error instanceof RefundsUnavailableError) {
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

  /**
   * Every refund against one payment, and what is still refundable.
   *
   * The remaining figure is offered beside the envelope because otherwise every
   * merchant computes it themselves by summing this list — and the ones who
   * forget that a `pending` or `failed` refund moved no money would compute it
   * wrong, in the direction that refuses a legitimate refund. It is about the
   * PAYMENT, so it is the same on every page.
   */
  router.get(
    '/v1/payment_intents/:intentId/refunds',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const { intentId } = req.params;
      if (!intentId) {
        sendError(res, 400, 'invalid_request_error', 'intentId is required');
        return;
      }
      const query = parseQuery(req, res, listPaymentIntentRefundsQuery);
      if (!query) return;

      const db = getDb();
      const intent = await findIntentForMerchant(db, intentId, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      await answerList(req, res, {
        query,
        type: 'refund',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findRefundByPublicId(db, merchant.id, publicId))?.id ?? null,
        fetch: (page) =>
          listRefundsForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          }),
        serialize: (row) => toRefundDTO(row, row.paymentIntentPublicId),
        extra: { remaining_refundable: await remainingRefundable(intent) },
      });
    }),
  );

  /**
   * What this payment actually came to — gross, fee, net.
   *
   * On the refund router rather than a new one because it is the same question
   * a merchant asks in the same breath: how much of this money is really mine.
   *
   * **A missing figure is `null` with a `status`, never `0`.** That is the
   * whole point of the shape: a report rendering a not-yet-known fee as zero is
   * one a merchant reconciles against and cannot explain, and zero is a number
   * somebody will subtract.
   *
   * It reports what the provider took; it does NOT attribute that cost to an
   * entity. Which entity bears which fee is a commercial decision that is
   * still open (#70 §13, and the roadmap), and no read here makes it.
   */
  router.get(
    '/v1/payment_intents/:intentId/settlement',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const { intentId } = req.params;
      if (!intentId) {
        sendError(res, 400, 'invalid_request_error', 'intentId is required');
        return;
      }

      // Scoped in the PREDICATE, not compared after the read: a payment that
      // does not exist and one belonging to another merchant are the same
      // answer, so neither the row nor its absence can confirm an id.
      const query = parseQuery(req, res, expandOnlyQuery);
      if (!query) return;
      const expand = parseExpand(res, 'settlement', query.expand, { list: false });
      if (!expand) return;
      const intent = await findIntentForMerchant(getDb(), intentId, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      const body = toSettlementDTO(await reportSettlement(intent), {
        livemode: intent.livemode,
        paymentIntentPublicId: intent.publicId,
      });
      await expandObjects([body], 'settlement', expand, merchant.id);
      res.status(200).json(body);
    }),
  );

  /**
   * What this refund took off the settlement balance — `gross`, `fee`, a
   * negative `net` — in the SETTLEMENT currency, which is the one a
   * marketplace books the refund in. The same `settlement` object and the same
   * rules as the payment's above: `null` with a `status`, never `0`, and a
   * refund that failed or was canceled is `unknown`.
   */
  router.get(
    '/v1/refunds/:id/settlement',
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
      const expand = parseExpand(res, 'settlement', query.expand, { list: false });
      if (!expand) return;

      // ONE 404 for "does not exist" and "is not yours", scoped in the predicate.
      const db = getDb();
      const refund = await findRefundByPublicId(db, merchant.id, id);
      if (!refund) {
        sendError(res, 404, 'invalid_request_error', 'refund not found');
        return;
      }
      const intent = await findIntentById(db, refund.paymentIntentId);
      if (!intent) {
        // `refunds.payment_intent_id` carries a foreign key; stated rather
        // than asserted away, so loosening it fails loudly.
        throw new Error(`refund ${refund.publicId} names an intent that cannot be read`);
      }

      const body = toSettlementDTO(await reportRefundSettlement(refund), {
        livemode: refund.livemode,
        paymentIntentPublicId: intent.publicId,
        refundPublicId: refund.publicId,
      });
      await expandObjects([body], 'settlement', expand, merchant.id);
      res.status(200).json(body);
    }),
  );

  return router;
}
