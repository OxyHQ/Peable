/**
 * The dispute surface — Stripe's: retrieve, list, update (stage evidence, or
 * submit it ONCE), close (accept).
 *
 * A dispute is initiated by the card network, so the writes here are the
 * merchant's RESPONSE. `services/disputeEvidence.ts` carries the rules: a draft
 * lives at the provider and Peable keeps none of its words; files are the
 * merchant's `file_…` uploads, their bytes forwarded only at submission; a
 * response is submitted once and a second one is refused.
 *
 * Every handler is a core `(req, res, merchant, surface)` shared by the
 * service-authed routes below and the dashboard's (`routes/dashboard.ts`).
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  type DisputeEvidence,
  closeDisputeParams,
  expandOnlyQuery,
  listDisputesQuery,
  listPaymentIntentDisputesQuery,
  updateDisputeParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { findChargeForMerchant } from '../db/payments/chargeRepository';
import {
  findDisputeByPublicId,
  listDisputesForMerchant,
  type DisputeRow,
} from '../db/disputes/disputeRepository';
import {
  closeDispute,
  DisputeNotAnswerableError,
  DisputeParameterError,
  DisputesUnanswerableError,
  readDisputeEvidence,
  updateDispute,
} from '../services/disputeEvidence';
import type { OxyFilesClient } from '../services/oxyFiles/client';
import { oxyFilesClient } from '../services/oxyFiles/client';
import { FileStorageUnavailableError } from '../services/files';
import { ProviderError } from '../services/providers/provider';
import { toDisputeDTO, toSettlementDTO } from '../lib/serialize';
import { reportDisputeSettlement } from '../services/settlementReport';
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
import {
  answerList,
  completeList,
  dashboardQuery,
  parseQuery,
  type QuerySurface,
  resolveListReference,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

/** The contract's queries, and the dashboard's (the same plus its Test/Live `environment`). */
const listDisputesQueries = {
  api: listDisputesQuery,
  dashboard: dashboardQuery(listDisputesQuery),
} as const;
const retrieveDisputeQueries = {
  api: expandOnlyQuery,
  dashboard: dashboardQuery(expandOnlyQuery),
} as const;

function sendNotFound(res: Response): void {
  sendError(res, 404, 'invalid_request_error', 'dispute not found', 'resource_missing', 'id');
}

async function loadDispute(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<DisputeRow | null> {
  const { disputeId } = req.params;
  if (!disputeId) {
    sendError(res, 400, 'invalid_request_error', 'disputeId is required');
    return null;
  }
  // ONE 404 for "does not exist" and "is not yours", scoped in the predicate.
  const dispute = await findDisputeByPublicId(getDb(), merchant.id, disputeId);
  if (!dispute) sendNotFound(res);
  return dispute;
}

async function intentPublicIdOf(dispute: DisputeRow): Promise<string> {
  const intent = await findIntentById(getDb(), dispute.paymentIntentId);
  if (!intent) {
    // `disputes.payment_intent_id` carries a foreign key with `on delete
    // restrict`; stated so loosening it fails loudly.
    throw new Error(`dispute ${dispute.publicId} names an intent that cannot be read`);
  }
  return intent.publicId;
}

/** Answer a service error, or rethrow what is not one. */
function sendDisputeError(res: Response, error: unknown): void {
  if (error instanceof DisputeNotAnswerableError) {
    // 409: well-formed, and the dispute is not in a state that takes it —
    // answered, closed, or past its deadline. No edit of the body fixes that.
    sendError(res, 409, 'invalid_request_error', error.message, error.code);
    return;
  }
  if (error instanceof DisputeParameterError) {
    sendError(res, 400, 'invalid_request_error', error.message, 'parameter_invalid', error.param);
    return;
  }
  if (error instanceof DisputesUnanswerableError || error instanceof FileStorageUnavailableError) {
    sendError(res, 503, 'api_error', error.message);
    return;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return;
  }
  throw error;
}

/** `GET /v1/disputes`: every dispute of the merchant, or of one payment or charge. */
export async function answerDisputeList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listDisputesQueries[surface]);
  if (!query) return;
  const db = getDb();
  const byIntent = await resolveListReference(
    res,
    'payment_intent',
    query.payment_intent,
    async (publicId) => (await findIntentForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!byIntent.ok) return;
  // A charge is one card payment's authorization: its disputes are its payment's.
  const byCharge = await resolveListReference(
    res,
    'charge',
    query.charge,
    async (publicId) =>
      (await findChargeForMerchant(db, publicId, merchant.id))?.paymentIntentId ?? null,
  );
  if (!byCharge.ok) return;
  if (byIntent.id !== undefined && byCharge.id !== undefined && byIntent.id !== byCharge.id) {
    // A payment and a charge that are not each other's: nothing matches both.
    res.status(200).json(completeList(req, []));
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
        paymentIntentId: byIntent.id ?? byCharge.id,
        page,
      }),
    serialize: (row) => toDisputeDTO(row, row.paymentIntentPublicId),
  });
}

