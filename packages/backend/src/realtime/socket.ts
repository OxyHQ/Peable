import { observeEcosystemSocket } from '../ecosystemActivity';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions, Socket } from 'socket.io';
import { PAYER_SOCKET_PATH } from '@peable.to/contracts/vocabulary';
import { oxy } from '../oxy';
import { resolveClientIp, verifySecret } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import { findIntentByPublicId } from '../db/payments/paymentIntentRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { toPayerPaymentIntentDTO } from '../lib/serialize';

/** Realtime room a single intent's updates are broadcast to. */
export function intentRoom(id: string): string {
  return `intent:${id}`;
}

/** Socket.io connection-authentication middleware `(socket, next) => …`. */
export type SocketAuth = (socket: unknown, next: (err?: Error) => void) => void | Promise<void>;

export interface SocketDeps {
  /**
   * Override the MANDATORY identity verifier invoked for a connection that
   * DOES present a handshake token (tests inject a stub; prod uses
   * `oxy.middleware.socket()`). Always wrapped in `optionalSocketAuth` below —
   * a connection with no token is let through anonymously without ever
   * calling this verifier.
   */
  socketAuth?: SocketAuth;
}

/**
 * Wrap a MANDATORY identity-verifying socket middleware so identity becomes
 * OPTIONAL on the connection itself: a handshake with no `auth.token` is let
 * through anonymously (`socket.user` / `socket.data.userId` stay unset). A
 * handshake that DOES present a token is still fully verified by the wrapped
 * middleware, and the connection is REJECTED if that token is invalid — a bad
 * token is never silently downgraded to an anonymous connection.
 *
 * Anonymous payers get no identity from the connection at all; they instead
 * prove authorization per-intent through the `subscribe` capability check
 * below (a verified `client_secret`) — the same checkout-payer model Stripe
 * uses. This is why the connection can safely go identity-optional: nothing
 * reachable from an anonymous socket is identity-scoped (see `initSocket`).
 */
export function optionalSocketAuth(requireIdentity: SocketAuth): SocketAuth {
  return (socket, next) => {
    const handshake = (socket as { handshake?: { auth?: { token?: unknown } } }).handshake;
    const token = handshake?.auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      next();
      return;
    }
    void requireIdentity(socket, next);
  };
}

interface SubscribeRequest {
  intentId: string;
  clientSecret: string;
}

/** The `subscribe` frame on the wire: `{ intent_id, client_secret }` (ADR 0014 D1). */
function parseSubscribe(payload: unknown): SubscribeRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { intent_id: intentId, client_secret: clientSecret } = payload as Record<string, unknown>;
  if (typeof intentId !== 'string' || typeof clientSecret !== 'string') {
    return null;
  }
  return { intentId, clientSecret };
}

/* -------------------------------------------------------------------------
 * Throttling — defense-in-depth for the anonymous realtime surface.
 *
 * `optionalSocketAuth` above made the CONNECTION identity-optional so a
 * checkout/embed payer can reach `subscribe` (see its doc comment above).
 * That left the connection itself, and `subscribe`, reachable by anyone with
 * no identity to hold accountable — and, unlike the REST API, with no rate
 * limiter at all: `createOxyRateLimit` (`server.ts`) is Express-only and
 * never sees engine.io's HTTP upgrade or WebSocket frames. Reviewed as a
 * non-blocking MINOR (sec-realtime): no data leak — the capability check
 * below is untouched, `client_secret` stays un-guessable — pure
 * resource-abuse (unbounded connections; unbounded indexed
 * `PaymentIntent.findOne` calls per `subscribe`). The two throttles below
 * close it.
 * ---------------------------------------------------------------------- */

