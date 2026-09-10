/**
 * Peable Gateway — backend entry point.
 *
 * Non-custodial by construction: this server never holds private keys or funds.
 * It orchestrates the PaymentIntent lifecycle — REST commands, realtime state
 * over Socket.io, a tip-driven settlement watcher, and signed webhooks — while
 * the payer's self-custody wallet signs and broadcasts the on-chain transaction.
 */
import { createServer, type Server as HttpServer } from "node:http";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { Server as SocketServer } from "socket.io";
import { oxyClient } from "@oxy.so/core";
import { createOxyCors, createOxyRateLimit } from "@oxy.so/core/server";
import { config } from "./config";
import { connectPostgres } from "./db/postgres";
import { createPaymentIntentsRouter } from "./routes/paymentIntents";
import { createMerchantsRouter } from "./routes/merchants";
import { createWebhookDeliveriesRouter } from "./routes/webhookDeliveries";
import { createPaymentLinksRouter } from "./routes/paymentLinks";
import { createCheckoutSessionsRouter } from "./routes/checkoutSessions";
import { createSocialRouter } from "./routes/social";
import { createEnrichRouter } from "./routes/enrich";
import { createDashboardRouter } from "./routes/dashboard";
import { createProviderWebhooksRouter } from "./routes/providerWebhooks";
import { createConnectedAccountsRouter } from "./routes/connectedAccounts";
import { createTransfersRouter } from "./routes/transfers";
import { createRefundsRouter } from "./routes/refunds";
import { createDisputesRouter } from "./routes/disputes";
import { SettlementWatcher } from "./services/settlementWatcher";
import type { PaymentIntentRow } from "./db/payments/paymentIntentRepository";
import { getTransaction } from "./services/explorer";
import type { SafeFetchFn } from "./services/webhookDispatcher";
import { kickWebhookOutbox, startWebhookOutbox } from "./services/webhookOutbox";
import { startExpirySweeper } from "./services/expirySweeper";
import { startProviderEventDrain } from "./services/providerEventDrain";
import { startAccountSync } from "./services/accountSync";
import {
  initSocket,
  emitIntentUpdate,
  type SocketAuth,
} from "./realtime/socket";

/** Date-based API version, echoed on every response (Stripe-parity). */
const PEABLE_VERSION = "2026-07-18";

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
  /**
   * Merchant service-auth middleware (default
   * `oxyClient.serviceAuth({ jwtSecret: config.serviceJwtSecret })`).
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
  /** End-user Oxy auth for the social + enrich + dashboard routes (default `createOxyAuthMiddleware(oxyClient)`). */
  requireOxyUser?: RequestHandler;
  /**
   * Identity verifier used ONLY for a socket connection that presents a
   * handshake token (default `oxyClient.authSocket()`); a connection with no
   * token is always let through anonymously — see
   * `realtime/socket.ts`'s `optionalSocketAuth`.
   */
  socketAuth?: SocketAuth;
  /** On-chain reader (default the real Explorer client). */
  getTransaction?: typeof getTransaction;
  /** SSRF-safe fetch used for webhook delivery (default the real one). */
  safeFetch?: SafeFetchFn;
}

