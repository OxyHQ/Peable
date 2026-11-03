/**
 * Peable Tax business compliance (ADR 0020), as data: each route is listed
 * once with the access it needs and a core taking the merchant, and mounted on
 * both surfaces so they can never answer differently.
 *
 *  - The merchant API (`/v1/tax/*`, a service credential) READS everything and
 *    may run an assessment (`payments:write`, behind the generic idempotency
 *    layer). It records no onboarding fact and decides no review item: those
 *    are the owner's.
 *  - Orbit (`/v1/dashboard/applications/:applicationId/tax/*`, a signed-in Oxy
 *    member): reading needs `billing:read`; every write and every decision
 *    needs `billing:manage` — oxy-api's own permission vocabulary, the same
 *    gate as the ADR 0011 approval, never re-implemented here.
 *
 * Nothing here reaches the ADR 0011 approval or the calculator.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { createOxyAuthMiddleware } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { oxy } from '../oxy';
import { requireAuthenticated, sendError, wrap } from '../lib/http';
import { idempotent, runIdempotent } from '../lib/idempotency';
import { parseExpand, type ExpandableType } from '../lib/expand';
import {
  answerList,
  completeList,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { requestContextMiddleware } from '../lib/requestContext';
import { assertAppMembership as realAssertAppMembership } from '../services/appMembership';
import {
  createTaxComplianceService,
  reviewItemStatusFilter,
  TaxComplianceError,
  type TaxComplianceActor,
  type TaxComplianceCursor,
  type TaxComplianceService,
} from '../services/tax/compliance/complianceService';
import { resolveDashboardAccess } from './dashboard';
import { resolveMerchant, resolveMerchantByApp } from './paymentIntents';

/** `read` — both surfaces; `assess` — API write and owner; `manage` — owner only. */
type Access = 'read' | 'assess' | 'manage';

interface ComplianceContext {
  readonly service: TaxComplianceService;
  readonly surface: QuerySurface;
  readonly actor: TaxComplianceActor;
}

type ComplianceCore = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  ctx: ComplianceContext,
) => Promise<void>;

interface ComplianceRoute {
  readonly method: 'get' | 'post';
  /** Relative to `/tax`. */
  readonly path: string;
  readonly access: Access;
  readonly core: ComplianceCore;
}

const retrieveQuery = surfaceRetrieveQuery();
const listQuery = surfaceListQuery({});
const reviewListQuery = surfaceListQuery({ status: reviewItemStatusFilter.optional() });

function idOf(req: Request): string {
  return req.params.id ?? '';
}

/** A retrieve: the shared `expand[]` parameter is validated (no path expands yet), then answered. */
function retrieve(
  type: ExpandableType,
  read: (service: TaxComplianceService, merchant: MerchantRow, id: string) => Promise<object>,
): ComplianceCore {
  return async (req, res, merchant, ctx) => {
    const query = parseQuery(req, res, retrieveQuery[ctx.surface]);
    if (!query) return;
    if (!parseExpand(res, type, query.expand, { list: false })) return;
    res.status(200).json(await read(ctx.service, merchant, idOf(req)));
  };
}

function list(
  type: ExpandableType,
  cursor: TaxComplianceCursor,
  fetch: (
    service: TaxComplianceService,
    merchant: MerchantRow,
    page: Parameters<TaxComplianceService['listLocations']>[1],
    query: { status?: 'open' | 'resolved' | 'dismissed' },
  ) => Promise<{ data: readonly object[]; hasMore: boolean }>,
  schema: typeof listQuery | typeof reviewListQuery = listQuery,
): ComplianceCore {
  return async (req, res, merchant, ctx) => {
    const query = parseQuery(req, res, schema[ctx.surface]);
    if (!query) return;
    await answerList(req, res, {
      query,
      type,
      merchantId: merchant.id,
      cursor: (publicId) => ctx.service.cursor(cursor, merchant, publicId),
      fetch: (page) =>
        fetch(ctx.service, merchant, page, {
          status: reviewItemStatusFilter.safeParse((query as { status?: unknown }).status).data,
        }),
      serialize: (row) => row,
    });
  };
}

/** A write whose body is the request body; answers the object it returns. */
function write(
  act: (
    service: TaxComplianceService,
    merchant: MerchantRow,
    req: Request,
    actor: TaxComplianceActor,
  ) => Promise<object>,
): ComplianceCore {
  return async (req, res, merchant, ctx) => {
    res.status(200).json(await act(ctx.service, merchant, req, ctx.actor));
  };
}