/**
 * `GET /v1/disputes/:id` — the one read that carries `evidence`, read live:
 * the text from the provider (where a draft lives), the files from here.
 */
export async function retrieveDispute(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, retrieveDisputeQueries[surface]);
  if (!query) return;
  const expand = parseExpand(res, 'dispute', query.expand, { list: false });
  if (!expand) return;
  const dispute = await loadDispute(req, res, merchant);
  if (!dispute) return;

  let evidence: DisputeEvidence | undefined;
  try {
    evidence = await readDisputeEvidence(dispute);
  } catch (error) {
    // A mode this deployment holds no key for can still SHOW its disputes —
    // without the evidence only the provider holds.
    if (!(error instanceof DisputesUnanswerableError)) {
      sendDisputeError(res, error);
      return;
    }
  }
  const dto = toDisputeDTO(dispute, await intentPublicIdOf(dispute), evidence);
  await expandObjects([dto], 'dispute', expand, merchant.id);
  res.status(200).json(dto);
}

/**
 * `GET /v1/disputes/:id/settlement` — what the dispute WITHDREW from the
 * settlement balance: `gross` the principal, `fee` the dispute fee, a negative
 * `net`, in the settlement currency. An inquiry moves no money and is
 * `unknown` with every figure `null`, never `0`.
 */
export async function retrieveDisputeSettlement(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const query = parseQuery(req, res, expandOnlyQuery);
  if (!query) return;
  const expand = parseExpand(res, 'settlement', query.expand, { list: false });
  if (!expand) return;
  const dispute = await loadDispute(req, res, merchant);
  if (!dispute) return;

  const body = toSettlementDTO(await reportDisputeSettlement(dispute), {
    livemode: dispute.livemode,
    paymentIntentPublicId: await intentPublicIdOf(dispute),
    disputePublicId: dispute.publicId,
  });
  await expandObjects([body], 'settlement', expand, merchant.id);
  res.status(200).json(body);
}

/** `POST /v1/disputes/:id` — metadata, a draft, or the one submission. */
export async function updateDisputeCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  files: OxyFilesClient,
): Promise<void> {
  const parsed = updateDisputeParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const dispute = await loadDispute(req, res, merchant);
  if (!dispute) return;
  try {
    const result = await updateDispute({
      dispute,
      ...(parsed.data.evidence !== undefined ? { evidence: parsed.data.evidence } : {}),
      ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
      submit: parsed.data.submit === true,
      files,
    });
    res
      .status(200)
      .json(toDisputeDTO(result.dispute, await intentPublicIdOf(result.dispute), result.evidence));
  } catch (error) {
    sendDisputeError(res, error);
  }
}

/** `POST /v1/disputes/:id/close` — accept the dispute; it is lost. */
export async function closeDisputeCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = closeDisputeParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const dispute = await loadDispute(req, res, merchant);
  if (!dispute) return;
  try {
    const result = await closeDispute(dispute);
    res
      .status(200)
      .json(toDisputeDTO(result.dispute, await intentPublicIdOf(result.dispute), result.evidence));
  } catch (error) {
    sendDisputeError(res, error);
  }
}

export function createDisputesRouter(deps: {
  requireMerchant: RequestHandler;
  /** Oxy Files, to read evidence bytes at submission. Default: the real client. */
  files?: OxyFilesClient;
}): Router {
  const router = Router();
  const { requireMerchant } = deps;
  const files = deps.files ?? oxyFilesClient;
  const read = [requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const write = [requireMerchant, requireAuthenticated, requireScope('payments:write')];
  const withMerchant = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await handler(req, res, merchant);
    });

  router.get(
    '/v1/payment_intents/:intentId/disputes',
    ...read,
    withMerchant(async (req, res, merchant) => {
      const { intentId } = req.params;
      if (!intentId) {
        sendError(res, 400, 'invalid_request_error', 'intentId is required');
        return;
      }
      const query = parseQuery(req, res, listPaymentIntentDisputesQuery);
      if (!query) return;
      const db = getDb();
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
  router.get('/v1/disputes', ...read, withMerchant(answerDisputeList));
  router.get('/v1/disputes/:disputeId', ...read, withMerchant(retrieveDispute));
  router.get(
    '/v1/disputes/:disputeId/settlement',
    ...read,
    withMerchant(retrieveDisputeSettlement),
  );
  router.post(
    '/v1/disputes/:disputeId',
    ...write,
    idempotent,
    withMerchant((req, res, merchant) => updateDisputeCore(req, res, merchant, files)),
  );
  router.post(
    '/v1/disputes/:disputeId/close',
    ...write,
    idempotent,
    withMerchant(closeDisputeCore),
  );
  return router;
}
