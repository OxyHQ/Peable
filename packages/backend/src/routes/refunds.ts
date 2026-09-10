/**
 * The refund surface: `/v1/refunds`.
 *
 * Merchant-authed, merchant-scoped, and the one route in this API where a
 * duplicate is unrecoverable: a payer sent their money twice has no reason to
 * report it, and nothing reverses the second automatically. Every path here
 * converges on the merchant's own refund id rather than erroring.
 */
import { Router } from "express";
import type { Response, RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import { isBaseUnitString } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findIntentByPublicId } from "../db/payments/paymentIntentRepository";
import {
  findRefundByExternalRef,
  listRefundsForIntent,
  type RefundRow,
} from "../db/refunds/refundRepository";
import {
  createRefund,
  PaymentNotRefundableError,
  RefundExceedsRemainingError,
  RefundsUnavailableError,
  remainingRefundable,
} from "../services/refunds/refundService";
import { ProviderError } from "../services/providers/provider";
import { redactProviderMessage } from "../services/providers/redact";
import { requireAuthenticated, sendError, wrap } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

const createRefundBodySchema = z.object({
  /** The `pi_…` being refunded. */
  paymentIntentId: z.string().min(1),
  /** The merchant's own id for this refund. The idempotency. */
  externalRef: z.string().min(1).max(255),
  /**
   * Validated with the SAME predicate the CHECK is rendered from, then
   * separately refused if zero: `'0'` is a canonical integer string and would
   * pass, while a zero refund consumes the merchant's `externalRef` so the REAL
   * refund for that order could never be created afterwards.
   */
  amount: z
    .string()
    .refine(isBaseUnitString, "amount must be a canonical integer string in minor units")
    .refine((value) => value !== "0", "a refund of 0 is not a refund"),
});

/** The wire shape. The provider's own refund id never appears. */
interface RefundDTO {
  readonly id: string;
  readonly object: "refund";
  readonly externalRef: string;
  readonly paymentIntentId: string;
  readonly amount: string;
  readonly currency: string;
  /** The REFUND's own lifecycle — `pending`, `succeeded` or `failed`. */
  readonly status: string;
  /**
   * Where the PAYMENT stands after this refund.
   *
   * On the refund response deliberately: a caller that has just refunded needs
   * to know whether the payment is now `partially_refunded` or `refunded`, and
   * making them re-read the intent to find out is a second round trip whose
   * answer can have moved on by the time it arrives.
   */
  readonly paymentStatus: string;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toRefundDTO(
  row: RefundRow,
  paymentIntentPublicId: string,
  paymentStatus: string,
): RefundDTO {
  return {
    id: row.publicId,
    object: "refund",
    externalRef: row.externalRef,
    paymentIntentId: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    paymentStatus,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sendProviderError(res: Response, error: ProviderError): void {
  sendError(
    res,
    error.retryable ? 502 : 422,
    error.retryable ? "api_error" : "invalid_request_error",
    redactProviderMessage(error.message),
  );
}

export function createRefundsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.post(
    "/v1/refunds",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = createRefundBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(
          res,
          422,
          "invalid_request_error",
          parsed.error.issues[0]?.message ?? "invalid body",
        );
        return;
      }
      const body = parsed.data;
      const db = getDb();

      const intent = await findIntentByPublicId(db, body.paymentIntentId);
      if (!intent || intent.merchantId !== merchant.id) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
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
      const existing = await findRefundByExternalRef(db, merchant.id, body.externalRef);
      if (existing) {
        res.status(200).json(toRefundDTO(existing, intent.publicId, intent.status));
        return;
      }

      try {
        const { refund, created, paymentStatus } = await createRefund({
          merchantId: merchant.id,
          intent,
          externalRef: body.externalRef,
          amount: body.amount,
        });
        res
          .status(created ? 201 : 200)
          .json(toRefundDTO(refund, intent.publicId, paymentStatus));
      } catch (error) {
        if (
          error instanceof PaymentNotRefundableError ||
          error instanceof RefundExceedsRemainingError
        ) {
          sendError(res, 422, "invalid_request_error", error.message);
          return;
        }
        if (error instanceof RefundsUnavailableError) {
          sendError(res, 503, "api_error", error.message);
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
   * The remaining figure is offered because otherwise every merchant computes
   * it themselves by summing this list — and the ones who forget that a
   * `pending` or `failed` refund moved no money would compute it wrong, in the
   * direction that refuses a legitimate refund.
   */
  router.get(
    "/v1/payment_intents/:intentId/refunds",
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
      if (!intent || intent.merchantId !== merchant.id) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      const rows = await listRefundsForIntent(db, intent.id);
      res.status(200).json({
        object: "list",
        data: rows.map((row) => toRefundDTO(row, intent.publicId, intent.status)),
        remainingRefundable: await remainingRefundable(intent),
      });
    }),
  );

  return router;
}