export const TAX_COMPLIANCE_ROUTES: readonly ComplianceRoute[] = [
  {
    method: 'get',
    path: '/business_profile',
    access: 'read',
    core: async (_req, res, merchant, ctx) => {
      res.status(200).json(await ctx.service.getProfile(merchant));
    },
  },
  {
    method: 'post',
    path: '/business_profile',
    access: 'manage',
    core: write((service, merchant, req, actor) =>
      service.updateProfile(merchant, req.body, actor),
    ),
  },
  {
    method: 'get',
    path: '/operating_locations',
    access: 'read',
    core: list('tax.operating_location', 'operating_location', (s, m, page) =>
      s.listLocations(m, page),
    ),
  },
  {
    method: 'post',
    path: '/operating_locations',
    access: 'manage',
    core: write((s, m, req, actor) => s.createLocation(m, req.body, actor)),
  },
  {
    method: 'get',
    path: '/operating_locations/:id',
    access: 'read',
    core: retrieve('tax.operating_location', (s, m, id) => s.retrieveLocation(m, id)),
  },
  {
    method: 'post',
    path: '/operating_locations/:id',
    access: 'manage',
    core: write((s, m, req, actor) => s.updateLocation(m, idOf(req), req.body, actor)),
  },
  {
    method: 'get',
    path: '/sales_destinations',
    access: 'read',
    core: list('tax.sales_destination', 'sales_destination', (s, m, page) =>
      s.listDestinations(m, page),
    ),
  },
  {
    method: 'post',
    path: '/sales_destinations',
    access: 'manage',
    core: write((s, m, req, actor) => s.createDestination(m, req.body, actor)),
  },
  {
    method: 'get',
    path: '/sales_destinations/:id',
    access: 'read',
    core: retrieve('tax.sales_destination', (s, m, id) => s.retrieveDestination(m, id)),
  },
  {
    method: 'post',
    path: '/sales_destinations/:id',
    access: 'manage',
    core: write((s, m, req, actor) => s.updateDestination(m, idOf(req), req.body, actor)),
  },
  {
    method: 'get',
    path: '/registration_declarations',
    access: 'read',
    core: list('tax.registration_declaration', 'registration_declaration', (s, m, page) =>
      s.listDeclarations(m, page),
    ),
  },
  {
    method: 'post',
    path: '/registration_declarations',
    access: 'manage',
    core: write((s, m, req, actor) => s.createDeclaration(m, req.body, actor)),
  },
  {
    method: 'get',
    path: '/registration_declarations/:id',
    access: 'read',
    core: retrieve('tax.registration_declaration', (s, m, id) => s.retrieveDeclaration(m, id)),
  },
  {
    method: 'post',
    path: '/registration_declarations/:id',
    access: 'manage',
    core: write((s, m, req, actor) => s.updateDeclaration(m, idOf(req), req.body, actor)),
  },
  {
    method: 'get',
    path: '/documents',
    access: 'read',
    core: list('tax.document', 'document', (s, m, page) => s.listDocuments(m, page)),
  },
  {
    method: 'post',
    path: '/documents',
    access: 'manage',
    core: write(async (s, m, req, actor) => (await s.createDocument(m, req.body, actor)).document),
  },
  {
    method: 'get',
    path: '/documents/:id',
    access: 'read',
    core: retrieve('tax.document', (s, m, id) => s.retrieveDocument(m, id)),
  },
  {
    method: 'get',
    path: '/document_checklist',
    access: 'read',
    core: async (_req, res, merchant, ctx) => {
      res.status(200).json(await ctx.service.checklist(merchant));
    },
  },
  {
    method: 'get',
    path: '/rule_set',
    access: 'read',
    core: async (_req, res, _merchant, ctx) => {
      res.status(200).json(ctx.service.ruleSet());
    },
  },
  {
    method: 'get',
    path: '/capabilities',
    access: 'read',
    core: async (_req, res, merchant, ctx) => {
      res.status(200).json(ctx.service.capabilities(merchant));
    },
  },
  {
    method: 'get',
    path: '/deadlines',
    access: 'read',
    core: async (req, res, merchant, ctx) => {
      const { data, unavailable } = await ctx.service.deadlines(merchant);
      res.status(200).json({ ...completeList(req, data), unavailable });
    },
  },
  {
    method: 'get',
    path: '/assessments',
    access: 'read',
    core: list('tax.assessment', 'assessment', (s, m, page) => s.listAssessments(m, page)),
  },
  {
    method: 'post',
    path: '/assessments',
    access: 'assess',
    core: write((s, m, req, actor) => s.createAssessment(m, req.body, actor)),
  },
  {
    method: 'get',
    path: '/assessments/:id',
    access: 'read',
    core: retrieve('tax.assessment', (s, m, id) => s.retrieveAssessment(m, id)),
  },
  {
    method: 'get',
    path: '/assessments/:id/replay',
    access: 'read',
    core: async (req, res, merchant, ctx) => {
      res.status(200).json(await ctx.service.replayAssessment(merchant, idOf(req)));
    },
  },
  {
    method: 'get',
    path: '/review_items',
    access: 'read',
    core: list(
      'tax.review_item',
      'review_item',
      (s, m, page, query) => s.listReviewItems(m, page, query.status),
      reviewListQuery,
    ),
  },
  {
    method: 'get',
    path: '/review_items/:id',
    access: 'read',
    core: retrieve('tax.review_item', (s, m, id) => s.retrieveReviewItem(m, id)),
  },
  {
    method: 'post',
    path: '/review_items/:id/resolve',
    access: 'manage',
    core: async (req, res, merchant, ctx) => {
      if (ctx.actor.type !== 'user' || !ctx.actor.id) {
        sendError(res, 403, 'permission_error', "a review decision is the owner's, in Orbit");
        return;
      }
      res.status(200).json(
        await ctx.service.resolveReviewItem(merchant, idOf(req), req.body, {
          type: 'user',
          id: ctx.actor.id,
        }),
      );
    },
  },
  {
    method: 'get',
    path: '/compliance_actions',
    access: 'read',
    core: list('tax.compliance_action', 'action', (s, m, page) => s.listActions(m, page)),
  },
];

