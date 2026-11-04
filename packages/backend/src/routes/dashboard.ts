import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { registerMerchantParams, updateMerchantParams } from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import type { OxyAccess } from '../services/oxyAccess';
import { oxy } from '../oxy';
import { dashboardGate, resolveDashboardAccess } from './dashboardAccess';
import type { SafeFetchFn } from '../services/webhookDispatcher';
import { registerMerchant, applyMerchantPatch, sendMerchantWriteError } from './merchants';
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
  fileUploadAction,
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
import { listPaymentIntentsQuery } from '@peable.to/contracts';
import { answerPaymentIntentList } from './paymentIntents';
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
import { BILLING_ENGINE_ROUTES, DASHBOARD_CUSTOMER_ROUTES } from './billingEngine';
import {
  answerConnectedAccountList,
  createConnectedAccountCore,
  createConnectedAccountLinkCore,
  refreshConnectedAccountCore,
  retrieveConnectedAccount,
} from './connectedAccounts';
import {
  answerTransferList,
  answerTransferReversalList,
  retrieveTransferCore,
  reverseTransferCore,
} from './transfers';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { requestContextMiddleware } from '../lib/requestContext';
import { toMerchantDTO, toPaymentIntentDTO, toWebhookDeliveryDTO } from '../lib/serialize';
import { sendError, sendValidationError, wrap } from '../lib/http';
import { dashboardQuery, parseQuery, type QuerySurface } from '../lib/list';
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
 * The dashboard's payment-intent list is the contract's (`listPaymentIntentsQuery`)
 * plus `environment` (the Test/Live toggle), validated by the dashboard's gate.
 */
const paymentIntentsListQuery = dashboardQuery(listPaymentIntentsQuery);

/**
 * Build the `/v1/dashboard/*` router — a human Oxy user managing a merchant's
 * Peable integration through Orbit. Kept as a SEPARATE route family from the
 * service-authed `/v1/*` routes — a single handler never accepts both auth
 * strategies. Every route: `requireOxyUser` (human bearer) → the gate for the
 * route's ACTION (`dashboardAccess.ts`: environment, then the permission
 * `DASHBOARD_PERMISSIONS` names for it, asked of Oxy through `services/oxyAccess.ts`) →
 * the application's merchant → the EXACT SAME cores the service-authed routers
 * run. Every GET is `read`; every write names the action it is.
 */
