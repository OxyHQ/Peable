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
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { isBaseUnitString, type TransferWithReversal } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import {
  findAccountById,
  findAccountByExternalRef,
  findAccountByPublicId,
  type ConnectedAccountRow,
} from '../db/accounts/connectedAccountRepository';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import {
  findTransferByExternalRef,
  findTransferByPublicId,
  listTransfersForMerchant,
  TransferReversalTooLargeError,
  type TransferRow,
} from '../db/transfers/transferRepository';
import {
  AccountNotPayableError,
  createTransfer,
  PaymentNotSettledError,
  reverseTransfer,
  TransferExceedsPaymentError,
  TransferSourceUnresolvedError,
  TransfersUnavailableError,
} from '../services/transfers/transferService';
import { EnvironmentModeMismatchError } from '../services/providers/environmentGuard';
import { ProviderError } from '../services/providers/provider';
import { toTransferDTO, type TransferDTO } from '../lib/serializeSettlement';
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
import { toUnix } from '../lib/time';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  listQuerySchema,
  parseQuery,
  resolveListReference,
  retrieveQuerySchema,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

/** `GET /v1/transfers`: every settlement, or those of one payment and/or one seller. */
const listTransfersQuery = listQuerySchema({
  payment_intent: z.string().min(1).max(255).optional(),
  connected_account: z.string().min(1).max(255).optional(),
});
/** The per-payment sub-list: the payment is in the path. */
const listIntentTransfersQuery = listQuerySchema({});
const retrieveTransferQuery = retrieveQuerySchema({});

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
  )
  // `'0'` is a canonical integer string and passes the predicate above, and a
  // zero transfer is not a transfer: it would consume the merchant's
  // `external_ref`, so the REAL settlement of that order could never be created
  // afterwards. The refund route refuses a zero for the same reason.
  .refine((value) => value !== '0', 'a transfer of 0 is not a transfer');

const createTransferBodySchema = z
  .object({
    /** The `pi_…` this settles out of. */
    payment_intent: z.string().min(1),
    /** Either address for the seller — their `ca_…` or the merchant's own ref. */
    connected_account: z.string().min(1).optional(),
    connected_account_ref: z.string().min(1).max(255).optional(),
    /** The merchant's own id for what this settles. The idempotency. */
    external_ref: z.string().min(1).max(255),
    amount: baseUnitAmount,
  })
  .strict()
  .refine((body) => Boolean(body.connected_account) !== Boolean(body.connected_account_ref), {
    message: 'name the seller by exactly one of connected_account or connected_account_ref',
  });

const reverseTransferBodySchema = z
  .object({
    amount: baseUnitAmount,
    /**
     * The merchant's own id for THIS reversal — required, and durable.
     *
     * An amount is not an identity: two reversals of one settlement for the
     * same amount are two operations. This field is what tells them apart, for
     * as long as the reversal exists. It used to be satisfiable by the
     * `Idempotency-Key` header instead; that header is now the generic
     * 24-hour retry layer (ADR 0014 D3), which the SDK fills with a fresh uuid
     * per call — accepting it here would hand every un-referenced reversal a
     * random identity, and an application's own retry a second reversal.
     */
    external_ref: z.string().min(1).max(255),
  })
  .strict();

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
  const seller =
    account ?? (await findAccountById(getDb(), merchantId, transfer.connectedAccountId));
  if (!seller) {
    // Structurally unreachable: `transfers.connected_account_id` carries a
    // foreign key and both rows belong to this merchant. Stated rather than
    // asserted away, so a future change that loosens either fails loudly
    // instead of emitting an empty id onto the wire.
    throw new Error(`transfer ${transfer.publicId} names an account that cannot be read`);
  }
  return toTransferDTO(transfer, seller.publicId, intent.publicId);
}

/**
 * Why a stored settlement and a new request naming the same `external_ref` are
 * not the same operation — or `null` when they are.
 *
 * Deliberately does NOT compare the seller: the stored row holds an internal
 * account id and the request may name the seller by either address, so the
 * comparison would need a lookup whose only purpose is to produce an error. The
 * payment and the amount are what decide whether money is being moved
 * differently, and both are on the row.
 */
