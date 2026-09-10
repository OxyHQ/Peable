/**
 * The settlement surface: `/v1/transfers`.
 *
 * Merchant-authed, and every lookup is scoped to the merchant resolved from the
 * credential rather than filtered afterwards — "find by id, then check the
 * owner" is the shape that leaks one marketplace's settlements to another the
 * day someone forgets the second half.
 *
 * The amounts here come from the merchant and are recorded, never computed.
 * This router does not know what a marketplace fee is and must not learn.
 */
import { Router } from "express";
import type { Response, RequestHandler } from "express";
import { z } from "zod";
import { oxyClient } from "@oxy.so/core";
import { isBaseUnitString } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import {
  findAccountById,
  findAccountByExternalRef,
  findAccountByPublicId,
  type ConnectedAccountRow,
} from "../db/accounts/connectedAccountRepository";
import { findIntentById, findIntentByPublicId } from "../db/payments/paymentIntentRepository";
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import {
  findTransferByExternalRef,
  findTransferByPublicId,
  listTransfersForIntent,
  TransferReversalTooLargeError,
  type TransferRow,
} from "../db/transfers/transferRepository";
import {
  AccountNotPayableError,
  createTransfer,
  PaymentNotSettledError,
  reverseTransfer,
  TransfersUnavailableError,
} from "../services/transfers/transferService";
import { ProviderError } from "../services/providers/provider";
import { redactProviderMessage } from "../services/providers/redact";
import { toTransferDTO, type TransferDTO } from "../lib/serializeSettlement";
import { requireAuthenticated, sendError, wrap } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

/**
 * A canonical base-unit integer string, validated with the SAME predicate the
 * database CHECK is rendered from. A `z.number()` here would be a silent
 * precision ceiling on a money value, which is the whole reason these are
 * strings on the wire.
 */
const baseUnitAmount = z
  .string()
  .refine(
    isBaseUnitString,
    "amount must be a canonical integer string in the currency's smallest unit",
  );

const createTransferBodySchema = z
  .object({
    /** The `pi_…` this settles out of. */
    paymentIntentId: z.string().min(1),
    /** Either address for the seller — their `ca_…` or the merchant's own ref. */
    connectedAccountId: z.string().min(1).optional(),
    connectedAccountRef: z.string().min(1).max(255).optional(),
    /** The merchant's own id for what this settles. The idempotency. */
    externalRef: z.string().min(1).max(255),
    amount: baseUnitAmount,
  })
  .refine(
    (body) => Boolean(body.connectedAccountId) !== Boolean(body.connectedAccountRef),
    { message: "name the seller by exactly one of connectedAccountId or connectedAccountRef" },
  );

const reverseTransferBodySchema = z.object({ amount: baseUnitAmount });

function sendProviderError(res: Response, error: ProviderError): void {
  // 502 for a retryable provider fault, 422 for a permanent refusal. The
  // distinction is the merchant's to act on: one means try again, the other
  // means the request as sent will never work.
  sendError(
    res,
    error.retryable ? 502 : 422,
    error.retryable ? "api_error" : "invalid_request_error",
    redactProviderMessage(error.message),
  );
}

/**
 * Serialize a transfer, resolving the two PUBLIC ids it references.
 *
 * Both come from the STORED row, never from the request that produced it. A
 * response echoing the caller's own `pi_…` and seller back would confirm a
 * settlement to whoever asked about it, whether or not those were the ones the
 * transfer actually names.
 */
async function serializeTransfer(
  merchantId: string,
  transfer: TransferRow,
  intent: PaymentIntentRow,
  account?: ConnectedAccountRow,
): Promise<TransferDTO> {
  const seller = account ?? (await findAccountById(getDb(), merchantId, transfer.connectedAccountId));
  if (!seller) {
    // Structurally unreachable: `transfers.connected_account_id` carries a
    // foreign key and both rows belong to this merchant. Stated rather than
    // asserted away, so a future change that loosens either fails loudly
    // instead of emitting an empty id onto the wire.
    throw new Error(`transfer ${transfer.publicId} names an account that cannot be read`);
  }
  return toTransferDTO(transfer, seller.publicId, intent.publicId);
}