/**
 * Minimal in-memory fixed-window counter — the same algorithm
 * `express-rate-limit`'s default `MemoryStore` uses (see the pair limiter in
 * `routes/social.ts`), reimplemented here because socket.io connection
 * middleware and event handlers have no Express `req`/`res` to hand
 * `express-rate-limit`.
 *
 * IN-MEMORY, PER-INSTANCE: with more than one gateway task behind the ALB,
 * each instance enforces its own independent budget — an attacker spread
 * across N instances effectively gets N× the caps below. Acceptable for v1,
 * same caveat already logged for the `routes/social.ts` pair limiter; a
 * horizontal deploy needs a shared (Redis-backed) store, unique-prefixed per
 * limiter the way `rate-limit-redis` is used elsewhere in this ecosystem.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** Record one hit for `key`; returns `false` once `key` is over budget for the current window. */
  consume(key: string, now: number = Date.now()): boolean {
    const state = this.hits.get(key);
    if (state === undefined || now >= state.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (state.count >= this.max) {
      return false;
    }
    state.count += 1;
    return true;
  }

  /** Drop expired entries — called periodically so a long-lived process's map can't grow unboundedly. */
  sweep(now: number = Date.now()): void {
    for (const [key, state] of this.hits) {
      if (now >= state.resetAt) {
        this.hits.delete(key);
      }
    }
  }
}

/** How often `initSocket`'s limiter maps are swept of expired entries. */
const LIMITER_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-IP cap on NEW socket connections. A legitimate checkout/embed page
 * opens exactly one; 20/minute leaves generous headroom for shared corporate
 * NAT / mobile-carrier CGNAT and flaky-network reconnects while still
 * bounding a spam loop that today pays no cost at all. Exported so tests
 * assert against the authoritative values rather than a magic number that
 * could silently drift out of sync with the throttle.
 */
export const IP_CONNECT_WINDOW_MS = 60_000;
export const IP_CONNECT_MAX = 20;

/**
 * Per-socket cap on `subscribe` calls. A legitimate payer subscribes to one
 * intent (occasionally a couple — e.g. a cart with several payment links);
 * 20/minute is far above any real checkout flow while bounding a socket that
 * loops `subscribe` to churn indexed `PaymentIntent.findOne` lookups.
 */
export const SUBSCRIBE_WINDOW_MS = 60_000;
export const SUBSCRIBE_MAX_PER_WINDOW = 20;

/**
 * The real client address of a socket.io connection, for the per-IP throttle.
 *
 * Engine.io has no trust-proxy concept of its own: `socket.handshake.address`
 * is the raw TCP peer, which behind the ALB is the ALB. `resolveClientIp`
 * (`@oxy.so/core/server`) walks `X-Forwarded-For` from the socket outward by
 * the SAME rule `oxyTrustProxy` gives `req.ip` in `server.ts`: the socket peer
 * is trusted only when private (the ALB), the next hop only when it is a
 * Cloudflare edge address, nothing further out. So a hostname proxied by
 * Cloudflare (`<client>, <cloudflare>`) and a DNS-only one (`<client>`) both
 * answer the payer, and a forged left prefix is never believed. Taking the
 * right-most entry by hand, as this did, put every proxied payer in the bucket
 * of whichever Cloudflare edge they reached.
 */
export function socketClientIp(socket: unknown): string {
  const request = (socket as { request?: IncomingMessage }).request;
  return (request === undefined ? undefined : resolveClientIp(request)) ?? 'unknown';
}

/**
 * Socket.io connection middleware enforcing `IP_CONNECT_MAX` new connections
 * per `IP_CONNECT_WINDOW_MS` per client IP. Wired BEFORE `optionalSocketAuth`
 * in `initSocket` so it also shields the identity verifier itself from a
 * connection-spam loop, and applies uniformly to authed and anonymous
 * connections alike — neither needs more than a handful of connections for
 * any real flow.
 */
export function ipConnectionThrottle(limiter: FixedWindowLimiter): SocketAuth {
  return (socket, next) => {
    if (!limiter.consume(socketClientIp(socket))) {
      next(new Error('too many connections — try again shortly'));
      return;
    }
    next();
  };
}

