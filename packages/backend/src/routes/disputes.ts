/**
 * The dispute surface: read-only.
 *
 * ## Why there is no POST
 *
 * Every other money route here has one because the merchant initiates: they
 * create a refund, a transfer, a payment. A dispute is initiated by the card
 * network, so the only write a merchant would want is submitting EVIDENCE — and
 * that needs a provider-port method (`submitDisputeEvidence`) that does not
 * exist. Adding the route without it would give merchants a surface that
 * accepts their evidence and does nothing with it, which is worse for them than
 * having no route at all: they would believe they had responded.
 *
 * So the deadline is exposed and the response is not. A merchant reads
 * `evidenceDueAt` here and responds through the acquirer they hold the
 * relationship with. When the port grows the capability, the POST lands beside
 * these two and the DTO does not change.
 */
import { Router } from "express";
import type { RequestHandler } from "express";
import { oxyClient } from "@oxyhq/core";
import { getDb } from "../db/postgres";
import { findIntentByPublicId } from "../db/payments/paymentIntentRepository";
import { listDisputesForIntent, type DisputeRow } from "../db/disputes/disputeRepository";
import { requireAuthenticated, sendError, wrap } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

/** The wire shape. The network's own dispute id never appears. */
interface DisputeDTO {
  readonly id: string;
  readonly object: "dispute";
  readonly paymentIntentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  /**
   * The network's reason, verbatim and unmapped.
   *
   * Passed through rather than translated because it is the one field a
   * merchant argues against, and a gateway paraphrase would be the thing they
   * quote to the acquirer while the acquirer holds different words.
   */
  readonly reason: string | null;
  /** When the network stops accepting evidence. Absent once closed. */
  readonly evidenceDueAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toDisputeDTO(row: DisputeRow, paymentIntentPublicId: string): DisputeDTO {
  return {
    id: row.publicId,
    object: "dispute",
    paymentIntentId: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    evidenceDueAt: row.evidenceDueAt ? row.evidenceDueAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createDisputesRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.get(
    "/v1/payment_intents/:intentId/disputes",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
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

  return router;
}
