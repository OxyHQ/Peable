/**
 * Risk rules, their evaluations and reviews (ADR 0022) — every request schema
 * is the contract's (`@peable.to/contracts` `radarRoutes`); the dashboard's
 * reads add only its Test/Live toggle. Listed once as data and mounted on the
 * merchant API and on Orbit's dashboard (`catalogRoutes.ts`), where every write
 * is `money` (ADR 0022 D7).
 *
 * Orbit's rule editor also gets two read-only dashboard routes that are not
 * contracts: validate a predicate as it is typed, and preview it against
 * recent payments.
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import {
  approveReviewParams,
  createRadarRuleParams,
  expandOnlyQuery,
  listRadarEvaluationsQuery,
  listRadarRulesQuery,
  listReviewsQuery,
  refuseReviewParams,
  updateRadarRuleParams,
} from '@peable.to/contracts';
import { RADAR_FACTS, RADAR_LIMITS } from '@peable.to/shared-types';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { getDb } from '../db/postgres';
import {
  findRadarEvaluationForMerchant,
  findRadarRuleForMerchant,
  findReviewForMerchant,
  listRadarEvaluations,
  listRadarRules,
  listReviews,
} from '../db/radar/radarRepository';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceQuery,
} from '../lib/list';
import { toRadarEvaluationDTO, toRadarRuleDTO, toReviewDTO } from '../lib/serializeRadar';
import { toUnix } from '../lib/time';
import { RadarError } from '../services/radar/errors';
import { compileRule, RadarRuleError } from '../services/radar/language';
import { approveReview, refuseReview } from '../services/radar/reviews';
import { createRule, deleteRule, previewPredicate, updateRule } from '../services/radar/rules';
import { answerObject, idParam, parseBody } from './billingEngine/helpers';
import type { CatalogRoute } from './catalogRoutes';
import type { DashboardGate } from './dashboardAccess';
import { sendCatalogError } from './catalogRoutes';

const rulesQuery = surfaceQuery(listRadarRulesQuery);
const evaluationsQuery = surfaceQuery(listRadarEvaluationsQuery);
const reviewsQuery = surfaceQuery(listReviewsQuery);
const retrieveQuery = surfaceQuery(expandOnlyQuery);

async function answerRule(
  res: Response,
  merchant: MerchantRow,
  publicId: string,
  expand?: readonly string[],
) {
  const row = await findRadarRuleForMerchant(getDb(), publicId, merchant.id);
  if (!row) throw new RadarError('resource_missing', 'risk rule not found', undefined, 404);
  await answerObject(res, merchant, 'radar.rule', toRadarRuleDTO(row), expand);
}

async function answerReview(
  res: Response,
  merchant: MerchantRow,
  publicId: string,
  expand?: readonly string[],
) {
  const row = await findReviewForMerchant(getDb(), publicId, merchant.id);
  if (!row) throw new RadarError('resource_missing', 'review not found', undefined, 404);
  await answerObject(res, merchant, 'review', toReviewDTO(row), expand);
}

async function create(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, createRadarRuleParams);
  if (!body) return;
  const row = await createRule(merchant, {
    action: body.action,
    predicate: body.predicate,
    description: body.description,
    enabled: body.enabled,
  });
  await answerRule(res, merchant, row.publicId, body.expand);
}

async function list(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const query = parseQuery(req, res, rulesQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'radar.rule',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findRadarRuleForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listRadarRules(db, {
        merchantId: merchant.id,
        page,
        action: query.action,
        enabled: query.enabled,
      }),
    serialize: toRadarRuleDTO,
  });
}

async function retrieve(req: Request, res: Response, merchant: MerchantRow, surface: QuerySurface) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  await answerRule(res, merchant, id, query.expand);
}

async function update(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, updateRadarRuleParams);
  if (!body) return;
  const row = await updateRule(merchant, id, {
    action: body.action,
    predicate: body.predicate,
    description: body.description,
    enabled: body.enabled,
  });
  await answerRule(res, merchant, row.publicId, body.expand);
}

async function remove(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const row = await deleteRule(merchant, id);
  res.status(200).json({ id: row.publicId, object: 'radar.rule', deleted: true });
}

async function listEvaluations(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const query = parseQuery(req, res, evaluationsQuery[surface]);
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
    type: 'radar.evaluation',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findRadarEvaluationForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listRadarEvaluations(db, { merchantId: merchant.id, page, paymentIntentId: intent.id }),
    serialize: toRadarEvaluationDTO,
  });
}

async function listReviewQueue(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const query = parseQuery(req, res, reviewsQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'review',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findReviewForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) => listReviews(db, { merchantId: merchant.id, page, open: query.open }),
    serialize: toReviewDTO,
  });
}

async function retrieveReview(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQuery[surface]);
  if (!query) return;
  await answerReview(res, merchant, id, query.expand);
}

async function approve(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, approveReviewParams);
  if (!body) return;
  const row = await approveReview(merchant, id);
  await answerReview(res, merchant, row.publicId, body.expand);
}

async function refuse(req: Request, res: Response, merchant: MerchantRow) {
  const id = idParam(req, res);
  if (!id) return;
  const body = parseBody(req, res, refuseReviewParams);
  if (!body) return;
  const row = await refuseReview(merchant, id, body.reason);
  await answerReview(res, merchant, row.publicId, body.expand);
}

export const RADAR_ROUTES: readonly CatalogRoute[] = [
  { method: 'post', path: '/radar/rules', core: create },
  { method: 'get', path: '/radar/rules', core: list },
  { method: 'get', path: '/radar/rules/:id', core: retrieve },
  { method: 'post', path: '/radar/rules/:id', core: update },
  { method: 'delete', path: '/radar/rules/:id', core: remove },
  { method: 'get', path: '/radar/evaluations', core: listEvaluations },
  { method: 'get', path: '/reviews', core: listReviewQueue },
  { method: 'get', path: '/reviews/:id', core: retrieveReview },
  { method: 'post', path: '/reviews/:id/approve', core: approve },
  { method: 'post', path: '/reviews/:id/refuse', core: refuse },
];

/** Orbit's editor: one predicate, as typed. */
const predicateBody = z
  .object({ predicate: z.string().max(RADAR_LIMITS.predicateMax * 2) })
  .strict();

