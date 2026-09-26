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
 * `evidenceDueAt`, watch it pass, and lose a dispute this gateway had told them
 * about and given them no way to answer. `DisputeHandlingProvider` exists now;
 * the POST is below.
 *
 * TEXT evidence only, and nothing is stored. `services/disputeEvidence.ts`
 * carries both arguments.
 */
import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxy } from "../oxy";
import { getDb } from "../db/postgres";
import {
  findIntentById,
  findIntentByPublicId,
} from "../db/payments/paymentIntentRepository";
import {
  findDisputeByPublicId,
  listDisputesForIntent,
} from "../db/disputes/disputeRepository";
import {
  DisputeNotAnswerableError,
  DisputesUnanswerableError,
  submitDisputeEvidence,
} from "../services/disputeEvidence";
import { EnvironmentModeMismatchError } from "../services/providers/environmentGuard";
import type { DisputeEvidence } from "@peable.to/shared-types";
import { ProviderError } from "../services/providers/provider";
import { toDisputeDTO } from "../lib/serialize";
import {
  requireAuthenticated,
  requireProviderMode,
  sendEnvironmentMismatch,
  sendError,
  sendProviderError,
  wrap,
} from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

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
    productDescription: evidenceField,
    customerName: evidenceField,
    customerEmailAddress: evidenceField,
    customerPurchaseIp: evidenceField,
    billingAddress: evidenceField,
    shippingAddress: evidenceField,
    shippingCarrier: evidenceField,
    shippingDate: evidenceField,
    shippingTrackingNumber: evidenceField,
    serviceDate: evidenceField,
    accessActivityLog: evidenceField,
    cancellationPolicyDisclosure: evidenceField,
    cancellationRebuttal: evidenceField,
    duplicateChargeExplanation: evidenceField,
    refundPolicyDisclosure: evidenceField,
    refundRefusalExplanation: evidenceField,
    uncategorizedText: evidenceField,
  } satisfies Record<keyof DisputeEvidence, typeof evidenceField>)
  // Unknown keys are REFUSED rather than dropped. A merchant who sent
  // `trackingNumber` instead of `shippingTrackingNumber` would otherwise submit
  // — finally — a response missing the field they were relying on, and find out
  // when the dispute is decided.
  .strict();

export function createDisputesRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.get(
    "/v1/payment_intents/:intentId/disputes",
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const { intentId } = req.params;
      if (!intentId) {
        sendError(res, 422, "invalid_request_error", "intentId is required");
        return;
      }

      const db = getDb();
      const intent = await findIntentByPublicId(db, intentId);
      // ONE 404 for both "does not exist" and "is not yours": distinguishing
      // them tells a caller whether another merchant's `pi_…` is real.
      if (!intent || intent.merchantId !== merchant.id) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      const rows = await listDisputesForIntent(db, intent.id);
      res.status(200).json({
        object: "list",
        data: rows.map((row) => toDisputeDTO(row, intent.publicId)),
      });
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
    "/v1/disputes/:disputeId/evidence",
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      // BEFORE the dispute lookup, whose 404 would otherwise let a wrong-mode
      // credential probe which `dp_…` values this merchant owns.
      if (!requireProviderMode(merchant.environment, res)) return;

      const { disputeId } = req.params;
      if (!disputeId) {
        sendError(res, 422, "invalid_request_error", "disputeId is required");
        return;
      }

      const parsed = evidenceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid body",
        );
        return;
      }

      const db = getDb();
      const dispute = await findDisputeByPublicId(db, merchant.id, disputeId);
      if (!dispute) {
        sendError(res, 404, "invalid_request_error", "dispute not found");
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
          // fixable by editing the body, which a 422 would suggest.
          sendError(res, 409, "invalid_request_error", error.message);
          return;
        }
        if (error instanceof DisputesUnanswerableError) {
          sendError(res, 503, "api_error", error.message);
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
