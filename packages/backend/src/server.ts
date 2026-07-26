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
import { oxyClient } from "@oxyhq/core";
import { createOxyCors, createOxyRateLimit } from "@oxyhq/core/server";
import type {
  PaymentIntentStatus,
  WebhookEventType,
} from "@peable.to/shared-types";
import { config } from "./config";
import { connectPostgres } from "./db/postgres";
import { getDb } from "./db/postgres";
import { findWebhookTarget } from "./db/merchants/merchantRepository";
import { insertWebhookDelivery } from "./db/webhooks/webhookDeliveryRepository";
import { createPaymentIntentsRouter } from "./routes/paymentIntents";
import { createMerchantsRouter } from "./routes/merchants";
import { createWebhookDeliveriesRouter } from "./routes/webhookDeliveries";
import { createPaymentLinksRouter } from "./routes/paymentLinks";
import { createCheckoutSessionsRouter } from "./routes/checkoutSessions";
import { createSocialRouter } from "./routes/social";
import { createWalletRouter } from "./routes/wallet";
import { createEnrichRouter } from "./routes/enrich";
import { createDashboardRouter } from "./routes/dashboard";
import { SettlementWatcher } from "./services/settlementWatcher";
import { ExpirySweeper } from "./services/expirySweeper";
import type { PaymentIntentRow } from "./db/payments/paymentIntentRepository";
import { getTransaction } from "./services/explorer";
import {
  buildEvent,
  deliver,
  type SafeFetchFn,
} from "./services/webhookDispatcher";
import {
  initSocket,
  emitIntentUpdate,
  type SocketAuth,
} from "./realtime/socket";
import { toPaymentIntentDTO } from "./lib/serialize";

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

/** Which statuses emit a webhook, and the Stripe-parity event type for each. */
const WEBHOOK_EVENT_FOR: Partial<
  Record<PaymentIntentStatus, WebhookEventType>
> = {
  confirming: "payment_intent.confirming",
  settled: "payment_intent.settled",
  failed: "payment_intent.failed",
  rejected: "payment_intent.rejected",
  expired: "payment_intent.expired",
};

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
  /**
   * Drives unpaid intents past `expires_at` into `expired`. Exposed for the
   * same reason as `watcher`: a test drives `check()` by hand rather than
   * waiting on the timer.
   */
  expirySweeper: ExpirySweeper;
}

/**
 * When the watcher advances an intent, fan the change out to both transports:
 * the payer's realtime socket room AND the merchant's signed webhook. Webhook
 * delivery is best-effort (never throws) so it cannot stall the watcher.
 * Exported for direct testing (`__tests__/onIntentChange.test.ts`).
 */
export async function onIntentChange(
  io: SocketServer,
  intent: PaymentIntentRow,
  safeFetch: SafeFetchFn | undefined,
): Promise<void> {
  emitIntentUpdate(io, intent);

  const eventType = WEBHOOK_EVENT_FOR[intent.status];
  if (eventType === undefined) return;

  const db = getDb();
  // The webhook URL and its signing secret are loaded together, by the one
  // read that is allowed to select `webhook_secret` — a protected column. A
  // merchant with either half missing has no webhook configured.
  const target = await findWebhookTarget(db, intent.merchantId);
  if (!target) return;

  const event = buildEvent(eventType, toPaymentIntentDTO(intent));
  const outcome = await deliver(
    event,
    { url: target.url, secret: target.secret },
    safeFetch ? { safeFetch } : {},
  );

  // Persisting the delivery log is best-effort, same as `deliver()` itself —
  // a transient database write failure here must never abort the settlement
  // watcher's poll loop (`SettlementWatcher.check()` awaits `onChange` inline
  // per intent, with no per-iteration try/catch of its own).
  try {
    await insertWebhookDelivery(db, {
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      eventId: event.id,
      eventType,
      url: target.url,
      attempts: outcome.attempts,
      delivered: outcome.delivered,
    });
  } catch (error) {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
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
  // comment (`@oxyhq/core/server/rateLimit.ts`) warns about. Matches every
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

  // Built BEFORE the routers are mounted, because `submit_tx` and `reject`
  // need to fan their state change out over `io`. Express dispatches routes at
  // request time, so mounting them after `createServer(app)` changes nothing
  // about their order or behaviour.
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

  app.use(
    createPaymentIntentsRouter({
      requireMerchant,
      optionalServiceAuth,
      notifyIntentChange: (intent) => onIntentChange(io, intent, deps.safeFetch),
    }),
  );
  app.use(createSocialRouter({ requireOxyUser: deps.requireOxyUser }));
  app.use(createEnrichRouter({ requireOxyUser: deps.requireOxyUser }));
  app.use(createWalletRouter({ requireOxyUser: deps.requireOxyUser }));
  app.use(createMerchantsRouter({ requireMerchant }));
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


  const watcher = new SettlementWatcher({
    getTransaction: deps.getTransaction ?? getTransaction,
    onChange: (intent) => onIntentChange(io, intent, deps.safeFetch),
  });

  // Same fanout as the watcher's: expiry is a status change like any other, so
  // it reaches the payer's socket room and the merchant's webhook by the one
  // path that knows how to do both.
  const expirySweeper = new ExpirySweeper({
    onChange: (intent) => onIntentChange(io, intent, deps.safeFetch),
  });

  return { httpServer, io, watcher, expirySweeper };
}

/**
 * Production entry: open the database, boot the watcher and the expiry
 * sweeper, and listen.
 *
 * `connectPostgres` proves the connection with one round trip before anything
 * listens, so a bad `DATABASE_URL` is a boot failure rather than the 500 of
 * whichever request first happens to need the database.
 */
export async function start(): Promise<void> {
  await connectPostgres();
  const gateway = createGateway();
  gateway.watcher.start();
  gateway.expirySweeper.start();
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