export function createDashboardRouter(deps: {
  requireOxyUser: RequestHandler;
  /** What Oxy lets the caller do (default the process's `oxy`). */
  access?: OxyAccess;
  safeFetch?: SafeFetchFn;
  /** Oxy Files, for the avatar ownership check. Default: the real client. */
  files?: OxyFilesClient;
  /** Peable Tax for checkout sessions and links created from Orbit. */
  checkout?: CheckoutDeps;
}): Router {
  const files = deps.files ?? oxyFilesClient;
  const { requireOxyUser } = deps;
  const access = deps.access ?? oxy;
  const gate = dashboardGate(access);
  const safeFetch = deps.safeFetch;
  const router = Router();

  const base = '/v1/dashboard/applications/:applicationId';
  // Search first: `…/products/search` must not reach `…/products/:id`.
  mountSearchDashboardRoutes(router, { base, requireOxyUser, gate });

  router.get(
    `${base}/merchant`,
    requireOxyUser,
    gate('read', async (_req, res, merchant) => {
      res.status(200).json(toMerchantDTO(merchant));
    }),
  );

  // Registering names the watch-only key payments are derived from: money.
  router.post(
    `${base}/merchant`,
    requireOxyUser,
    wrap(async (req, res) => {
      const granted = await resolveDashboardAccess(req, res, 'money', access);
      if (!granted) return;

      const parsed = registerMerchantParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }

      const result = await registerMerchant(
        granted.applicationId,
        granted.environment,
        parsed.data,
        { actor: granted.avatarActor, files },
      );
      if (!result.ok) {
        sendMerchantWriteError(res, result);
        return;
      }
      res.status(201).json(toMerchantDTO(result.merchant));
    }),
  );

  router.patch(
    `${base}/merchant`,
    requireOxyUser,
    gate('money', async (req, res, merchant, granted) => {
      const parsed = updateMerchantParams.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error);
        return;
      }
      const result = await applyMerchantPatch(merchant, parsed.data, {
        actor: granted.avatarActor,
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
    `${base}/payment_intents`,
    requireOxyUser,
    gate('read', async (req, res, merchant) => {
      const query = parseQuery(req, res, paymentIntentsListQuery);
      if (!query) return;
      await answerPaymentIntentList(req, res, merchant.id, query);
    }),
  );

  router.get(
    `${base}/payment_intents/:id`,
    requireOxyUser,
    gate('read', async (req, res, merchant) => {
      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here.
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
   * `routes/events.ts`, `routes/webhookDeliveries.ts`). The merchant is the
   * (application, environment)'s, so a member of one application can never
   * reach another's endpoints. The writes open the request context, so an
   * event they cause records this request.
   */
  router.get(
    `${base}/webhook_endpoints`,
    requireOxyUser,
    gate('read', (req, res, merchant) =>
      answerWebhookEndpointList(req, res, merchant, 'dashboard'),
    ),
  );
  router.post(
    `${base}/webhook_endpoints`,
    requireOxyUser,
    requestContextMiddleware,
    gate('webhooks', createWebhookEndpoint),
  );
  router.get(
    `${base}/webhook_endpoints/:id`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveWebhookEndpoint(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/webhook_endpoints/:id`,
    requireOxyUser,
    requestContextMiddleware,
    gate('webhooks', updateWebhookEndpoint),
  );
  router.delete(
    `${base}/webhook_endpoints/:id`,
    requireOxyUser,
    requestContextMiddleware,
    gate('webhooks', deleteWebhookEndpoint),
  );
  router.post(
    `${base}/webhook_endpoints/:id/roll_secret`,
    requireOxyUser,
    requestContextMiddleware,
    gate('webhooks', rollWebhookEndpointSecret),
  );
  router.post(
    `${base}/webhook_endpoints/:id/test`,
    requireOxyUser,
    requestContextMiddleware,
    gate('webhooks', (req, res, merchant) =>
      sendWebhookEndpointTest(req, res, merchant, { safeFetch }),
    ),
  );

  /** Orbit's catalog: products, prices, coupons and promotion codes. */
  mountCatalogDashboardRoutes(router, CATALOG_ROUTES, {
    base,
    requireOxyUser,
    gate,
    write: 'configure',
  });
  // Checkout (Orbit Phase 3): the same session and payment-link cores as the API.
  mountCatalogDashboardRoutes(
    router,
    [...checkoutSessionRoutes(deps.checkout ?? {}), ...paymentLinkRoutes(deps.checkout ?? {})],
    { base, requireOxyUser, gate, write: 'configure' },
  );
  // Branding and customer emails — the same cores as `/v1/merchants/me/*`.
  router.get(
    `${base}/branding`,
    requireOxyUser,
    gate('read', (_req, res, merchant) => answerBranding(res, merchant)),
  );
  // The logo is written through the merchant writer, with the caller's file authority.
  router.post(
    `${base}/branding`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', (req, res, merchant, granted) =>
      updateBrandingCore(req, res, merchant, { actor: granted.avatarActor, files }),
    ),
  );
  router.get(
    `${base}/email_settings`,
    requireOxyUser,
    gate('read', (_req, res, merchant) => answerEmailSettings(res, merchant)),
  );
  router.post(
    `${base}/email_settings`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', updateEmailSettingsCore),
  );
  // Disputes, Files and payment methods — the same cores as the merchant API.
  router.get(
    `${base}/disputes`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerDisputeList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/disputes/:disputeId`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveDispute(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/disputes/:disputeId`,
    requireOxyUser,
    requestContextMiddleware,
    gate('money', (req, res, merchant) => updateDisputeCore(req, res, merchant, files)),
  );
  router.post(
    `${base}/disputes/:disputeId/close`,
    requireOxyUser,
    requestContextMiddleware,
    gate('money', closeDisputeCore),
  );
  // An upload needs what its purpose is used for (`FILE_UPLOAD_ACTION`).
  router.post(
    `${base}/files`,
    requireOxyUser,
    requestContextMiddleware,
    parseFileUpload,
    gate(fileUploadAction, (req, res, merchant, granted) =>
      createFile(req, res, merchant, { files, actor: granted.avatarActor }),
    ),
  );
  router.get(
    `${base}/files`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerFileList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/files/:id`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveFile(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/files/:id/contents`,
    requireOxyUser,
    gate('read', (req, res, merchant) =>
      answerFileContents(req, res, merchant, { files, surface: 'dashboard' }),
    ),
  );
  // Reporting: report types, runs, and the run's CSV through `…/files/:id/contents`.
  mountReportingDashboardRoutes(router, { base, requireOxyUser, gate });
  router.get(
    `${base}/payment_method_configurations`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerConfigurationList(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_configurations`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', createConfiguration),
  );
  router.get(
    `${base}/payment_method_configurations/:id`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveConfiguration(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_configurations/:id`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', updateConfigurationCore),
  );
  router.get(
    `${base}/payment_method_domains`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerDomainList(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_domains`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', createDomain),
  );
  router.get(
    `${base}/payment_method_domains/:id`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveDomain(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/payment_method_domains/:id`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', updateDomain),
  );
  router.post(
    `${base}/payment_method_domains/:id/validate`,
    requireOxyUser,
    requestContextMiddleware,
    gate('configure', validateDomain),
  );
  // The native billing engine (ADR 0018), and the customers its screens read.
  mountCatalogDashboardRoutes(router, BILLING_ENGINE_ROUTES, {
    base,
    requireOxyUser,
    gate,
    write: 'money',
  });
  mountCatalogDashboardRoutes(router, DASHBOARD_CUSTOMER_ROUTES, {
    base,
    requireOxyUser,
    gate,
    write: 'money',
  });

  router.get(
    `${base}/events`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerEventList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/events/:id`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveEvent(req, res, merchant, 'dashboard')),
  );

  // Orbit's Developers › Logs: the merchant's own API requests (`req_…`).
  router.get(
    `${base}/request_logs`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerRequestLogList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/request_logs/:id`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveRequestLog(req, res, merchant, 'dashboard')),
  );
  /**
   * Orbit's money surface (ADR 0015) through the SAME cores as the service
   * routes (`routes/money.ts`). The dashboard never takes `Peable-Account`: it
   * shows the merchant's own account. Writes run under the generic
   * idempotency layer (`runIdempotent`) once the merchant is resolved, so a
   * retried payout instruction with the same `Idempotency-Key` is one payout.
   */
  const moneyRead = (core: MoneyCore) =>
    gate('read', (req, res, merchant) => core(req, res, merchant, 'dashboard'));
  const moneyWrite = (core: MoneyCore) =>
    gate('money', (req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => core(req, res, merchant, 'dashboard')),
    );
  router.get(`${base}/account`, requireOxyUser, moneyRead(retrieveAccount));
  router.post(
    `${base}/account`,
    requireOxyUser,
    requestContextMiddleware,
    moneyWrite(updateAccount),
  );
  router.post(
    `${base}/account_links`,
    requireOxyUser,
    requestContextMiddleware,
    moneyWrite(createAccountOnboardingLink),
  );
  router.get(`${base}/balance`, requireOxyUser, moneyRead(retrieveBalance));
  router.get(
    `${base}/balance_transactions`,
    requireOxyUser,
    moneyRead(answerBalanceTransactionList),
  );
  router.get(
    `${base}/balance_transactions/:id`,
    requireOxyUser,
    moneyRead(retrieveBalanceTransaction),
  );
  router.get(`${base}/payouts`, requireOxyUser, moneyRead(answerPayoutList));
  router.post(
    `${base}/payouts`,
    requireOxyUser,
    requestContextMiddleware,
    moneyWrite(createPayoutCore),
  );
  router.get(`${base}/payouts/:id`, requireOxyUser, moneyRead(retrievePayout));
  router.post(
    `${base}/payouts/:id/cancel`,
    requireOxyUser,
    requestContextMiddleware,
    moneyWrite(cancelPayoutCore),
  );
  router.get(
    `${base}/reports/payout_reconciliation`,
    requireOxyUser,
    moneyRead(answerPayoutReconciliation),
  );
  router.get(`${base}/reconciliation_mismatches`, requireOxyUser, moneyRead(answerMismatchList));

  /**
   * Orbit's Connect screen: the marketplace's sellers (`role = 'seller'`; the
   * merchant's own account is `…/account` above), their onboarding links, and
   * the settlements paid to them — the SAME cores as `/v1/connected_accounts`
   * and `/v1/transfers`. Writes run under the generic idempotency layer, so a
   * retried reversal with the same `Idempotency-Key` is one reversal (its own
   * `external_ref` already is).
   */
  type ConnectCore = (req: Request, res: Response, merchant: MerchantRow) => Promise<void>;
  const connectWrite = (core: ConnectCore) =>
    gate('money', (req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => core(req, res, merchant)),
    );
  router.get(
    `${base}/connected_accounts`,
    requireOxyUser,
    gate('read', (req, res, merchant) =>
      answerConnectedAccountList(req, res, merchant, 'dashboard'),
    ),
  );
  router.post(
    `${base}/connected_accounts`,
    requireOxyUser,
    requestContextMiddleware,
    connectWrite(createConnectedAccountCore),
  );
  router.get(
    `${base}/connected_accounts/:accountId`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveConnectedAccount(req, res, merchant, 'dashboard')),
  );
  router.post(
    `${base}/connected_accounts/:accountId/refresh`,
    requireOxyUser,
    requestContextMiddleware,
    connectWrite(refreshConnectedAccountCore),
  );
  router.post(
    `${base}/connected_accounts/:accountId/account_links`,
    requireOxyUser,
    requestContextMiddleware,
    connectWrite(createConnectedAccountLinkCore),
  );
  router.get(
    `${base}/transfers`,
    requireOxyUser,
    gate('read', (req, res, merchant) => answerTransferList(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/transfers/:transferId`,
    requireOxyUser,
    gate('read', (req, res, merchant) => retrieveTransferCore(req, res, merchant, 'dashboard')),
  );
  router.get(
    `${base}/transfers/:transferId/reversals`,
    requireOxyUser,
    gate('read', (req, res, merchant) =>
      answerTransferReversalList(req, res, merchant, 'dashboard'),
    ),
  );
  router.post(
    `${base}/transfers/:transferId/reversals`,
    requireOxyUser,
    requestContextMiddleware,
    connectWrite(reverseTransferCore),
  );

  router.get(
    `${base}/webhook_deliveries`,
    requireOxyUser,
    gate('read', (req, res, merchant) =>
      answerWebhookDeliveryList(req, res, merchant, 'dashboard'),
    ),
  );

  router.post(
    `${base}/webhook_deliveries/:id/redeliver`,
    requireOxyUser,
    requestContextMiddleware,
    gate('webhooks', async (req, res, merchant) => {
      const { id: deliveryId } = req.params;
      if (!deliveryId) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }
      const result = await redeliverWebhookDelivery(merchant, deliveryId, { safeFetch });
      if (!result.ok) {
        sendError(res, result.status, 'invalid_request_error', result.message, result.code);
        return;
      }
      res.status(200).json(toWebhookDeliveryDTO(result.delivery));
    }),
  );

  return router;
}
