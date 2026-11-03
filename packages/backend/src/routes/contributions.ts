import { Router, type RequestHandler } from 'express';
import { createOxyAuthMiddleware, type OxyAuthRequest } from '@oxy.so/core/server';
import {
  createContributionSchema,
  contributionOperationKeySchema,
  contributionPageQuerySchema,
  contributionPatchSchema,
  contributionLinkSchema,
  type ContributionCollection,
} from '@peable.to/contracts/contributions';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import {
  findLinkForMerchant,
  listLinksForMerchant,
  updatePaymentLink,
  type PaymentLinkRow,
} from '../db/payments/paymentLinkRepository';
import { createContributionLink, contributionRefunds } from '../db/payments/contributionRepository';
import { authorizeContributionOrganization } from '../services/contributionAccess';
import { resolveRail } from '../services/createIntent';
import { resolveMerchantByApp } from './paymentIntents';
import { newId } from '../lib/ids';
import { config } from '../config';
import { sendError, sendValidationError, wrap } from '../lib/http';
import { fromUnix, toUnix } from '../lib/time';
import { toContributionDetails } from '../lib/serialize';
import {
  findIntentForMerchant,
  listIntentsForMerchant,
  type PaymentIntentRow,
} from '../db/payments/paymentIntentRepository';
import { answerList } from '../lib/list';
function dto(row: PaymentLinkRow) {
  return contributionLinkSchema.parse({
    id: row.publicId,
    object: 'payment_link',
    amount: row.amount,
    currency: row.currency,
    network: row.network,
    active: row.active,
    url: `${config.checkoutBaseUrl}/l/${row.publicId}`,
    contribution: row.contribution ? toContributionDetails(row.contribution) : null,
    created: toUnix(row.createdAt),
  });
}
export function createContributionsRouter(
  deps: {
    requireOxyUser?: RequestHandler;
    authorize?: typeof authorizeContributionOrganization;
  } = {},
) {
  const router = Router();
  const auth = deps.requireOxyUser ?? createOxyAuthMiddleware(oxy);
  const authorize = deps.authorize ?? authorizeContributionOrganization;
  const root = '/v1/organizations/:organizationId/applications/:applicationId/contributions';
  router.use(root, auth, (req, res, next) => {
    void (async () => {
      const token = (req as OxyAuthRequest).accessToken;
      if (!token) {
        sendError(res, 401, 'authentication_error', 'Sign in to manage contributions');
        return;
      }
      const org = req.params.organizationId,
        app = req.params.applicationId;
      if (!org || !app) {
        sendError(res, 400, 'invalid_request_error', 'Organization and application are required');
        return;
      }
      try {
        if (!(await authorize(token, org, app))) {
          sendError(
            res,
            403,
            'permission_error',
            'Organization contribution management is not permitted',
          );
          return;
        }
      } catch {
        sendError(res, 503, 'api_error', 'Organization access cannot be verified');
        return;
      }
      const parsed = contributionPageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const merchant = await resolveMerchantByApp(app, parsed.data.environment, res);
      if (!merchant) return;
      res.locals.contribution = { org, app, merchant, query: parsed.data };
      next();
    })().catch(next);
  });
  router.post(
    root,
    wrap(async (req, res) => {
      const { org, merchant } = res.locals.contribution;
      const parsed = createContributionSchema.safeParse(req.body);
      const key = contributionOperationKeySchema.safeParse(req.header('Idempotency-Key'));
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      if (!key.success) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'A UUID Idempotency-Key header is required',
          'idempotency_key_invalid',
        );
        return;
      }
      const body = parsed.data;
      if (!merchant.network) {
        sendError(
          res,
          400,
          'invalid_request_error',
          'Register a watch-only FairCoin account for this application before creating contribution links',
        );
        return;
      }
      resolveRail(merchant, { rail: 'faircoin', currency: 'FAIR', network: merchant.network });
      const row = await createContributionLink(getDb(), {
        publicId: newId('link'),
        merchantId: merchant.id,
        oxyAppId: merchant.oxyAppId,
        environment: merchant.environment,
        rail: 'faircoin',
        currency: 'FAIR',
        network: merchant.network,
        amount: body.amount ?? '0',
        metadata: {},
        contributionKey: key.data,
        contribution: {
          organizationId: org,
          purpose: body.purpose,
          amountMode: body.amount_mode,
          // Stored as ISO-8601, the shape `payment_links.contribution` has
          // always held; the wire's Unix seconds are rendered back on the way out.
          expiresAt:
            body.expires_at === undefined || body.expires_at === null
              ? null
              : fromUnix(body.expires_at).toISOString(),
        },
      });
      if (row === 'expired') {
        sendError(res, 400, 'invalid_request_error', 'Expiry must be in the future');
        return;
      }
      if (!row) {
        sendError(
          res,
          409,
          'invalid_request_error',
          'This operation key belongs to a different contribution link',
        );
        return;
      }
      res.status(201).json(dto(row));
    }),
  );
  router.get(
    root,
    wrap(async (req, res) => {
      const { org, merchant, query } = res.locals.contribution;
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'payment_link',
        merchantId: merchant.id,
        // A cursor is resolved INSIDE the caller's scope — the merchant is
        // already this application and environment, and the link must be this
        // organization's — so another organization's id pages nothing and
        // reveals nothing: it is refused exactly like an id that does not exist.
        cursor: async (publicId) => {
          const cursor = await findLinkForMerchant(db, publicId, merchant.id);
          return cursor !== null && cursor.contribution?.organizationId === org ? cursor.id : null;
        },
        fetch: (page) =>
          listLinksForMerchant(db, {
            merchantId: merchant.id,
            contributionOrganizationId: org,
            page,
          }),
        serialize: dto,
      });
    }),
  );
  // POST, as every update on this API is; there is no PATCH.
  router.post(
    `${root}/:id`,
    wrap(async (req, res) => {
      const { org, merchant } = res.locals.contribution;
      const body = contributionPatchSchema.safeParse(req.body);
      if (!body.success || !req.params.id) {
        sendError(res, 400, 'invalid_request_error', 'Invalid link update');
        return;
      }
      const link = await findLinkForMerchant(getDb(), req.params.id, merchant.id);
      if (!link || link.contribution?.organizationId !== org) {
        sendError(res, 404, 'invalid_request_error', 'Contribution not found');
        return;
      }
      const updated = await updatePaymentLink(getDb(), link.publicId, merchant.id, body.data);
      if (typeof updated === 'string') throw new Error('Link disappeared');
      res.json(dto(updated));
    }),
  );
  router.get(
    `${root}/:id/collections`,
    wrap(async (req, res) => {
      const { org, merchant, query } = res.locals.contribution;
      if (!req.params.id) {
        sendError(res, 404, 'invalid_request_error', 'Contribution not found');
        return;
      }
      const link = await findLinkForMerchant(getDb(), req.params.id, merchant.id);
      if (!link || link.contribution?.organizationId !== org) {
        sendError(res, 404, 'invalid_request_error', 'Contribution not found');
        return;
      }
      const db = getDb();
      await answerList(req, res, {
        query,
        type: 'payment_intent',
        merchantId: merchant.id,
        // A collection is a `pi_…` minted from THIS link; any other id is refused.
        cursor: async (publicId) => {
          const cursor = await findIntentForMerchant(db, publicId, merchant.id);
          return cursor?.paymentLinkId === link.id ? cursor.id : null;
        },
        fetch: (page) =>
          listIntentsForMerchant(db, { merchantId: merchant.id, paymentLinkId: link.id, page }),
        serialize: async (row: PaymentIntentRow): Promise<ContributionCollection> => ({
          id: row.publicId,
          object: 'payment_intent',
          amount: row.amount,
          // Structurally FAIR: a contribution link is faircoin-only
          // (`payment_links_contribution_shape`) and every intent it mints
          // inherits that rail, whose currency is FAIR.
          currency: 'FAIR',
          status: row.status,
          created: toUnix(row.createdAt),
          refund_capability: 'unsupported_non_custodial',
          refunds: (await contributionRefunds(db, row.id)).map((r) => ({
            id: r.id,
            object: 'refund',
            amount: r.amount,
            status: r.status,
            created: toUnix(r.createdAt),
          })),
        }),
      });
    }),
  );
  return router;
}
