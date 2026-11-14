import { buildOpenApiDocument } from '@peable.to/contracts/openapi';
import { createDashboardTaxRouter, createTaxRouter } from './routes/tax';
import {
  createDashboardTaxComplianceRouter,
  createTaxComplianceRouter,
} from './routes/taxCompliance';
import type { TaxService } from './services/tax/taxService';
import {
  configuredTaxProviders,
  createConfiguredTaxService,
  reportTaxProviders,
} from './services/tax/configuredTax';
/**
 * Peable Gateway — backend entry point.
 *
 * Non-custodial by construction: this server never holds private keys or funds.
 * It orchestrates the PaymentIntent lifecycle — REST commands, realtime state
 * over Socket.io, a tip-driven settlement watcher, and signed webhooks — while
 * the payer's self-custody wallet signs and broadcasts the on-chain transaction.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import express, { type RequestHandler } from 'express';
import { Server as SocketServer } from 'socket.io';
import { oxy, workloadCredentials } from './oxy';
import type { OxyAccess } from './services/oxyAccess';
import {
  createOxyCors,
  createOxyRateLimit,
  createOxySocketCors,
  type EcosystemTraffic,
  oxyTrustProxy,
  startEcosystemTraffic,
} from '@oxy.so/core/server';
import { config } from './config';
import { connectPostgres, disconnectPostgres, isPostgresReady } from './db/postgres';
import { createPaymentIntentsRouter } from './routes/paymentIntents';
import { oxyGuard, requireOxyUser as oxyUserAuth } from './lib/http';
import { payerAwareCors } from './lib/payerCors';
import { createMerchantsRouter } from './routes/merchants';
import { createWebhookDeliveriesRouter } from './routes/webhookDeliveries';
import { createWebhookEndpointsRouter } from './routes/webhookEndpoints';
import { createEventsRouter } from './routes/events';
import { createCatalogRouter } from './routes/catalog';
import { createRequestLogsRouter } from './routes/requestLogs';
import { createSearchRouter } from './routes/search';
import { createReportingRouter } from './routes/reporting';
import { createIdentityRouter } from './routes/identity';
import { createTerminalRouter } from './routes/terminal';
import { startReportRunWorker, stopReportRunWorker } from './services/reporting/reportRunWorker';
import { startReportScheduler, stopReportScheduler } from './services/reporting/reportScheduler';
import { createTestHelpersRouter } from './routes/testHelpers';
import { flushRequestLogs, requestLogMiddleware } from './lib/requestLog';
import { createBillingEngineRouter, createPublicBillingRouter } from './routes/billingEngine';
import { createCatalogApiRouter } from './routes/catalogRoutes';
import { RADAR_ROUTES } from './routes/radar';
import { configureBillingEngine } from './services/billingEngine/runtime';
import { billingEngineCheckoutFulfiller } from './services/billingEngine/checkoutFulfiller';
import { registerSubscriptionCheckoutFulfiller } from './services/checkout/subscriptionFulfiller';
import { startBillingEngine, stopBillingEngine } from './services/billingEngine/scheduler';
import { createPaymentLinksRouter } from './routes/paymentLinks';
import { createCheckoutSessionsRouter } from './routes/checkoutSessions';
import { createBrandingRouter } from './routes/branding';
import {
  startSessionExpirySweeper,
  stopSessionExpirySweeper,
} from './services/checkout/sessionSweeper';
import { configureMailer, mailerFromEnv } from './services/email/mailer';
import {
  startCustomerEmailDispatcher,
  stopCustomerEmailDispatcher,
} from './services/email/dispatcher';
import { createSocialRouter } from './routes/social';
import { createEnrichRouter } from './routes/enrich';
import { createContributionsRouter } from './routes/contributions';
import { createDashboardRouter } from './routes/dashboard';
import { createProviderWebhooksRouter } from './routes/providerWebhooks';
import { createOxyFileEventsRouter } from './routes/oxyFileEvents';
import type { OxyFilesClient } from './services/oxyFiles/client';
import { startReferenceSync, stopReferenceSync } from './services/oxyFiles/referenceSync';
import {
  startReferenceReconciliation,
  stopReferenceReconciliation,
} from './services/oxyFiles/referenceReconciliation';
import { createConnectedAccountsRouter } from './routes/connectedAccounts';
import { createMoneyRouter, refuseMisplacedPeableAccount } from './routes/money';
import { startMoneyReconciliation, stopMoneyReconciliation } from './services/money/reconciliation';
import { createConnectRouter } from './routes/connect';
import { createTransfersRouter } from './routes/transfers';
import { createRefundsRouter } from './routes/refunds';
import { createChargesRouter } from './routes/charges';
import { createCustomersRouter } from './routes/customers';
import { createPaymentMethodsRouter } from './routes/paymentMethods';
import { createSetupIntentsRouter } from './routes/setupIntents';
import { createDisputesRouter } from './routes/disputes';
import { createFilesRouter } from './routes/files';
import { createPaymentMethodConfigurationsRouter } from './routes/paymentMethodConfigurations';
import { SettlementWatcher } from './services/settlementWatcher';
import type { PaymentIntentRow } from './db/payments/paymentIntentRepository';
import { getTransaction } from './services/explorer';
import type { SafeFetchFn } from './services/webhookDispatcher';
import { kickWebhookOutbox, startWebhookOutbox, stopWebhookOutbox } from './services/webhookOutbox';
import { startExpirySweeper, stopExpirySweeper } from './services/expirySweeper';
import { startRecipientKeySweeper, stopRecipientKeySweeper } from './services/faircoin/keyBinding';
import { startIdempotencySweeper, stopIdempotencySweeper } from './services/idempotencySweeper';
import { startEventSweeper, stopEventSweeper } from './services/eventSweeper';
import { startJudgeSweeper, stopJudgeSweeper } from './services/radar/judgeSweeper';
import { startRequestLogSweeper, stopRequestLogSweeper } from './services/requestLogSweeper';
import { startProviderEventDrain, stopProviderEventDrain } from './services/providerEventDrain';
import { startAccountSync, stopAccountSync } from './services/accountSync';
import {
  initPayerSocket,
  initSocket,
  emitIntentUpdate,
  payerSocketOptions,
  type SocketAuth,
} from './realtime/socket';
import {
  REQUEST_ID_HEADER,
  createInternalErrorHandler,
  requestIdMiddleware,
} from './lib/requestId';
import { IDEMPOTENT_REPLAYED_HEADER } from './lib/idempotency';
import { PEABLE_API_VERSION } from '@peable.to/shared-types';

/**
 * Flat per-window cap for the IDENTITY-AGNOSTIC public payer routes
 * (payment-link/checkout-session public display + public intent mint) —
 * deliberately tighter than the global limiter's `anonymousMax` default
 * (600/15min): the mint route derives a fresh watch-only address per call, so
 * an unthrottled caller could churn `Merchant.nextDerivationIndex`
 * (address-space DoS). Applied to BOTH `anonymousMax` and `authenticatedMax`
 * below — these routes grant no elevated capability to a signed-in Oxy
 * identity or a service token belonging to some OTHER app, so neither may
 * get a higher budget than a fully anonymous caller.
 */