/**
 * The Socket.IO servers this process is serving on: the Oxy one
 * (`initSocket`) and the payer one (`initPayerSocket`).
 *
 * A module-level handle rather than a parameter, because the paths that now
 * need to announce a change — a route handler, the expiry sweeper — are not
 * handed one and threading `io` through every caller would put a transport
 * detail in signatures that have no other reason to know about transports.
 *
 * Last `initSocket` / `initPayerSocket` wins, per kind. In production there is
 * exactly one of each; a test that builds two gateways announces into the
 * second, which is why `emitIntentUpdate(io, …)` stays exported for suites
 * that assert on a specific instance.
 */
const active: { oxy: Server | null; payer: Server | null } = { oxy: null, payer: null };

/**
 * Emit an intent update to whichever servers are active, if any.
 *
 * A no-op with no server registered, deliberately: a realtime frame is a
 * convenience on top of a durable state change and a durable outbox row, and
 * failing a rejection because nobody happened to be listening would be the
 * wrong trade in every direction.
 */
export function emitIntentUpdateToActive(intent: PaymentIntentRow): void {
  if (active.oxy !== null) emitIntentUpdate(active.oxy, intent);
  if (active.payer !== null) emitIntentUpdate(active.payer, intent);
}

/** Oxy's handshake verifier, as a `SocketAuth` (socket.io hands it a real `Socket`). */
function oxySocketAuth(): SocketAuth {
  const verify = oxy.middleware.socket();
  return (socket, next) => verify(socket as Parameters<typeof verify>[0], next);
}