export function createTransfersRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;

  /**
   * Settle one seller out of a funded payment.
   *
   * 200 for an order already settled, 201 for a new settlement. The
   * distinction matters more here than anywhere else in this API: a merchant
   * retrying after a timeout needs to know whether they just paid a seller a
   * second time. They did not, and the status code says so.
   */
  router.post(
    "/v1/transfers",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = createTransferBodySchema.safeParse(req.body);
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
      // ONE 404 for "does not exist" and for "is not yours". Distinguishing
      // them tells a caller whether another merchant's `pi_…` is real.
      if (!intent || intent.merchantId !== merchant.id) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      /**
       * The idempotency check comes BEFORE the seller's readiness is examined.
       *
       * A retry of an order that already settled is a question about history:
       * the money moved, and the answer must not change because the seller's
       * account has since been restricted. Checking readiness first would turn
       * a successful settlement into a 422 on its own retry.
       */
      const existing = await findTransferByExternalRef(db, merchant.id, body.externalRef);
      if (existing) {
        res.status(200).json(await serializeTransfer(merchant.id, existing, intent));
        return;
      }

      const account = body.connectedAccountId
        ? await findAccountByPublicId(db, merchant.id, body.connectedAccountId)
        : await findAccountByExternalRef(db, merchant.id, body.connectedAccountRef ?? "");
      if (!account) {
        sendError(res, 404, "invalid_request_error", "connected account not found");
        return;
      }

      try {
        const { transfer, created } = await createTransfer({
          merchantId: merchant.id,
          intent,
          account,
          externalRef: body.externalRef,
          amount: body.amount,
          // From the INTENT, never the request: a transfer in a different
          // currency from the charge is an FX conversion nothing here performs.
          currency: intent.currency,
        });
        res
          .status(created ? 201 : 200)
          .json(await serializeTransfer(merchant.id, transfer, intent, account));
      } catch (error) {
        if (error instanceof PaymentNotSettledError || error instanceof AccountNotPayableError) {
          sendError(res, 422, "invalid_request_error", error.message);
          return;
        }
        if (error instanceof TransfersUnavailableError) {
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

  /** Take some or all of a settlement back. */
  router.post(
    "/v1/transfers/:transferId/reversals",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const parsed = reverseTransferBodySchema.safeParse(req.body);
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
      const { transferId } = req.params;
      if (!transferId) {
        sendError(res, 422, "invalid_request_error", "transferId is required");
        return;
      }

      const transfer = await findTransferByPublicId(db, merchant.id, transferId);
      if (!transfer) {
        sendError(res, 404, "invalid_request_error", "transfer not found");
        return;
      }

      try {
        const updated = await reverseTransfer({ transfer, amount: parsed.data.amount });
        const intent = await findIntentByPublicIdForTransfer(db, updated);
        res.status(201).json(await serializeTransfer(merchant.id, updated, intent));
      } catch (error) {
        if (error instanceof TransferReversalTooLargeError) {
          sendError(res, 422, "invalid_request_error", error.message);
          return;
        }
        if (error instanceof TransfersUnavailableError) {
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

  /** What one payment settled. The reconciliation read. */
  router.get(
    "/v1/payment_intents/:intentId/transfers",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:read"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const db = getDb();
      const { intentId } = req.params;
      if (!intentId) {
        sendError(res, 422, "invalid_request_error", "intentId is required");
        return;
      }

      const intent = await findIntentByPublicId(db, intentId);
      if (!intent || intent.merchantId !== merchant.id) {
        sendError(res, 404, "invalid_request_error", "payment intent not found");
        return;
      }

      const rows = await listTransfersForIntent(db, intent.id);
      const data = await Promise.all(
        rows.map((row) => serializeTransfer(merchant.id, row, intent)),
      );
      res.status(200).json({ object: "list", data });
    }),
  );

  return router;
}

/**
 * The intent behind a transfer, by the transfer's stored internal id.
 *
 * A separate read because the reversal route holds a transfer and not an
 * intent, and the DTO promises the intent's `pi_…`. Reaching for the internal
 * id and emitting it would put a uuid on a shipped contract.
 */
async function findIntentByPublicIdForTransfer(
  db: ReturnType<typeof getDb>,
  transfer: TransferRow,
): Promise<PaymentIntentRow> {
  const intent = await findIntentById(db, transfer.paymentIntentId);
  if (!intent) {
    // `transfers.payment_intent_id` carries a foreign key with `on delete
    // restrict`, so this cannot happen while that constraint stands.
    throw new Error(`transfer ${transfer.publicId} names an intent that cannot be read`);
  }
  return intent;
}
