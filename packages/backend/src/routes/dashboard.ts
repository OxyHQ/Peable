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
import type { FileActor } from '../services/oxyFiles/fileOwnership';
import {
  answerDisputeList,
  closeDisputeCore,
  retrieveDispute,
  updateDisputeCore,
} from './disputes';
import {
  answerFileContents,
  answerFileList,
  createFile,
  parseFileUpload,
  retrieveFile,
} from './files';
import {
  answerConfigurationList,
  answerDomainList,
  createConfiguration,
  createDomain,
  retrieveConfiguration,
  retrieveDomain,
  updateConfigurationCore,
  updateDomain,
  validateDomain,
} from './paymentMethodConfigurations';
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
import { CATALOG_ROUTES } from './catalog';
import { mountSearchDashboardRoutes } from './search';
import { mountReportingDashboardRoutes } from './reporting';
import { mountCatalogDashboardRoutes } from './catalogRoutes';
import { answerRequestLogList, retrieveRequestLog } from './requestLogs';
import { checkoutSessionRoutes } from './checkoutSessions';
import { paymentLinkRoutes } from './paymentLinks';
import {
  answerBranding,
  answerEmailSettings,
  updateBrandingCore,
  updateEmailSettingsCore,
} from './branding';
import type { CheckoutDeps } from '../services/checkout/sessionService';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { requestContextMiddleware } from '../lib/requestContext';
import { toMerchantDTO, toPaymentIntentDTO, toWebhookDeliveryDTO } from '../lib/serialize';
import { sendError, sendValidationError, wrap } from '../lib/http';
import { listQuerySchema, parseQuery, type QuerySurface } from '../lib/list';
import { runIdempotent } from '../lib/idempotency';
import {
  answerBalanceTransactionList,
  answerMismatchList,
  answerPayoutList,
  answerPayoutReconciliation,
  cancelPayoutCore,
  createAccountOnboardingLink,
  createPayoutCore,
  retrieveAccount,
  retrieveBalance,
  retrieveBalanceTransaction,
  retrievePayout,
  updateAccount,
} from './money';

