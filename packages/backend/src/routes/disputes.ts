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
import { z } from 'zod';
import {
  DISPUTE_FILE_EVIDENCE_FIELDS,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  type DisputeEvidence,
  type DisputeFileEvidenceField,
  type DisputeTextEvidenceField,
} from '@peable.to/shared-types';
import { oxy } from '../oxy';
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
import { toDisputeDTO } from '../lib/serialize';
import {
  requireAuthenticated,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { expandObjects, parseExpand } from '../lib/expand';
import { metadataUpdateSchema } from '../lib/metadata';
import {
  answerList,
  completeList,
  listQuerySchema,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

const listDisputesQuery = surfaceListQuery({
  payment_intent: z.string().min(1).max(255).optional(),
  charge: z.string().min(1).max(255).optional(),
});
/** The per-payment sub-list: the payment is in the path. */
const listIntentDisputesQuery = listQuerySchema({});
const retrieveDisputeQuery = surfaceRetrieveQuery();

/**
 * How long one TEXT evidence field may be — the provider's ceiling, restated
 * where the request is parsed, so an over-long field is refused here with its
 * name rather than at the acquirer during a one-shot submission.
 */
const EVIDENCE_FIELD_MAX = 20_000;
const FILE_ID_MAX = 255;

/** `""` unsets a field, as on Stripe. */
const textField = z.string().max(EVIDENCE_FIELD_MAX).optional();
const fileField = z.string().max(FILE_ID_MAX).optional();

/**
 * The evidence fields, in the network's names — a CLOSED set. Unknown keys are
 * REFUSED rather than dropped: a merchant who sent `tracking_number` instead of
 * `shipping_tracking_number` would otherwise submit, finally, a response missing
 * the field they relied on, and find out when the dispute is decided.
 */
const evidenceSchema = z
  .object({
    ...(Object.fromEntries(
      DISPUTE_TEXT_EVIDENCE_FIELDS.map((field) => [field, textField]),
    ) as Record<DisputeTextEvidenceField, typeof textField>),
    ...(Object.fromEntries(
      DISPUTE_FILE_EVIDENCE_FIELDS.map((field) => [field, fileField]),
    ) as Record<DisputeFileEvidenceField, typeof fileField>),
  })
  .strict();

const updateBodySchema = z
  .object({
    evidence: evidenceSchema.optional(),
    metadata: metadataUpdateSchema.optional(),
    submit: z.boolean().optional(),
  })
  .strict();

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
  const query = parseQuery(req, res, listDisputesQuery[surface]);
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
  const query = parseQuery(req, res, retrieveDisputeQuery[surface]);
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

/** `POST /v1/disputes/:id` — metadata, a draft, or the one submission. */
export async function updateDisputeCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  files: OxyFilesClient,
): Promise<void> {
  const parsed = updateBodySchema.safeParse(req.body ?? {});
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
  const parsed = z
    .object({})
    .strict()
    .safeParse(req.body ?? {});
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
  const read = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const write = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
  ];
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
      const query = parseQuery(req, res, listIntentDisputesQuery);
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