function transferReplayConflict(
  existing: TransferRow,
  body: { readonly payment_intent: string; readonly amount: string },
  requestedIntent: PaymentIntentRow,
): string | null {
  if (existing.paymentIntentId !== requestedIntent.id) {
    return `${body.payment_intent} does not match the payment this settlement reference already names`;
  }
  if (existing.amount !== body.amount) {
    return `this settlement reference already names an amount of ${existing.amount}`;
  }
  return null;
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
    '/v1/transfers',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      // BEFORE the intent and seller lookups below, whose 404s would otherwise
      // let a wrong-mode credential enumerate this merchant's rows.
      if (!requireProviderMode(merchant.environment, res)) return;

      const parsed = createTransferBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const body = parsed.data;
      const db = getDb();

      // ONE 404 for "does not exist" and for "is not yours" — scoped in the
      // predicate. Distinguishing them tells a caller whether another
      // merchant's `pi_…` is real.
      const intent = await findIntentForMerchant(db, body.payment_intent, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      /**
       * The idempotency check comes BEFORE the seller's readiness is examined.
       *
       * A retry of an order that already settled is a question about history:
       * the money moved, and the answer must not change because the seller's
       * account has since been restricted. Checking readiness first would turn
       * a successful settlement into a 400 on its own retry.
       *
       * A settlement that never reached the provider is NOT history, so it does
       * not get that exemption: nothing moved, and a seller who can no longer
       * be paid should not be paid by a resume.
       */
      const existing = await findTransferByExternalRef(db, merchant.id, body.external_ref);
      if (existing) {
        /**
         * A reused reference naming a DIFFERENT operation is a conflict, not a
         * replay.
         *
         * `external_ref` is the merchant's own settlement id and the unique key
         * this table converges on. A second request carrying the same ref with
         * another payment, amount or seller is not the same operation, and
         * answering 200 with the stored row tells the caller their new
         * settlement succeeded when nothing happened at all — the shape that
         * loses a seller their money silently.
         */
        const conflict = transferReplayConflict(existing, body, intent);
        if (conflict) {
          sendError(res, 409, 'invalid_request_error', conflict);
          return;
        }
        /**
         * A FINISHED settlement is history and is answered as such. One that
         * never reached the provider falls THROUGH to be resumed.
         *
         * The distinction is `providerObjectId`, and it is the whole reason
         * this branch is not just "return what we have": a row left `pending`
         * by an interrupted attempt was answered 200 with a settlement that had
         * not happened, and no path ever retried it. `createTransfer` resumes
         * it under the same provider idempotency key, so the retry completes
         * the settlement rather than describing a seller who was not paid.
         */
        if (existing.providerObjectId !== null || existing.status === 'failed') {
          /**
           * Serialized against the STORED transfer's own intent, never the one
           * this request names.
           *
           * The two are the same here — the conflict check above has just
           * proven it — and that is exactly why reading it off the request was
           * invisible: it produced a correct answer until the day a caller
           * reused a ref, and then it produced a response describing a
           * settlement that does not exist, built from ids the caller had
           * supplied themselves.
           */
          const storedIntent = await findIntentByPublicIdForTransfer(db, existing);
          res.status(200).json(await serializeTransfer(merchant.id, existing, storedIntent));
          return;
        }
      }

      const account = body.connected_account
        ? await findAccountByPublicId(db, merchant.id, body.connected_account)
        : await findAccountByExternalRef(db, merchant.id, body.connected_account_ref ?? '');
      if (!account) {
        sendError(res, 404, 'invalid_request_error', 'connected account not found');
        return;
      }

      try {
        const { transfer, created } = await createTransfer({
          merchantId: merchant.id,
          environment: merchant.environment,
          intent,
          account,
          externalRef: body.external_ref,
          amount: body.amount,
          // From the INTENT, never the request: a transfer in a different
          // currency from the charge is an FX conversion nothing here performs.
          currency: intent.currency,
        });
        res
          .status(created ? 201 : 200)
          .json(await serializeTransfer(merchant.id, transfer, intent, account));
      } catch (error) {
        if (
          error instanceof PaymentNotSettledError ||
          error instanceof AccountNotPayableError ||
          // The settlement budget: this payment cannot fund what was asked for.
          // 400 rather than 409 — the request as sent will never work, and the
          // message says how much is left.
          error instanceof TransferExceedsPaymentError
        ) {
          sendError(res, 400, 'invalid_request_error', error.message);
          return;
        }
        // The gateway believes the payment settled and the PROVIDER reports no
        // captured charge. 409, because the two disagree about a fact rather
        // than the request being wrong: retrying after reconciliation is the
        // action, editing the body is not.
        if (error instanceof TransferSourceUnresolvedError) {
          sendError(res, 409, 'invalid_request_error', error.message);
          return;
        }
        if (error instanceof TransfersUnavailableError) {
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

  /** Take some or all of a settlement back. */
  router.post(
    '/v1/transfers/:transferId/reversals',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      if (!requireProviderMode(merchant.environment, res)) return;

      const parsed = reverseTransferBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }

      const db = getDb();
      const { transferId } = req.params;
      if (!transferId) {
        sendError(res, 400, 'invalid_request_error', 'transferId is required');
        return;
      }

      const transfer = await findTransferByPublicId(db, merchant.id, transferId);
      if (!transfer) {
        sendError(res, 404, 'invalid_request_error', 'transfer not found');
        return;
      }

      try {
        const {
          transfer: updated,
          reversal,
          created,
        } = await reverseTransfer({
          merchantId: merchant.id,
          environment: merchant.environment,
          transfer,
          externalRef: parsed.data.external_ref,
          amount: parsed.data.amount,
        });
        const intent = await findIntentByPublicIdForTransfer(db, updated);
        // 201 for a reversal just made, 200 for one that had already been made.
        // The distinction is the merchant's to act on for the same reason it is
        // on the settlement route: "did I just take another 500 off this
        // seller" is a question they will ask.
        const response: TransferWithReversal = {
          ...(await serializeTransfer(merchant.id, updated, intent)),
          reversal: {
            id: reversal.publicId,
            object: 'transfer_reversal',
            external_ref: reversal.externalRef,
            amount: reversal.amount,
            currency: reversal.currency,
            status: reversal.status,
            failure_message: reversal.failureMessage,
            created: toUnix(reversal.createdAt),
          },
        };
        res.status(created ? 201 : 200).json(response);
      } catch (error) {
        if (error instanceof TransferReversalTooLargeError) {
          sendError(res, 400, 'invalid_request_error', error.message);
          return;
        }
        if (error instanceof TransfersUnavailableError) {
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

  /**
   * Every settlement of the merchant, newest first — narrowed by
   * `payment_intent=pi_…` and/or `connected_account=ca_…`.
   */
  router.get(
    '/v1/transfers',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const query = parseQuery(req, res, listTransfersQuery);
      if (!query) return;

      const db = getDb();
      const intent = await resolveListReference(
        res,
        'payment_intent',
        query.payment_intent,
        async (publicId) => (await findIntentForMerchant(db, publicId, merchant.id))?.id ?? null,
      );
      if (!intent.ok) return;
      const account = await resolveListReference(
        res,
        'connected_account',
        query.connected_account,
        async (publicId) => (await findAccountByPublicId(db, merchant.id, publicId))?.id ?? null,
      );
      if (!account.ok) return;

      await answerList(req, res, {
        query,
        type: 'transfer',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findTransferByPublicId(db, merchant.id, publicId))?.id ?? null,
        fetch: (page) =>
          listTransfersForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            connectedAccountId: account.id,
            page,
          }),
        serialize: (row) =>
          toTransferDTO(row, row.connectedAccountPublicId, row.paymentIntentPublicId),
      });
    }),
  );

  /** One settlement, by `tr_…`, scoped to the merchant in the predicate. */
  router.get(
    '/v1/transfers/:transferId',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const { transferId } = req.params;
      if (!transferId) {
        sendError(res, 400, 'invalid_request_error', 'transferId is required');
        return;
      }
      const query = parseQuery(req, res, retrieveTransferQuery);
      if (!query) return;
      const expand = parseExpand(res, 'transfer', query.expand, { list: false });
      if (!expand) return;

      const db = getDb();
      const transfer = await findTransferByPublicId(db, merchant.id, transferId);
      if (!transfer) {
        sendError(res, 404, 'invalid_request_error', 'transfer not found');
        return;
      }
      const intent = await findIntentByPublicIdForTransfer(db, transfer);
      const dto = await serializeTransfer(merchant.id, transfer, intent);
      await expandObjects([dto], 'transfer', expand, merchant.id);
      res.status(200).json(dto);
    }),
  );

  /** What one payment settled. The reconciliation read. */
  router.get(
    '/v1/payment_intents/:intentId/transfers',
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
      const query = parseQuery(req, res, listIntentTransfersQuery);
      if (!query) return;

      const db = getDb();
      const intent = await findIntentForMerchant(db, intentId, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }

      await answerList(req, res, {
        query,
        type: 'transfer',
        merchantId: merchant.id,
        cursor: async (publicId) =>
          (await findTransferByPublicId(db, merchant.id, publicId))?.id ?? null,
        fetch: (page) =>
          listTransfersForMerchant(db, {
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            page,
          }),
        serialize: (row) =>
          toTransferDTO(row, row.connectedAccountPublicId, row.paymentIntentPublicId),
      });
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
