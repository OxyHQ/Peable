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
import { z } from 'zod';
import { oxy } from '../oxy';
import { isBaseUnitString, REFUND_REASONS, type Settlement } from '@peable.to/shared-types';
import {
  METADATA_LIMIT_MESSAGE,
  metadataCreateSchema,
  metadataUpdateSchema,
} from '../lib/metadata';
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
import { reportSettlement } from '../services/settlementReport';
import { ProviderError } from '../services/providers/provider';
import {
  requireAuthenticated,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { toUnixOrNull } from '../lib/time';
import { expandObjects, parseExpand } from '../lib/expand';
import { toRefundDTO } from '../lib/serialize';
import {
  answerList,
  listQuerySchema,
  parseQuery,
  resolveListReference,
  retrieveQuerySchema,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

/** `GET /v1/refunds`: every refund of the merchant, or of one payment. */
const listRefundsQuery = listQuerySchema({
  payment_intent: z.string().min(1).max(255).optional(),
});
/** The per-payment sub-list: the payment is in the path. */
const listIntentRefundsQuery = listQuerySchema({});
const retrieveRefundQuery = retrieveQuerySchema({});

const createRefundBodySchema = z
  .object({
    /** The `pi_…` being refunded. */
    payment_intent: z.string().min(1),
    /** The merchant's own id for this refund. The idempotency. */
    external_ref: z.string().min(1).max(255),
    /**
     * Validated with the SAME predicate the CHECK is rendered from, then
     * separately refused if zero: `'0'` is a canonical integer string and would
     * pass, while a zero refund consumes the merchant's `external_ref` so the REAL
     * refund for that order could never be created afterwards.
     */
    amount: z
      .string()
      .refine(isBaseUnitString, 'amount must be a canonical integer string in minor units')
      .refine((value) => value !== '0', 'a refund of 0 is not a refund'),
    reason: z.enum(REFUND_REASONS).optional(),
    metadata: metadataCreateSchema.optional(),
    // Destination charges (ADR 0015 §3): the provider refunds Orbit's fee and
    // pulls the funds back from the destination, in proportion.
    refund_application_fee: z.boolean().optional(),
    reverse_transfer: z.boolean().optional(),
  })
  .strict();

const updateRefundBodySchema = z.object({ metadata: metadataUpdateSchema.optional() }).strict();
const cancelRefundBodySchema = z.object({}).strict();

/**
 * The wire shape, published in `@peable.to/shared-types` — the provider's own
 * refund id never appears in it.
 *
 * Declared there rather than here so the SDK and an integrator's own adapter
 * describe this response ONCE. Two private copies of a wire format in two
 * repositories is how a renamed field becomes a runtime failure somebody else
 * discovers.
 */
export function createRefundsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.post(
    '/v1/refunds',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const parsed = createRefundBodySchema.safeParse(req.body);
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
    oxy.middleware.requireScope('payments:read'),
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
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const query = parseQuery(req, res, retrieveRefundQuery);
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
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = updateRefundBodySchema.safeParse(req.body);
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
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const parsed = cancelRefundBodySchema.safeParse(req.body ?? {});
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
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const { intentId } = req.params;
      if (!intentId) {
        sendError(res, 400, 'invalid_request_error', 'intentId is required');
        return;
      }
      const query = parseQuery(req, res, listIntentRefundsQuery);
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
    oxy.middleware.requireScope('payments:read'),
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
      const query = parseQuery(req, res, retrieveRefundQuery);
      if (!query) return;
      const expand = parseExpand(res, 'settlement', query.expand, { list: false });
      if (!expand) return;
      const intent = await findIntentForMerchant(getDb(), intentId, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      const settlement = await reportSettlement(intent);
      const body: Settlement = {
        object: 'settlement',
        livemode: intent.livemode,
        payment_intent: intent.publicId,
        status: settlement.status,
        gross: settlement.gross,
        fee: settlement.fee,
        net: settlement.net,
        currency: settlement.currency,
        available_on: toUnixOrNull(settlement.availableOn),
        exchange_rate: settlement.exchangeRate,
      };
      await expandObjects([body], 'settlement', expand, merchant.id);
      res.status(200).json(body);
    }),
  );

  return router;
}
