/**
 * The dispute surface: read, and RESPOND.
 *
 * ## What the write is, and why it was not here
 *
 * Every other money route has a POST because the merchant initiates. A dispute
 * is initiated by the card network, so the only write worth having is
 * submitting EVIDENCE — and this file used to say, correctly, that the
 * provider port had no `submitDisputeEvidence` and that *"adding the route
 * without it would give merchants a surface that accepts their evidence and
 * does nothing with it, which is worse for them than having no route at all:
 * they would believe they had responded."*
 *
 * That was right while the port was missing and it was never a destination.
 * The deadline was exposed and the response was not, so a merchant could read
 * `evidence_due_at`, watch it pass, and lose a dispute this gateway had told them
 * about and given them no way to answer. `DisputeHandlingProvider` exists now;
 * the POST is below.
 *
 * TEXT evidence only, and nothing is stored. `services/disputeEvidence.ts`
 * carries both arguments.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { findDisputeByPublicId, listDisputesForMerchant } from '../db/disputes/disputeRepository';
import {
  DisputeNotAnswerableError,
  DisputesUnanswerableError,
  submitDisputeEvidence,
} from '../services/disputeEvidence';
import { EnvironmentModeMismatchError } from '../services/providers/environmentGuard';
import type { DisputeEvidence } from '@peable.to/shared-types';
import { ProviderError } from '../services/providers/provider';
import { toDisputeDTO } from '../lib/serialize';
import {
  requireAuthenticated,
  requireProviderMode,
  sendEnvironmentMismatch,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  listQuerySchema,
  parseQuery,
  resolveListReference,
  retrieveQuerySchema,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

/** `GET /v1/disputes`: every dispute of the merchant, or of one payment. */
const listDisputesQuery = listQuerySchema({
  payment_intent: z.string().min(1).max(255).optional(),
});
/** The per-payment sub-list: the payment is in the path. */
const listIntentDisputesQuery = listQuerySchema({});
const retrieveDisputeQuery = retrieveQuerySchema({});

/**
 * How long one evidence field may be.
 *
 * The provider's own ceiling, restated where the request is parsed: a body that
 * exceeds it is refused here with a message naming the field, rather than at
 * the acquirer with a message about a one-shot submission that then cannot be
 * retried in the shape the merchant sent.
 */
const EVIDENCE_FIELD_MAX = 20_000;

const evidenceField = z.string().min(1).max(EVIDENCE_FIELD_MAX).optional();

/**
 * The TEXT evidence fields, in the gateway's spelling.
 *
 * A closed set rather than a passthrough object: evidence goes to a card
 * network that has its own field names, and a gateway forwarding whatever it
 * was handed would let a typo become a field the network silently ignores —
 * discovered by losing the dispute. The adapter maps these to the provider's
 * names, in one place.
 *
 * File attachments are deliberately absent; the service says why.
 */
const evidenceBodySchema = z
  .object({
    product_description: evidenceField,
    customer_name: evidenceField,
    customer_email_address: evidenceField,
    customer_purchase_ip: evidenceField,
    billing_address: evidenceField,
    shipping_address: evidenceField,
    shipping_carrier: evidenceField,
    shipping_date: evidenceField,
    shipping_tracking_number: evidenceField,
    service_date: evidenceField,
    access_activity_log: evidenceField,
    cancellation_policy_disclosure: evidenceField,
    cancellation_rebuttal: evidenceField,
    duplicate_charge_explanation: evidenceField,
    refund_policy_disclosure: evidenceField,
    refund_refusal_explanation: evidenceField,
    uncategorized_text: evidenceField,
  } satisfies Record<keyof DisputeEvidence, typeof evidenceField>)
  // Unknown keys are REFUSED rather than dropped. A merchant who sent
  // `tracking_number` instead of `shipping_tracking_number` would otherwise submit
  // — finally — a response missing the field they were relying on, and find out
  // when the dispute is decided.
  .strict();