const PUBLIC_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_RATE_LIMIT_MAX = 30;

export interface GatewayDeps {
  /** The process's ecosystem activity handle (`start` supplies it); absent in a test, where nothing is published. */
  traffic?: EcosystemTraffic;
  /** Peable Tax. Absent: the tax routes answer `tax_not_enabled`. */
  taxService?: TaxService;
  /**
   * Merchant service-auth middleware (default `oxy.middleware.service()`,
   * which verifies EdDSA service tokens against Oxy's public JWKS).
   */
  requireMerchant?: RequestHandler;
  /** Optional service-auth middleware for the dual-auth payer/merchant GET route. */
  optionalServiceAuth?: RequestHandler;
  /**
   * Rate limiter for the UNAUTHENTICATED payment-link/checkout-session payer
   * routes (default a dedicated `createOxyRateLimit` instance — see
   * `PUBLIC_RATE_LIMIT_*` above — separate from the global limiter mounted
   * below so its tighter anonymous budget applies ONLY to those four routes).
   */
  publicRateLimit?: RequestHandler;
  /** End-user Oxy auth for every user-authenticated router (default `requireOxyUser` from `lib/http.ts`). */
  requireOxyUser?: RequestHandler;
  /** What Oxy lets a signed-in person do (default the real `oxyAccess`). */
  access?: OxyAccess;
  /**
   * Identity verifier used ONLY for a socket connection that presents a
   * handshake token (default `oxy.middleware.socket()`); a connection with no
   * token is always let through anonymously — see
   * `realtime/socket.ts`'s `optionalSocketAuth`.
   */
  socketAuth?: SocketAuth;
  /** On-chain reader (default the real Explorer client). */
  getTransaction?: typeof getTransaction;
  /** SSRF-safe fetch used for webhook delivery (default the real one). */
  safeFetch?: SafeFetchFn;
  /** Oxy Files: avatar ownership, File uploads and evidence reads (default the real client). */
  oxyFiles?: OxyFilesClient;
}