/** Run a core, answering a {@link TaxComplianceError} as its ADR 0014 envelope. */
async function run(
  route: ComplianceRoute,
  req: Request,
  res: Response,
  merchant: MerchantRow,
  ctx: ComplianceContext,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await route.core(req, res, merchant, ctx);
  } catch (error) {
    if (!(error instanceof TaxComplianceError)) throw error;
    sendError(
      res,
      error.status,
      error.status >= 500 ? 'api_error' : 'invalid_request_error',
      error.message,
      error.code,
      error.param,
    );
  }
}

const defaultService = () => createTaxComplianceService({ db: getDb() });

/** The merchant API. `manage` routes are not mounted: a service credential decides nothing. */
export function createTaxComplianceRouter(deps: {
  requireMerchant: RequestHandler;
  service?: TaxComplianceService;
}): Router {
  const router = Router();
  const auth = (scope: 'payments:read' | 'payments:write') => [
    deps.requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope(scope),
  ];
  for (const route of TAX_COMPLIANCE_ROUTES) {
    if (route.access === 'manage') continue;
    const handler = wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await run(route, req, res, merchant, {
        service: deps.service ?? defaultService(),
        surface: 'api',
        actor: { type: 'service', id: merchant.oxyAppId },
      });
    });
    const path = `/v1/tax${route.path}`;
    if (route.method === 'get') router.get(path, ...auth('payments:read'), handler);
    else router.post(path, ...auth('payments:write'), idempotent, handler);
  }
  return router;
}

/** Orbit's surface: `billing:read` to look, `billing:manage` for everything else. */
export function createDashboardTaxComplianceRouter(deps: {
  requireOxyUser?: RequestHandler;
  assertAppMembership?: typeof realAssertAppMembership;
  service?: TaxComplianceService;
}): Router {
  const router = Router();
  const requireOxyUser = deps.requireOxyUser ?? createOxyAuthMiddleware(oxy);
  const assertAppMembership = deps.assertAppMembership ?? realAssertAppMembership;
  for (const route of TAX_COMPLIANCE_ROUTES) {
    const permission = route.access === 'read' ? 'billing:read' : 'billing:manage';
    const handler = wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;
      const permissions = access.membership.permissions ?? [];
      // `billing:manage` implies reading.
      if (
        !permissions.includes(permission) &&
        !(permission === 'billing:read' && permissions.includes('billing:manage'))
      ) {
        sendError(res, 403, 'permission_error', `${permission} is required for tax compliance`);
        return;
      }
      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      const ctx: ComplianceContext = {
        service: deps.service ?? defaultService(),
        surface: 'dashboard',
        actor: { type: 'user', id: access.userId },
      };
      if (route.method === 'post')
        await runIdempotent(req, res, merchant.id, () => run(route, req, res, merchant, ctx));
      else await run(route, req, res, merchant, ctx);
    });
    const path = `/v1/dashboard/applications/:applicationId/tax${route.path}`;
    if (route.method === 'get') router.get(path, requireOxyUser, handler);
    else router.post(path, requireOxyUser, requestContextMiddleware, handler);
  }
  return router;
}