export function createDisputesRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.get(
    '/v1/payment_intents/:intentId/disputes',
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
      const query = parseQuery(req, res, listIntentDisputesQuery);
      if (!query) return;

      const db = getDb();
      // ONE 404 for both "does not exist" and "is not yours", scoped in the
      // predicate: distinguishing them tells a caller whether another
      // merchant's `pi_…` is real.
      const intent = await findIntentForMerchant(db, intentId, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      await answerList(req, res, {
        query,
        type: 'dispute',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findDisputeByPublicId(db, merchant.id, publicId))?.id ?? null,
        fetch: (page) =>
          listDisputesForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          }),
        serialize: (row) => toDisputeDTO(row, row.paymentIntentPublicId),
      });
    }),
  );

  /** Every dispute of the merchant, newest first — or of one payment, `payment_intent=pi_…`. */
  router.get(
    '/v1/disputes',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listDisputesQuery);
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
        type: 'dispute',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findDisputeByPublicId(db, merchant.id, publicId))?.id ?? null,
        fetch: (page) =>
          listDisputesForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          }),
        serialize: (row) => toDisputeDTO(row, row.paymentIntentPublicId),
      });
    }),
  );

  /** One dispute, by `dp_…`, scoped to the merchant in the predicate. */
  router.get(
    '/v1/disputes/:disputeId',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { disputeId } = req.params;
      if (!disputeId) {
        sendError(res, 400, 'invalid_request_error', 'disputeId is required');
        return;
      }
      const query = parseQuery(req, res, retrieveDisputeQuery);
      if (!query) return;
      const expand = parseExpand(res, 'dispute', query.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const dispute = await findDisputeByPublicId(db, merchant.id, disputeId);
      if (!dispute) {
        sendError(res, 404, 'invalid_request_error', 'dispute not found');
        return;
      }
      const intent = await findIntentById(db, dispute.paymentIntentId);
      if (!intent) {
        // `disputes.payment_intent_id` carries a foreign key with `on delete
        // restrict`; stated so loosening it fails loudly.
        throw new Error(`dispute ${dispute.publicId} names an intent that cannot be read`);
      }
      const dto = toDisputeDTO(dispute, intent.publicId);
      await expandObjects([dto], 'dispute', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /**
   * Answer a dispute.
   *
   * ONE SHOT. Submitting is one-way at the network, so a second call answers
   * 200 with the dispute as it stands rather than sending a second response —
   * the same distinction the settlement and refund routes make between a replay
   * and a new operation, and here it is not recoverable at all if got wrong.
   *
   * Evidence is TEXT and is never stored: it carries a customer's name, their
   * email, a billing address and correspondence, and this gateway keeps none of
   * that. Files are out of scope, explicitly — see the service.
   */
  router.post(
    '/v1/disputes/:disputeId/evidence',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      // BEFORE the dispute lookup, whose 404 would otherwise let a wrong-mode
      // credential probe which `dp_…` values this merchant owns.
      if (!requireProviderMode(merchant.environment, res)) return;

      const { disputeId } = req.params;
      if (!disputeId) {
        sendError(res, 400, 'invalid_request_error', 'disputeId is required');
        return;
      }

      const parsed = evidenceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }

      const db = getDb();
      const dispute = await findDisputeByPublicId(db, merchant.id, disputeId);
      if (!dispute) {
        sendError(res, 404, 'invalid_request_error', 'dispute not found');
        return;
      }
      const intent = await findIntentById(db, dispute.paymentIntentId);
      if (!intent) {
        // Structurally unreachable: `disputes.payment_intent_id` carries a
        // foreign key with `on delete restrict`. Stated rather than asserted
        // away, so a future change that loosens it fails loudly instead of
        // emitting an empty id.
        throw new Error(`dispute ${dispute.publicId} names an intent that cannot be read`);
      }

      try {
        const { dispute: answered, submitted } = await submitDisputeEvidence({
          environment: merchant.environment,
          dispute,
          evidence: parsed.data,
        });
        // 201 for a response this call delivered, 200 for one already given.
        // A merchant retrying after a timeout needs to know whether the network
        // heard them once or twice — and it can only ever be once.
        res.status(submitted ? 201 : 200).json(toDisputeDTO(answered, intent.publicId));
      } catch (error) {
        if (error instanceof DisputeNotAnswerableError) {
          // 409: the request is well-formed and the dispute is simply not in a
          // state that accepts it — closed, or past its deadline. Neither is
          // fixable by editing the body, which a 400 would suggest.
          sendError(res, 409, 'invalid_request_error', error.message);
          return;
        }
        if (error instanceof DisputesUnanswerableError) {
          sendError(res, 503, 'api_error', error.message);
          return;
        }
        if (error instanceof EnvironmentModeMismatchError) {
          sendEnvironmentMismatch(res, error.message);
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