export interface Gateway {
  httpServer: HttpServer;
  io: SocketServer;
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
  io: SocketServer,
  intent: PaymentIntentRow,
  _safeFetch?: SafeFetchFn | undefined,
): Promise<void> {
  emitIntentUpdate(io, intent);
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

  // Trust the ALB as exactly one hop: `req.ip` then resolves through
  // `X-Forwarded-For` to the real client address instead of the ALB's own
  // address. Without this, EVERY request behind the shared ALB collapses
  // into the same handful of buckets in `createOxyRateLimit` below — the
  // exact "shared load balancer IP" failure mode that library's own doc
  // comment (`@oxy.so/core/server/rateLimit.ts`) warns about. Matches every
  // other Oxy backend on ECS (oxy-api, mention, homiio, syra). Engine.io
  // (the realtime layer's transport) has no equivalent trust-proxy concept
  // of its own and is NOT affected by this setting — see
  // `realtime/socket.ts`'s `resolveClientIp`, which reads the same header
  // directly for the same reason.
  app.set("trust proxy", 1);

  // Unauthenticated liveness probe for the ALB target-group health check.
  // Mounted first so it is never CORS-blocked or rate-limited, and returns 200
  // regardless of auth (every other route is auth-gated). It reveals nothing.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // `appOrigins`: `createOxyCors`'s built-in Oxy-family allowlist only trusts
  // ONE-LABEL `*.oxy.so` subdomains, so a two-label host like the F2.5
  // dashboard (`dashboard.peable.to`) must be listed explicitly via
  // `config.allowedOrigins` (`PEABLE_ALLOWED_ORIGINS`) — the SAME list the
  // Socket.io `cors.origin` check below already reads.
  app.use(createOxyCors({ appOrigins: config.allowedOrigins }));

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

  app.use(createOxyRateLimit(oxyClient));
  app.use(express.json());
  app.use(((_req, res, next) => {
    res.setHeader("Peable-Version", PEABLE_VERSION);
    next();
  }) as RequestHandler);
  const requireMerchant: RequestHandler =
    deps.requireMerchant ??
    oxyClient.serviceAuth({ jwtSecret: config.serviceJwtSecret });
  const optionalServiceAuth: RequestHandler =
    deps.optionalServiceAuth ??
    oxyClient.auth({ jwtSecret: config.serviceJwtSecret, optional: true });
  const publicRateLimit: RequestHandler =
    deps.publicRateLimit ??
    createOxyRateLimit(oxyClient, {
      anonymousMax: PUBLIC_RATE_LIMIT_MAX,
      // `createOxyRateLimit` resolves `oxy.auth({ optional: true })` BEFORE
      // limiting regardless of route auth, so ANY caller with a valid Oxy
      // session or service token — not just a merchant of THIS gateway —
      // would otherwise get the 5000/window authenticated default on these
      // identity-agnostic public routes. Pin it to the same cap so having
      // an unrelated Oxy account can't buy 167x the intended budget for the
      // exact abuse (`nextDerivationIndex` churn) this limiter exists to bound.
      authenticatedMax: PUBLIC_RATE_LIMIT_MAX,
      windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
    });

  app.use(createPaymentIntentsRouter({ requireMerchant, optionalServiceAuth }));
  app.use(createSocialRouter({ requireOxyUser: deps.requireOxyUser }));
  app.use(createEnrichRouter({ requireOxyUser: deps.requireOxyUser }));
  app.use(createMerchantsRouter({ requireMerchant }));
  app.use(createConnectedAccountsRouter({ requireMerchant }));
  app.use(createTransfersRouter({ requireMerchant }));
  app.use(createRefundsRouter({ requireMerchant }));
  app.use(createDisputesRouter({ requireMerchant }));
  app.use(
    createWebhookDeliveriesRouter({ requireMerchant, safeFetch: deps.safeFetch }),
  );
  app.use(createPaymentLinksRouter({ requireMerchant, publicRateLimit }));
  app.use(createCheckoutSessionsRouter({ requireMerchant, publicRateLimit }));
  app.use(
    createDashboardRouter({ requireOxyUser: deps.requireOxyUser, safeFetch: deps.safeFetch }),
  );

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: { type: "api_error", message } });
  };
  app.use(errorHandler);

  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    // No reflected origins and no credentials (auth is a token in the handshake,
    // not a cookie), so a cross-site page cannot hijack a socket. A browser
    // origin must be explicitly allowlisted; non-browser clients send no Origin.
    cors: {
      origin(origin, callback): void {
        if (origin === undefined || config.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: false,
    },
  });
  initSocket(io, { socketAuth: deps.socketAuth });

  const watcher = new SettlementWatcher({
    getTransaction: deps.getTransaction ?? getTransaction,
    onChange: (intent) => onIntentChange(io, intent, deps.safeFetch),
  });

  return { httpServer, io, watcher };
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
export async function start(): Promise<void> {
  await connectPostgres();
  const gateway = createGateway();
  gateway.watcher.start();
  startWebhookOutbox({ safeFetch: undefined });
  startExpirySweeper();
  // Started unconditionally, including where the card rail is off: a deployment
  // that had Stripe configured and then had it removed still has stored events
  // that have to be finished, and a drain gated on `config.stripe.enabled`
  // would leave them unprocessed with no sign that anything was wrong. With no
  // events the pass reads an empty partial index and does nothing.
  startProviderEventDrain();
  // The backstop for a missed `account.updated`. Gated on nothing, like the
  // drain: with no accounts the pass reads an empty batch and does nothing, and
  // with the rail off it stops after the first refusal rather than logging the
  // same line per account.
  startAccountSync();
  gateway.httpServer.listen(config.port);
}

if (import.meta.main) {
  start().catch((error: unknown) => {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error)),
    );
    process.exitCode = 1;
  });
}
