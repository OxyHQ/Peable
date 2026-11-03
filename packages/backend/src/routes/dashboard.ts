import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import {
  createOxyAuthMiddleware,
  getRequiredOxyUserId,
  OXY_SERVICE_ENVIRONMENTS,
} from '@oxy.so/core/server';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import {
  assertAppMembership as realAssertAppMembership,
  type AppMembershipResult,
} from '../services/appMembership';
import type { SafeFetchFn } from '../services/webhookDispatcher';
import {
  createMerchantBodySchema,
  patchMerchantBodySchema,
  registerMerchant,
  applyMerchantPatch,
  sendMerchantWriteError,
} from './merchants';
import type { AvatarActor } from '../services/oxyFiles/merchantAvatar';
import { type OxyFilesClient, oxyFilesClient } from '../services/oxyFiles/client';
import {
  answerPaymentIntentList,
  paymentIntentListFilters,
  resolveMerchantByApp,
} from './paymentIntents';
import { answerWebhookDeliveryList, redeliverWebhookDelivery } from './webhookDeliveries';
import {
  answerWebhookEndpointList,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  retrieveWebhookEndpoint,
  rollWebhookEndpointSecret,
  sendWebhookEndpointTest,
  updateWebhookEndpoint,
} from './webhookEndpoints';
import { answerEventList, retrieveEvent } from './events';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { requestContextMiddleware } from '../lib/requestContext';
import { toMerchantDTO, toPaymentIntentDTO, toWebhookDeliveryDTO } from '../lib/serialize';
import { sendError, sendValidationError, wrap } from '../lib/http';
import { listQuerySchema, parseQuery } from '../lib/list';

/**
 * Every `/v1/dashboard/*` route is scoped to one `(applicationId, environment)`
 * pair — the Test/Live toggle in the dashboard UI selects `environment`, which
 * determines which `Merchant` document (and therefore which PaymentIntents/
 * WebhookDeliveries) the request can see (F2.0 task 1b's test/live isolation,
 * extended to the human-auth path).
 */
const environmentQuerySchema = z.object({
  environment: z.enum(OXY_SERVICE_ENVIRONMENTS),
});

function resolveEnvironment(req: Request, res: Response): OxyServiceEnvironment | null {
  const parsed = environmentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(
      res,
      400,
      'invalid_request_error',
      'a valid environment query parameter is required (development | staging | production)',
    );
    return null;
  }
  return parsed.data.environment;
}

export interface DashboardAccess {
  applicationId: string;
  environment: OxyServiceEnvironment;
  userId: string;
  membership: AppMembershipResult;
  /**
   * Who may own a file this caller makes the merchant's avatar: the
   * application itself, the signed-in user, and the account that owns the
   * application — which oxy-api just confirmed the user is a member of.
   */
  avatarActor: AvatarActor;
}

/**
 * The full `/v1/dashboard/*` authorization gate: resolve+validate
 * `?environment=`, then delegate membership to oxy-api via
 * `assertAppMembership` (spec §8 — the gateway NEVER re-implements RBAC).
 * Writes the appropriate error response and returns `null` on any failure, so
 * every handler below just does `if (!access) return`.
 */
export async function resolveDashboardAccess(
  req: Request,
  res: Response,
  deps: { assertAppMembership: typeof realAssertAppMembership },
): Promise<DashboardAccess | null> {
  const environment = resolveEnvironment(req, res);
  if (!environment) return null;

  const userId = getRequiredOxyUserId(req);
  const accessToken = (req as OxyAuthRequest).accessToken;
  if (!accessToken) {
    // Unreachable in production once `requireOxyUser` (`createOxyAuthMiddleware`)
    // has run — a real bearer always leaves `req.accessToken` set alongside
    // `req.userId` (`OxyServices.utility.ts`). Guarded so a future change to
    // that contract (or a misconfigured test stub) fails closed instead of
    // forwarding an empty `Authorization` header to oxy-api.
    sendError(res, 401, 'authentication_error', 'missing bearer token');
    return null;
  }

  // `noUncheckedIndexedAccess` types every `req.params` read as possibly
  // `undefined` even though Express guarantees `:applicationId` is present on
  // any request that matched one of these routes — mirrors the same guard
  // `routes/social.ts` uses for `:username`.
  const { applicationId } = req.params;
  if (!applicationId) {
    sendError(res, 400, 'invalid_request_error', 'applicationId is required');
    return null;
  }

  const membership: AppMembershipResult = await deps.assertAppMembership(
    userId,
    applicationId,
    accessToken,
  );
  if (!membership.allowed) {
    sendError(res, 403, 'permission_error', 'you are not a member of this application');
    return null;
  }

  return {
    applicationId,
    environment,
    userId,
    membership,
    avatarActor: { applicationId, accountIds: [userId, membership.ownerAccountId] },
  };
}

/**
 * The dashboard's lists take `environment` beside the list parameters (the
 * Test/Live toggle); it is validated by `resolveDashboardAccess` and declared
 * here only so the strict list schema does not refuse it.
 */
const dashboardScope = { environment: z.enum(OXY_SERVICE_ENVIRONMENTS) } as const;

const paymentIntentsListQuery = listQuerySchema({
  ...paymentIntentListFilters,
  ...dashboardScope,
});