export interface Gateway {
  /** The Express app `httpServer` serves; exposed so tests can read its settings (`trust proxy`). */
  app: express.Express;
  httpServer: HttpServer;
  /** The Oxy Socket.IO server (`/socket.io/`, Oxy origins). */
  io: SocketServer;
  /** The payer Socket.IO server (`PAYER_SOCKET_PATH`, any origin, no credentials). */
  payerIo: SocketServer;
  watcher: SettlementWatcher;
}

/**
 * Announce a transition the watcher has already COMMITTED.
 *
 * This used to be the whole fan-out: emit the socket frame, then look up the
 * merchant's endpoint and POST the webhook inline, then best-effort write a log
 * row. Two of those three moved (ADR 0001 D7). The outbox row is now written
 * inside `transitionIntent`'s transaction, so it cannot be lost between the
 * commit and the HTTP call, and the HTTP call itself belongs to the dispatcher,
 * which can retry across hours instead of across 150 milliseconds.
 *
 * What is left is the part that is not durable and must not be: a realtime
 * frame for whoever is watching, and a nudge asking the dispatcher to run its
 * next pass now rather than at the next tick.
 *
 * Still `async` and still never throwing, because `SettlementWatcher.check()`
 * awaits `onChange` inline per intent with no per-iteration try/catch of its
 * own. Exported for direct testing (`__tests__/onIntentChange.test.ts`).
 */
export async function onIntentChange(
  servers: readonly SocketServer[],
  intent: PaymentIntentRow,
  _safeFetch?: SafeFetchFn | undefined,
): Promise<void> {
  for (const io of servers) emitIntentUpdate(io, intent);
  kickWebhookOutbox();
  await Promise.resolve();
}

/**
 * Assemble the gateway (Express app + HTTP server + Socket.io + watcher) WITHOUT
 * starting it. Dependencies are injectable so integration tests can stub auth,
 * the on-chain reader, and webhook delivery, and drive `watcher.check()` by hand.
 */