/**
 * `POST …/radar/rules/validate` — whether a predicate parses, and where it
 * does not. Always 200: an invalid predicate is the answer, not an error.
 */
async function validate(req: Request, res: Response) {
  const body = parseBody(req, res, predicateBody);
  if (!body) return;
  try {
    const compiled = compileRule(body.predicate);
    const facts = [...compiled.facts].sort();
    res.status(200).json({
      valid: true,
      facts,
      // A rule over the provider's outcome only judges after authorization; one
      // over the card, before authorization only at a server confirm with a
      // saved card (the payer's credential is handed out before any card).
      post_authorization_only: facts.some((fact) => !RADAR_FACTS[fact].preAuthorization),
      saved_card_only:
        facts.some((fact) => !RADAR_FACTS[fact].withoutCard) &&
        facts.every((fact) => RADAR_FACTS[fact].preAuthorization),
    });
  } catch (error) {
    if (!(error instanceof RadarRuleError)) throw error;
    res.status(200).json({ valid: false, message: error.reason, position: error.position });
  }
}

/** `POST …/radar/rules/preview` — the predicate, unsaved, over recent card payments. */
async function preview(req: Request, res: Response, merchant: MerchantRow) {
  const body = parseBody(req, res, predicateBody);
  if (!body) return;
  const result = await previewPredicate(merchant, body.predicate);
  res.status(200).json({
    evaluated: result.evaluated,
    matched: result.matched.map((match) => ({
      payment_intent: match.paymentIntent,
      amount: match.amount,
      currency: match.currency,
      created: toUnix(match.created),
      facts: match.facts,
    })),
  });
}

/**
 * Mount the editor's two dashboard-only routes. Both write nothing, so both are
 * `read`. Mounted BEFORE the shared routes: `…/radar/rules/validate` must not
 * reach `…/radar/rules/:id`.
 */
export function mountRadarDashboardRoutes(
  router: Router,
  deps: {
    readonly base: string;
    readonly requireOxyUser: RequestHandler;
    readonly gate: DashboardGate;
  },
): void {
  const run =
    (core: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>) =>
    async (req: Request, res: Response, merchant: MerchantRow) => {
      try {
        await core(req, res, merchant);
      } catch (error) {
        sendCatalogError(res, error);
      }
    };
  router.post(
    `${deps.base}/radar/rules/validate`,
    deps.requireOxyUser,
    deps.gate(
      'read',
      run((req, res) => validate(req, res)),
    ),
  );
  router.post(
    `${deps.base}/radar/rules/preview`,
    deps.requireOxyUser,
    deps.gate('read', run(preview)),
  );
}
