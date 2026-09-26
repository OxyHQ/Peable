/**
 * The refund surface: `/v1/refunds`.
 *
 * Merchant-authed, merchant-scoped, and the one route in this API where a
 * duplicate is unrecoverable: a payer sent their money twice has no reason to
 * report it, and nothing reverses the second automatically. Every path here
 * converges on the merchant's own refund id rather than erroring.
 */
import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { oxy } from "../oxy";
import {
  isBaseUnitString,
  type Refund,
  type Settlement,
} from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import {
  findIntentByPublicId,
  findIntentForMerchant,
} from "../db/payments/paymentIntentRepository";
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
import { EnvironmentModeMismatchError } from "../services/providers/environmentGuard";
import { reportSettlement } from "../services/settlementReport";
import { ProviderError } from "../services/providers/provider";
import {
  requireAuthenticated,
  requireProviderMode,
  sendEnvironmentMismatch,
  sendError,
  sendProviderError,
  wrap,
} from "../lib/http";
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

/**
 * The wire shape, published in `@peable.to/shared-types` — the provider's own
 * refund id never appears in it.
 *
 * Declared there rather than here so the SDK and an integrator's own adapter
 * describe this response ONCE. Two private copies of a wire format in two
 * repositories is how a renamed field becomes a runtime failure somebody else
 * discovers.
 */
function toRefundDTO(
  row: RefundRow,
  paymentIntentPublicId: string,
  paymentStatus: string,
): Refund {
  return {
    id: row.publicId,
    object: "refund",
    externalRef: row.externalRef,
    origin: row.origin,
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

export function createRefundsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  router.post(
    "/v1/refunds",
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      // BEFORE the intent lookup, whose 404 would otherwise let a wrong-mode
      // credential probe which `pi_…` values this merchant owns.
      if (!requireProviderMode(merchant.environment, res)) return;

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
      if (existing && (existing.providerObjectId !== null || existing.status === "failed")) {
        res.status(200).json(toRefundDTO(existing, intent.publicId, intent.status));
        return;
      }

      try {
        const { refund, created, paymentStatus } = await createRefund({
          merchantId: merchant.id,
          environment: merchant.environment,
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
    "/v1/payment_intents/:intentId/settlement",
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

      // Scoped in the PREDICATE, not compared after the read: a payment that
      // does not exist and one belonging to another merchant are the same
      // answer, so neither the row nor its absence can confirm an id.
      const intent = await findIntentForMerchant(getDb(), intentId, merchant.id);
      if (!intent) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      const settlement = await reportSettlement(intent);
      const body: Settlement = {
        object: "settlement",
        paymentIntentId: intent.publicId,
        ...settlement,
      };
      res.status(200).json(body);
    }),
  );

  return router;
}