/** Both throttles, swept on a shared interval — unref'd so it never keeps the event loop (or a test run) alive. */
function createThrottles(): { connect: FixedWindowLimiter; subscribe: FixedWindowLimiter } {
  const connect = new FixedWindowLimiter(IP_CONNECT_WINDOW_MS, IP_CONNECT_MAX);
  const subscribe = new FixedWindowLimiter(SUBSCRIBE_WINDOW_MS, SUBSCRIBE_MAX_PER_WINDOW);
  const sweepTimer = setInterval(() => {
    connect.sweep();
    subscribe.sweep();
  }, LIMITER_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  return { connect, subscribe };
}

/**
 * The `subscribe` capability check, the same on both servers: joining an
 * intent's room requires that intent's `client_secret`, verified in constant
 * time, and an unknown intent answers exactly like a wrong secret.
 */
function handleSubscribe(socket: Socket, subscribeLimiter: FixedWindowLimiter): void {
  socket.on('subscribe', async (payload: unknown, ack?: (result: { ok: boolean }) => void) => {
    // Keyed by `socket.id` (unique per connection, assigned by
    // socket.io) — independent of the per-IP connection throttle.
    if (!subscribeLimiter.consume(socket.id)) {
      ack?.({ ok: false });
      return;
    }

    const request = parseSubscribe(payload);
    if (request === null) {
      ack?.({ ok: false });
      return;
    }

    const intent = await findIntentByPublicId(getDb(), request.intentId);
    if (intent === null || !verifySecret(request.clientSecret, intent.clientSecret)) {
      ack?.({ ok: false });
      return;
    }

    await socket.join(intentRoom(request.intentId));
    ack?.({ ok: true });
  });
}

/**
 * Wire the OXY realtime layer — the default `/socket.io/` server, behind
 * `createOxySocketCors` (Oxy origins only, `server.ts`). The CONNECTION is
 * identity-optional (see `optionalSocketAuth`): the wallet connects with its
 * Oxy token, and an anonymous payer on an Oxy origin can still connect (SDKs
 * before the payer server, `initPayerSocket`, subscribe here), subject to
 * `ipConnectionThrottle`. Joining a specific intent's room is capability-scoped
 * (`handleSubscribe`), regardless of whether the socket carries an identity.
 * `subscribe` is the only event this layer handles; if a future event needs to
 * be identity/merchant-scoped, it must check `socket.user` itself — the
 * optional connection auth does NOT imply every event is safe for an
 * anonymous socket — and it belongs on THIS server only.
 */
export function initSocket(io: Server, deps: SocketDeps = {}): void {
  active.oxy = io;
  const identityAuth: SocketAuth = deps.socketAuth ?? oxySocketAuth();
  const throttles = createThrottles();

  io.use(ipConnectionThrottle(throttles.connect));
  io.use(optionalSocketAuth(identityAuth));

  io.on('connection', (socket: Socket) => {
    observeEcosystemSocket(socket);
    handleSubscribe(socket, throttles.subscribe);
  });
}

/**
 * The PAYER server's options: its own path (`PAYER_SOCKET_PATH`, from the
 * contracts, which the SDK connects to) and CORS for ANY origin without
 * credentials — `*` is exactly "no credentials", and the only request header
 * it admits is the one long-polling sends. No `allowRequest`: a WebSocket
 * upgrade from any origin is admitted, because nothing on this server is
 * reachable without the intent's own `client_secret`.
 *
 * Socket.IO decides CORS per SERVER, before it knows a connection's namespace
 * or token, which is why this is a second server rather than a namespace of
 * the Oxy one: the Oxy server keeps `createOxySocketCors` whole.
 * `destroyUpgrade: false`, because the Oxy server on the same HTTP server
 * already ends a stray upgrade neither of them handles.
 */
export function payerSocketOptions(): Partial<ServerOptions> {
  return {
    path: PAYER_SOCKET_PATH,
    cors: {
      origin: '*',
      credentials: false,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
    },
    destroyUpgrade: false,
  };
}

/**
 * Refuse a payer-server handshake that carries a credential: an Oxy token in
 * the handshake `auth`, or an `Authorization` header. The payer server has no
 * identity verifier, so a token here would be silently ignored — refusing it
 * keeps "a socket with an identity" on the Oxy server, behind the Oxy
 * origins, the way `payerAwareCors` sends a request with `Authorization` to
 * the Oxy CORS.
 */
export const refusePayerCredentials: SocketAuth = (socket, next) => {
  const handshake = (
    socket as {
      handshake?: {
        auth?: Record<string, unknown>;
        headers?: Record<string, string | string[] | undefined>;
      };
    }
  ).handshake;
  const token = handshake?.auth?.token;
  if (token !== undefined && token !== null && token !== '') {
    next(new Error('the payer socket takes no credentials'));
    return;
  }
  if (handshake?.headers?.authorization !== undefined) {
    next(new Error('the payer socket takes no credentials'));
    return;
  }
  next();
};

/**
 * Wire the PAYER realtime layer (`payerSocketOptions`): anonymous connections
 * from any origin, the same per-IP connection throttle, and `subscribe` by
 * client secret — the ONLY event, and the only thing a payer socket can reach.
 */
export function initPayerSocket(io: Server): void {
  active.payer = io;
  const throttles = createThrottles();

  io.use(ipConnectionThrottle(throttles.connect));
  io.use(refusePayerCredentials);

  io.on('connection', (socket: Socket) => {
    observeEcosystemSocket(socket);
    handleSubscribe(socket, throttles.subscribe);
  });
}

/**
 * Broadcast an intent's current state to every subscriber of its room.
 *
 * Keyed by the PUBLIC `pi_…`, because that is the only id a subscriber has:
 * `subscribe` joins `intentRoom(request.intentId)` with the id the payer was
 * given. Keying this side by the internal id instead would emit into a room
 * nobody is ever in — a silent, total loss of realtime updates that no type
 * error and no unit test of either function alone would show.
 */
export function emitIntentUpdate(io: Server, intent: PaymentIntentRow): void {
  io.to(intentRoom(intent.publicId)).emit('intent.updated', toPayerPaymentIntentDTO(intent));
}