export function createGateway(deps: GatewayDeps = {}): Gateway {
  const app = express();
  // `req.ip` is the real client, before or after the hostname is proxied by
  // Cloudflare: `oxyTrustProxy` trusts the socket peer only when private (the
  // ALB) and the next hop only when it is a Cloudflare edge address, so a
  // forged `X-Forwarded-For` is never believed. `trust proxy: 1` answered the
  // Cloudflare edge for a proxied hostname, and every request would collapse
  // into a handful of buckets in `createOxyRateLimit` and the public limiter
  // below. Set first, before anything that can read `req.ip`. Engine.io has no
  // trust-proxy setting; `realtime/socket.ts`'s `socketClientIp` applies the
  // same rule to the handshake request.
  app.set('trust proxy', oxyTrustProxy);
  // Before everything else, so every answer — health probes, CORS refusals,
  // rate-limit 429s, provider-webhook signature failures — names its request.
  app.use(requestIdMiddleware);
  if (deps.traffic) app.use(deps.traffic.observeHttp);

  // Unauthenticated liveness probe for the ALB target-group health check.
  // Mounted first so it is never CORS-blocked or rate-limited, and returns 200
  // regardless of auth (every other route is auth-gated). It reveals nothing.
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * READINESS, which is a different question from liveness.
   *
   * `/health` says the process is up. This says it can serve: the gateway is
   * Postgres-native, every route reads it, and a task listening with a dead
   * pool answers every real request with a 500 while a liveness probe keeps
   * reporting it healthy. A deploy gate and the container-build check in CI
   * poll THIS one, which is what makes "the image boots" a claim about serving
   * requests rather than about `listen()` returning.
   *
   * 503, not 500, and no detail: an unauthenticated route must not describe the
   * database it failed to reach.
   */
  app.get('/ready', (_req, res) => {
    void isPostgresReady().then((ready) => {
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
    });
  });

  // `appOrigins`: `createOxyCors`'s built-in Oxy-family allowlist only trusts
  // ONE-LABEL `*.oxy.so` subdomains, so a two-label host like the F2.5
  // dashboard (`dashboard.peable.to`) must be listed explicitly via
  // `config.allowedOrigins` (`PEABLE_ALLOWED_ORIGINS`) — the SAME list the
  // Socket.IO's `createOxySocketCors` below reads.
  // A browser reading a response may see which request it was and whether it
  // is a replay of an earlier one (ADR 0014 D1, D3).
  //
  // The PAYER routes (`lib/payerCors.ts`) answer any origin without
  // credentials: their authority is the client secret, not the page, and a
  // merchant's own site runs Pay with Peable. Every other route keeps this.
  app.use(
    payerAwareCors(
      createOxyCors({
        appOrigins: config.allowedOrigins,
        exposedHeaders: [REQUEST_ID_HEADER, IDEMPOTENT_REPLAYED_HEADER],
      }),
    ),
  );

  // ─── MOUNTED BEFORE `express.json()` AND BEFORE THE GLOBAL RATE LIMITER ───
  //
  // Stripe signs the exact bytes it sent, so a JSON parser reaching the stream
  // first does not weaken verification — it breaks EVERY delivery, permanently.
  // This router brings its own `express.raw`. Moving it below `express.json()`,
  // or "unifying" its parser, silently fails every signature; moving it below
  // `createOxyRateLimit` puts the entire provider in one per-IP bucket, because
  // every Stripe delivery on earth comes from a small pool of their addresses.
  //
  // `routes/providerWebhooks.ts` has the full argument, and
  // `routes/__tests__/providerWebhooks.integration.test.ts` asserts this
  // ordering against the real chain so a reorder is a red build.
  app.use(createProviderWebhooksRouter());
  // Oxy's file events, for the same two reasons: the signature covers the raw
  // bytes, and every delivery comes from Oxy's own few addresses. The router
  // brings its own `express.raw`; `routes/oxyFileEvents.ts` has the argument and
  // `routes/__tests__/oxyFileEvents.realdb.test.ts` asserts the order.
  app.use(createOxyFileEventsRouter());

  app.use(createOxyRateLimit(oxy));
  app.use(express.json());
  // Before every router: it records each answered merchant `/v1` request on
  // the response's `finish` (`lib/requestLog.ts`).
  app.use(requestLogMiddleware);
  app.use(((_req, res, next) => {
    res.setHeader('Peable-Version', PEABLE_API_VERSION);
    next();
  }) as RequestHandler);
  app.use(refuseMisplacedPeableAccount);
  // Both refuse in the ONE error envelope (`oxyGuard`, ADR 0014 D1), not the library's own shape.
  const requireMerchant: RequestHandler =
    deps.requireMerchant ?? oxyGuard(oxy.middleware.service());
  const optionalServiceAuth: RequestHandler =
    deps.optionalServiceAuth ?? oxyGuard(oxy.middleware.auth({ optional: true }));
  const publicRateLimit: RequestHandler =
    deps.publicRateLimit ??
    createOxyRateLimit(oxy, {
      anonymousMax: PUBLIC_RATE_LIMIT_MAX,
      // `createOxyRateLimit` resolves `oxy.middleware.auth({ optional: true })` BEFORE
      // limiting regardless of route auth, so ANY caller with a valid Oxy
      // session or service token — not just a merchant of THIS gateway —
      // would otherwise get the 5000/window authenticated default on these
      // identity-agnostic public routes. Pin it to the same cap so having
      // an unrelated Oxy account can't buy 167x the intended budget for the
      // exact abuse (`nextDerivationIndex` churn) this limiter exists to bound.
      authenticatedMax: PUBLIC_RATE_LIMIT_MAX,
      windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
    });

  const requireOxyUser: RequestHandler = deps.requireOxyUser ?? oxyUserAuth;

  // Before every resource router: `/v1/charges/search` is not `/v1/charges/:id`.
  app.use(createSearchRouter({ requireMerchant }));
  app.use(createPaymentIntentsRouter({ requireMerchant, optionalServiceAuth }));
  app.use(createSocialRouter({ requireOxyUser }));
  app.use(createEnrichRouter({ requireOxyUser }));
  app.use(createMerchantsRouter({ requireMerchant, files: deps.oxyFiles }));
  app.use(createConnectedAccountsRouter({ requireMerchant }));
  app.use(createMoneyRouter({ requireMerchant }));
  // The SELLER's half of connected accounts (ADR 0012 D3): Oxy USER auth, never
  // a service credential — a platform cannot register a seller's key.
  app.use(createConnectRouter({ requireOxyUser }));
  app.use(createTransfersRouter({ requireMerchant }));
  app.use(createRefundsRouter({ requireMerchant }));
  app.use(createChargesRouter({ requireMerchant }));
  app.use(createCustomersRouter({ requireMerchant }));
  app.use(createPaymentMethodsRouter({ requireMerchant }));
  app.use(createSetupIntentsRouter({ requireMerchant, optionalServiceAuth }));
  app.use(createDisputesRouter({ requireMerchant, files: deps.oxyFiles }));
  app.use(createFilesRouter({ requireMerchant, files: deps.oxyFiles }));
  app.use(createPaymentMethodConfigurationsRouter({ requireMerchant }));
  app.use(createWebhookDeliveriesRouter({ requireMerchant, safeFetch: deps.safeFetch }));
  app.use(createWebhookEndpointsRouter({ requireMerchant, safeFetch: deps.safeFetch }));
  app.use(createEventsRouter({ requireMerchant }));
  app.use(createCatalogRouter({ requireMerchant }));
  app.use(createRequestLogsRouter({ requireMerchant }));
  app.use(createReportingRouter({ requireMerchant }));
  app.use(createIdentityRouter({ requireMerchant }));
  app.use(createTerminalRouter({ requireMerchant }));
  app.use(createTestHelpersRouter({ requireMerchant }));
  // The billing engine (ADR 0018).
  configureBillingEngine({ tax: deps.taxService });
  // Checkout's `mode: 'subscription'` is the engine's to fulfil (ADR 0018).
  registerSubscriptionCheckoutFulfiller(billingEngineCheckoutFulfiller);
  app.use(createBillingEngineRouter({ requireMerchant }));
  app.use(createPublicBillingRouter({ publicRateLimit }));
  // Risk rules and reviews (ADR 0022).
  app.use(createCatalogApiRouter(RADAR_ROUTES, { requireMerchant }));
  // The whole public API's OpenAPI 3.1 document, generated from the contracts
  // once per process (ADR 0014 D5); `docs/openapi.json` is the committed copy.
  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use(createContributionsRouter({ requireOxyUser, access: deps.access }));
  // Checkout (Orbit Phase 3): sessions price with Peable Tax when asked to.
  const checkout = { tax: deps.taxService };
  app.use(createPaymentLinksRouter({ requireMerchant, publicRateLimit, checkout }));
  app.use(createCheckoutSessionsRouter({ requireMerchant, publicRateLimit, checkout }));
  app.use(createBrandingRouter({ requireMerchant, files: deps.oxyFiles }));
  app.use(createTaxRouter({ requireMerchant, tax: deps.taxService }));
  app.use(createDashboardTaxRouter({ tax: deps.taxService, requireOxyUser, access: deps.access }));
  app.use(createTaxComplianceRouter({ requireMerchant }));
  app.use(createDashboardTaxComplianceRouter({ requireOxyUser, access: deps.access }));
  app.use(
    createDashboardRouter({
      requireOxyUser,
      access: deps.access,
      safeFetch: deps.safeFetch,
      files: deps.oxyFiles,
      checkout,
    }),
  );

  app.use(createInternalErrorHandler());

  const httpServer = createServer(app);
  // The browsers `createOxyCors` admits, on BOTH transports: `cors` answers
  // long-polling, `allowRequest` refuses a WebSocket handshake from any other
  // origin (browsers apply no CORS to an upgrade). No credentials: auth is a
  // token in the handshake, not a cookie.
  const io = new SocketServer(httpServer, {
    ...createOxySocketCors({ appOrigins: config.allowedOrigins, allowCredentials: false }),
  });
  initSocket(io, { socketAuth: deps.socketAuth, traffic: deps.traffic });
  // The PAYER socket (`PAYER_SOCKET_PATH`) answers any origin without
  // credentials, the rule of the payer HTTP routes: a merchant's own site runs
  // Pay with Peable, and `subscribe`'s client secret is the whole authority.
  // A separate server because Socket.IO's CORS is per server.
  const payerIo = new SocketServer(httpServer, payerSocketOptions());
  initPayerSocket(payerIo, deps.traffic);

  const watcher = new SettlementWatcher({
    getTransaction: deps.getTransaction ?? getTransaction,
    onChange: (intent) => onIntentChange([io, payerIo], intent, deps.safeFetch),
  });

  return { app, httpServer, io, payerIo, watcher };
}