type MoneyCore = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;

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
   * Who may own an Oxy file this caller makes the merchant's (an avatar, an
   * imported File): the
   * application itself, the signed-in user, and the account that owns the
   * application — which oxy-api just confirmed the user is a member of.
   */
  avatarActor: FileActor;
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
  /** Peable Tax for checkout sessions and links created from Orbit. */
  checkout?: CheckoutDeps;
}): Router {
  const files = deps?.files ?? oxyFilesClient;
  const requireOxyUser: RequestHandler = deps?.requireOxyUser ?? createOxyAuthMiddleware(oxy);
  const assertAppMembership = deps?.assertAppMembership ?? realAssertAppMembership;
  const safeFetch = deps?.safeFetch;
  const router = Router();

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
  // Search first: `…/products/search` must not reach `…/products/:id`.
  mountSearchDashboardRoutes(router, { base, requireOxyUser, asMember });

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

  /** Orbit's catalog: products, prices, coupons and promotion codes. */
  mountCatalogDashboardRoutes(router, CATALOG_ROUTES, { base, requireOxyUser, asMember });
  // Checkout (Orbit Phase 3): the same session and payment-link cores as the API.
  mountCatalogDashboardRoutes(
    router,
    [...checkoutSessionRoutes(deps?.checkout ?? {}), ...paymentLinkRoutes(deps?.checkout ?? {})],
    { base, requireOxyUser, asMember },
  );
  // Branding and customer emails — the same cores as `/v1/merchants/me/*`.
  router.get(
    `${base}/branding`,
    requireOxyUser,
    asMember((_req, res, merchant) => answerBranding(res, merchant)),
  );
  // The logo is written through the merchant writer, with the caller's file authority.
  router.post(
    `${base}/branding`,
    requireOxyUser,
    requestContextMiddleware,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;
      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      await updateBrandingCore(req, res, merchant, { actor: access.avatarActor, files });
    }),
  );
  router.get(
    `${base}/email_settings`,
    requireOxyUser,
    asMember((_req, res, merchant) => answerEmailSettings(res, merchant)),
  );
  router.post(
    `${base}/email_settings`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(updateEmailSettingsCore),
  );
  // Disputes, Files and payment methods — the same cores as the merchant API.
  router.get(
    `${base}/disputes`,
    requireOxyUser,
    asMember((req, res, merchant) => answerDisputeList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/disputes/:disputeId`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveDispute(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/disputes/:disputeId`,
    requireOxyUser,
    requestContextMiddleware,
    asMember((req, res, merchant) => updateDisputeCore(req, res, merchant, files)),
  );
  router.post(
    `${base}/disputes/:disputeId/close`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(closeDisputeCore),
  );
  router.post(
    `${base}/files`,
    requireOxyUser,
    requestContextMiddleware,
    parseFileUpload,
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;
      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      await createFile(req, res, merchant, { files, actor: access.avatarActor });
    }),
  );
  router.get(
    `${base}/files`,
    requireOxyUser,
    asMember((req, res, merchant) => answerFileList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/files/:id`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveFile(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/files/:id/contents`,
    requireOxyUser,
    asMember((req, res, merchant) =>
      answerFileContents(req, res, merchant, { files, surface: 'dashboard' }),
    ),
  );
  // Reporting: report types, runs, and the run's CSV through `…/files/:id/contents`.
  mountReportingDashboardRoutes(router, { base, requireOxyUser, asMember });
  router.get(
    `${base}/payment_method_configurations`,
    requireOxyUser,
    asMember((req, res, merchant) => answerConfigurationList(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_configurations`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(createConfiguration),
  );
  router.get(
    `${base}/payment_method_configurations/:id`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveConfiguration(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_configurations/:id`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(updateConfigurationCore),
  );
  router.get(
    `${base}/payment_method_domains`,
    requireOxyUser,
    asMember((req, res, merchant) => answerDomainList(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_domains`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(createDomain),
  );
  router.get(
    `${base}/payment_method_domains/:id`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveDomain(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_domains/:id`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(updateDomain),
  );
  router.post(
    `${base}/payment_method_domains/:id/validate`,
    requireOxyUser,
    requestContextMiddleware,
    asMember(validateDomain),
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

  // Orbit's Developers › Logs: the merchant's own API requests (`req_…`).
  router.get(
    `${base}/request_logs`,
    requireOxyUser,
    asMember((req, res, merchant) => answerRequestLogList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/request_logs/:id`,
    requireOxyUser,
    asMember((req, res, merchant) => retrieveRequestLog(req, res, merchant, 'dashboard')),
  );
  /**
   * Orbit's money surface (ADR 0015) through the SAME cores as the service
   * routes (`routes/money.ts`). The dashboard never takes `Peable-Account`: it
   * shows the merchant's own account. Writes run under the generic
   * idempotency layer (`runIdempotent`) once the merchant is resolved, so a
   * retried payout instruction with the same `Idempotency-Key` is one payout.
   */
  const dashboard = (core: MoneyCore) =>
    asMember((req, res, merchant) => core(req, res, merchant, 'dashboard'));
  const dashboardWrite = (core: MoneyCore) =>
    asMember((req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => core(req, res, merchant, 'dashboard')),
    );
  router.get(`${base}/account`, requireOxyUser, dashboard(retrieveAccount));
  router.post(
    `${base}/account`,
    requireOxyUser,
    requestContextMiddleware,
    dashboardWrite(updateAccount),
  );
  router.post(
    `${base}/account_links`,
    requireOxyUser,
    requestContextMiddleware,
    dashboardWrite(createAccountOnboardingLink),
  );
  router.get(`${base}/balance`, requireOxyUser, dashboard(retrieveBalance));
  router.get(
    `${base}/balance_transactions`,
    requireOxyUser,
    dashboard(answerBalanceTransactionList),
  );
  router.get(
    `${base}/balance_transactions/:id`,
    requireOxyUser,
    dashboard(retrieveBalanceTransaction),
  );
  router.get(`${base}/payouts`, requireOxyUser, dashboard(answerPayoutList));
  router.post(
    `${base}/payouts`,
    requireOxyUser,
    requestContextMiddleware,
    dashboardWrite(createPayoutCore),
  );
  router.get(`${base}/payouts/:id`, requireOxyUser, dashboard(retrievePayout));
  router.post(
    `${base}/payouts/:id/cancel`,
    requireOxyUser,
    requestContextMiddleware,
    dashboardWrite(cancelPayoutCore),
  );
  router.get(
    `${base}/reports/payout_reconciliation`,
    requireOxyUser,
    dashboard(answerPayoutReconciliation),
  );
  router.get(`${base}/reconciliation_mismatches`, requireOxyUser, dashboard(answerMismatchList));

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
