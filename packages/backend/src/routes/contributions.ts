import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { createOxyAuthMiddleware, type OxyAuthRequest } from '@oxy.so/core/server';
import {
  createContributionSchema,
  contributionOperationKeySchema,
  contributionPageQuerySchema,
  contributionPatchSchema,
  contributionLinkSchema,
} from '@peable.to/contracts';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import {
  findLinkByPublicId,
  findLinkForMerchant,
  updatePaymentLink,
  type PaymentLinkRow,
} from '../db/payments/paymentLinkRepository';
import {
  createContributionLink,
  listContributions,
  listContributionCollections,
  contributionRefunds,
} from '../db/payments/contributionRepository';
import { authorizeContributionOrganization } from '../services/contributionAccess';
import { resolveRail } from '../services/createIntent';
import { resolveMerchantByApp } from './paymentIntents';
import { newId } from '../lib/ids';
import { config } from '../config';
import { sendError, wrap } from '../lib/http';
function dto(row: PaymentLinkRow) {
  return contributionLinkSchema.parse({
    id: row.publicId,
    amount: row.amount,
    currency: row.currency,
    network: row.network,
    active: row.active,
    url: `${config.checkoutBaseUrl}/l/${row.publicId}`,
    contribution: row.contribution,
    createdAt: row.createdAt.toISOString(),
  });
}
function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}
function cursorFor(id: string, scope: string) {
  return Buffer.from(JSON.stringify({ id, scope: fingerprint(scope) })).toString('base64url');
}
function readCursor(value: string | undefined, scope: string): string | undefined {
  if (!value) return;
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (typeof parsed.id !== 'string' || parsed.scope !== fingerprint(scope))
    throw new Error('invalid cursor');
  return parsed.id;
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
        sendError(res, 422, 'invalid_request_error', 'Organization and application are required');
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
        sendError(res, 422, 'invalid_request_error', 'Invalid environment or pagination');
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
      if (!parsed.success || !key.success) {
        sendError(
          res,
          422,
          'invalid_request_error',
          'Valid contribution fields and a UUID Idempotency-Key are required',
        );
        return;
      }
      const body = parsed.data;
      if (!merchant.network) {
        sendError(
          res,
          422,
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
          amountMode: body.amountMode,
          expiresAt: body.expiresAt ?? null,
        },
      });
      if (row === 'expired') {
        sendError(res, 422, 'invalid_request_error', 'Expiry must be in the future');
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
    wrap(async (_req, res) => {
      const { org, app, merchant, query } = res.locals.contribution;
      const scope = `links:${org}:${app}:${merchant.environment}`;
      let after: string | undefined;
      try {
        after = readCursor(query.cursor, scope);
      } catch {
        sendError(res, 400, 'invalid_request_error', 'Invalid cursor');
        return;
      }
      const page = await listContributions(getDb(), merchant.id, org, query.limit, after);
      const hasMore = page.length > query.limit;
      const rows = page.slice(0, query.limit);
      const items = await Promise.all(
        rows.map(async (r) => {
          const row = await findLinkByPublicId(getDb(), r.publicId);
          if (!row) throw new Error('Link disappeared');
          return dto(row);
        }),
      );
      res.json({
        items,
        nextCursor: hasMore ? cursorFor(rows.at(-1)?.publicId ?? '', scope) : null,
      });
    }),
  );
  router.patch(
    `${root}/:id`,
    wrap(async (req, res) => {
      const { org, merchant } = res.locals.contribution;
      const body = contributionPatchSchema.safeParse(req.body);
      if (!body.success || !req.params.id) {
        sendError(res, 422, 'invalid_request_error', 'Invalid link update');
        return;
      }
      const link = await findLinkForMerchant(getDb(), req.params.id, merchant.id);
      if (!link || link.contribution?.organizationId !== org) {
        sendError(res, 404, 'invalid_request_error', 'Contribution not found');
        return;
      }
      const updated = await updatePaymentLink(getDb(), link.publicId, merchant.id, body.data);
      if (!updated) throw new Error('Link disappeared');
      res.json(dto(updated));
    }),
  );
  router.get(
    `${root}/:id/collections`,
    wrap(async (req, res) => {
      const { org, app, merchant, query } = res.locals.contribution;
      if (!req.params.id) {
        sendError(res, 404, 'invalid_request_error', 'Contribution not found');
        return;
      }
      const link = await findLinkForMerchant(getDb(), req.params.id, merchant.id);
      if (!link || link.contribution?.organizationId !== org) {
        sendError(res, 404, 'invalid_request_error', 'Contribution not found');
        return;
      }
      const scope = `collections:${org}:${app}:${merchant.environment}:${link.publicId}`;
      let after: string | undefined;
      try {
        after = readCursor(query.cursor, scope);
      } catch {
        sendError(res, 400, 'invalid_request_error', 'Invalid cursor');
        return;
      }
      const page = await listContributionCollections(
        getDb(),
        merchant.id,
        link.id,
        query.limit,
        after,
      );
      const rows = page.slice(0, query.limit);
      const items = await Promise.all(
        rows.map(async (row) => ({
          id: row.publicId,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          refundCapability: 'unsupported_non_custodial',
          createdAt: row.createdAt.toISOString(),
          refunds: (await contributionRefunds(getDb(), row.id)).map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
          })),
        })),
      );
      res.json({
        items,
        nextCursor:
          page.length > query.limit ? cursorFor(rows.at(-1)?.publicId ?? '', scope) : null,
      });
    }),
  );
  return router;
}