/**
 * Production entry: open the database, boot the watcher and the outbox
 * dispatcher, and listen.
 *
 * `connectPostgres` proves the connection with one round trip before anything
 * listens, so a bad `DATABASE_URL` is a boot failure rather than the 500 of
 * whichever request first happens to need the database.
 *
 * The outbox dispatcher is started HERE and not in `createGateway`, alongside
 * the watcher and for the same reason: a suite builds gateways to exercise
 * routes and must not thereby acquire a background loop making real HTTP
 * requests. Both are `.unref()`-ed, so neither keeps the process alive on its
 * own — and both are deliberately started per PROCESS, so N tasks share the
 * queue through `SKIP LOCKED` rather than needing a leader.
 */
export async function start(options: { listenHost?: string } = {}): Promise<Gateway> {
  const database = await connectPostgres();
  for (const mode of ['test', 'live'] as const) {
    const providerConfig = config.stripe[mode];
    if (!providerConfig?.cardRail) continue;
    const { verifyStripeAccountIdentity } = await import(
      './services/providers/stripe/accountIdentity'
    );
    const { getStripeClient } = await import('./services/providers/stripe/client');
    await verifyStripeAccountIdentity({
      enabled: true,
      expectedAccountId: providerConfig.accountId,
      readAccount: () => getStripeClient(mode).accounts.retrieve(null),
    });
  }
  const taxProviders = configuredTaxProviders();
  const taxService = createConfiguredTaxService(database, taxProviders);
  void reportTaxProviders(taxProviders);
  const traffic = startEcosystemTraffic({
    service: 'peable',
    ready: () => gateway.httpServer.listening,
    workloadCredentials,
  });
  const gateway = createGateway({ taxService, traffic });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    gateway.watcher.stop();
    stopWebhookOutbox();
    stopExpirySweeper();
    stopRecipientKeySweeper();
    stopIdempotencySweeper();
    stopEventSweeper();
    stopJudgeSweeper();
    stopRequestLogSweeper();
    stopMoneyReconciliation();
    stopSessionExpirySweeper();
    stopCustomerEmailDispatcher();
    stopReportRunWorker();
    stopReportScheduler();
    stopBillingEngine();
    stopProviderEventDrain();
    stopAccountSync();
    stopReferenceSync();
    stopReferenceReconciliation();
    // The payer server's own sockets and engine only: `close()` would also
    // close the shared HTTP server, and the Oxy server's `close` below must be
    // the one that does, or its callback waits on a `close` already emitted.
    gateway.payerIo.disconnectSockets(true);
    gateway.payerIo.engine.close();
    gateway.io.close(() => {
      void Promise.allSettled([traffic.stop(), flushRequestLogs()])
        .then(async (results) => {
          await disconnectPostgres();
          if (results.some((result) => result.status === 'rejected'))
            throw new Error('Shutdown component failed');
        })
        .catch(() => {
          console.error('Failed to close activity publisher or database');
          process.exitCode = 1;
        });
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  gateway.watcher.start();
  startWebhookOutbox({ safeFetch: undefined });
  startExpirySweeper();
  // ADR 0002 (amended 2026-11-06): no FairCoin payment stays payable under a
  // recipient key that was replaced.
  startRecipientKeySweeper();
  startIdempotencySweeper();
  startEventSweeper();
  startJudgeSweeper();
  startRequestLogSweeper();
  startMoneyReconciliation();
  startSessionExpirySweeper();
  // Customer emails: the transport is injected. With none configured the
  // outbox keeps what is owed (and expires it after its window) — see
  // `services/email/mailer.ts` for the production wiring.
  configureMailer(mailerFromEnv());
  startCustomerEmailDispatcher();
  startReportRunWorker();
  // Report schedules fire ordinary runs into the worker's queue: leased, per process.
  startReportScheduler();
  // The billing engine's scheduler (ADR 0018 §5): leased, per process.
  startBillingEngine();
  // Started unconditionally, including where the card rail is off: a deployment
  // that had Stripe configured and then had it removed still has stored events
  // that have to be finished, and a drain gated on a mode's card rail would
  // leave them unprocessed with no sign that anything was wrong. (An event of a
  // mode with no key at all is refused per event, visibly — ADR 0017.) With no
  // events the pass reads an empty partial index and does nothing.
  startProviderEventDrain();
  // The backstop for a missed `account.updated`. Gated on nothing, like the
  // drain: with no accounts the pass reads an empty batch and does nothing, and
  // with the rail off it stops after the first refusal rather than logging the
  // same line per account.
  startAccountSync();
  // The durable outbox retries missing/revoked workload authority; ECS markers
  // cannot decide whether a temporary development role can authenticate.
  startReferenceSync();
  if (config.oxyFiles.reconciliationMode !== 'off') {
    startReferenceReconciliation({ dryRun: config.oxyFiles.reconciliationMode === 'dry-run' });
  }
  gateway.httpServer.listen(config.port, options.listenHost);
  return gateway;
}

if (import.meta.main) {
  start().catch((error: unknown) => {
    process.emitWarning(error instanceof Error ? error : new Error(String(error)));
    process.exitCode = 1;
  });
}