/**
 * Build the `/v1/dashboard/*` router (F2.5 Phase 0 Task 2) — a human Oxy
 * user managing a merchant's Peable integration through
 * `dashboard.peable.to`. Kept as a SEPARATE route family from
 * `/v1/payment_intents/*`/`/v1/merchants/*`/etc (service-auth/payer only) —
 * a single handler never accepts both auth strategies (plan's global
 * constraint). Every route: `requireOxyUser` (human bearer) →
 * `resolveDashboardAccess` (environment + oxy-api membership delegation) →
 * `resolveMerchantByApp` → reuse the EXACT SAME models/serializers/list &
 * redeliver cores the service-authed routers use.
 */
export function createDashboardRouter(deps?: {
  requireOxyUser?: RequestHandler;
  assertAppMembership?: typeof realAssertAppMembership;
  safeFetch?: SafeFetchFn;
  /** Oxy Files, for the avatar ownership check. Default: the real client. */
  files?: OxyFilesClient;
}): Router {
  const files = deps?.files ?? oxyFilesClient;
  const requireOxyUser: RequestHandler = deps?.requireOxyUser ?? createOxyAuthMiddleware(oxy);
  const assertAppMembership = deps?.assertAppMembership ?? realAssertAppMembership;
  const safeFetch = deps?.safeFetch;
  const router = Router();

  router.get(
    '/v1/dashboard/applications/:applicationId/merchant',
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      res.status(200).json(toMerchantDTO(merchant));
    }),
  );

  router.post(
    '/v1/dashboard/applications/:applicationId/merchant',
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const parsed = createMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }

      const result = await registerMerchant(access.applicationId, access.environment, parsed.data, {
        actor: access.avatarActor,
        files,
      });
      if (!result.ok) {
        sendMerchantWriteError(res, result);
        return;
      }
      res.status(201).json(toMerchantDTO(result.merchant));
    }),
  );

  router.patch(
    '/v1/dashboard/applications/:applicationId/merchant',
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      const parsed = patchMerchantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const result = await applyMerchantPatch(merchant, parsed.data, {
        actor: access.avatarActor,
        files,
      });
      if (!result.ok) {
        sendMerchantWriteError(res, result);
        return;
      }
      res.status(200).json(toMerchantDTO(result.merchant));
    }),
  );

  router.get(
    '/v1/dashboard/applications/:applicationId/payment_intents',
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      const query = parseQuery(req, res, paymentIntentsListQuery);
      if (!query) return;
      await answerPaymentIntentList(req, res, merchant.id, query);
    }),
  );

  router.get(
    '/v1/dashboard/applications/:applicationId/payment_intents/:id',
    requireOxyUser,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;

      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here. The
      // repositories take a `string`, so the guard is explicit rather than a
      // non-null assertion.
      const { id } = req.params;
      if (!id) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }

      const intent = await findIntentForMerchant(getDb(), id, merchant.id);
      if (!intent) {
        sendError(res, 404, 'invalid_request_error', 'payment intent not found');
        return;
      }
      res.status(200).json(toPaymentIntentDTO(intent));
    }),
  );

  /**
   * Orbit's webhooks surface: endpoints, events and the delivery log, through
   * the SAME cores the service-authed routes run (`routes/webhookEndpoints.ts`,
   * `routes/events.ts`, `routes/webhookDeliveries.ts`). Every one passes the
   * dashboard's access gate first, then resolves the merchant of the
   * (application, environment) — so a member of one application can never
   * reach another's endpoints. The writes open the request context, so an event
   * they cause records this request.
   */
  type MerchantCore = (req: Request, res: Response, merchant: MerchantRow) => Promise<void>;
  const asMember = (core: MerchantCore) =>
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;
      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      await core(req, res, merchant);
    });
  const base = '/v1/dashboard/applications/:applicationId';

  router.get(
    `${base}/webhook_endpoints`,
    requireOxyUser,
    asMember((req, res, merchant) => answerWebhookEndpointList(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/webhook_endpoints`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(createWebhookEndpoint),
  );
  router.get(
    `${base}/webhook_endpoints/:id`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveWebhookEndpoint(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/webhook_endpoints/:id`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(updateWebhookEndpoint),
  );
  router.delete(
    `${base}/webhook_endpoints/:id`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(deleteWebhookEndpoint),
  );
  router.post(
    `${base}/webhook_endpoints/:id/roll_secret`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(rollWebhookEndpointSecret),
  );
  router.post(
    `${base}/webhook_endpoints/:id/test`,
    requireOxyUser,
    requestContextMiddleware,
    asMember((req, res, merchant) => sendWebhookEndpointTest(req, res, merchant, { safeFetch })),
  );

  router.get(
    `${base}/events`,
    requireOxyUser,
    asMember((req, res, merchant) => answerEventList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/events/:id`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveEvent(req, res, merchant, 'dashboard')),
  );

  router.get(
    `${base}/webhook_deliveries`,
    requireOxyUser,
    asMember((req, res, merchant) => answerWebhookDeliveryList(req, res, merchant, 'dashboard')),
  );

  router.post(
    `${base}/webhook_deliveries/:id/redeliver`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(async (req, res, merchant) => {
      const { id: deliveryId } = req.params;
      if (!deliveryId) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const result = await redeliverWebhookDelivery(merchant, deliveryId, { safeFetch });
      if (!result.ok) {
        sendError(res, result.status, 'invalid_request_error', result.message);
        return;
      }
      res.status(200).json(toWebhookDeliveryDTO(result.delivery));
    }),
  );

  return router;
}
