import { observeEcosystemSocket } from '../ecosystemActivity';
import { isIP } from "node:net";
import type { Server, Socket } from "socket.io";
import { oxyClient } from "@oxy.so/core";
import { verifySecret } from "@oxy.so/core/server";
import { getDb } from "../db/postgres";
import { findIntentByPublicId } from "../db/payments/paymentIntentRepository";
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import { toPaymentIntentDTO } from "../lib/serialize";

/** Realtime room a single intent's updates are broadcast to. */
export function intentRoom(id: string): string {
  return `intent:${id}`;
}

/** Socket.io connection-authentication middleware `(socket, next) => …`. */
export type SocketAuth = (
  socket: unknown,
  next: (err?: Error) => void,
) => void | Promise<void>;

export interface SocketDeps {
  /**
   * Override the MANDATORY identity verifier invoked for a connection that
   * DOES present a handshake token (tests inject a stub; prod uses
   * `oxyClient.authSocket()`). Always wrapped in `optionalSocketAuth` below —
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
    const handshake = (socket as { handshake?: { auth?: { token?: unknown } } })
      .handshake;
    const token = handshake?.auth?.token;
    if (typeof token !== "string" || token.length === 0) {
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

function parseSubscribe(payload: unknown): SubscribeRequest | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { intentId, clientSecret } = payload as Record<string, unknown>;
  if (typeof intentId !== "string" || typeof clientSecret !== "string") {
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

const FORWARDED_FOR_HEADER = "x-forwarded-for";

function looksLikeIp(candidate: string): boolean {
  return isIP(candidate) !== 0;
}

/**
 * Resolve the real client IP from a socket handshake. Engine.io has no
 * trust-proxy concept of its own: `socket.handshake.address` is always the
 * raw TCP peer (`req.connection.remoteAddress`), which behind the ALB is the
 * ALB's address, never the payer's browser — unlike Express, where `req.ip`
 * resolves through `X-Forwarded-For` once `trust proxy` is set (`server.ts`).
 *
 * The ALB is the ONE trusted hop (`trust proxy: 1` there): it never strips
 * or replaces an incoming `X-Forwarded-For` — it APPENDS the address it
 * observed for its own direct peer to the RIGHT of whatever the connecting
 * client already sent. A caller can freely prepend any forged value to the
 * LEFT (`X-Forwarded-For: <anything>` costs nothing to send), so that prefix
 * must NEVER be trusted. The RIGHTMOST entry is the one value in the header
 * no untrusted party ever wrote — it is exactly what `req.ip` resolves to on
 * the Express side for the same request path: `proxy-addr` (the module
 * behind `req.ip`) with `trust proxy: 1` trusts exactly the socket hop and
 * returns `addrs[1]` in its `[socket, rightmost-XFF, …, leftmost-XFF]`
 * ordering — the rightmost XFF entry, never the leftmost. Also validates the
 * extracted value actually looks like an IP address (`node:net`'s `isIP`),
 * so a malformed/garbage header can't mint unbounded distinct throttle keys.
 * Falls back to the raw transport address when there's no usable header at
 * all (local dev, direct connections, no proxy in front).
 */
export function resolveClientIp(socket: unknown): string {
  const handshake = (
    socket as {
      handshake?: {
        headers?: Record<string, string | string[] | undefined>;
        address?: string;
      };
    }
  ).handshake;
  const forwardedFor = handshake?.headers?.[FORWARDED_FOR_HEADER];
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const parts = header?.split(",") ?? [];
  const rightmost = parts[parts.length - 1]?.trim();
  if (rightmost !== undefined && looksLikeIp(rightmost)) {
    return rightmost;
  }
  return handshake?.address ?? "unknown";
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
    if (!limiter.consume(resolveClientIp(socket))) {
      next(new Error("too many connections — try again shortly"));
      return;
    }
    next();
  };
}

/**
 * Wire the realtime layer. The CONNECTION is identity-optional (see
 * `optionalSocketAuth`) — a checkout/embed payer with no Oxy session can
 * still connect, subject to `ipConnectionThrottle` above. Joining a specific
 * intent's room is capability-scoped: it requires proving possession of that
 * intent's `client_secret`, verified in constant time, regardless of whether
 * the socket carries an identity — so ANY holder of a valid client_secret can
 * subscribe to that intent (and only that intent), never enumerate someone
 * else's, subject to the per-socket `SUBSCRIBE_MAX_PER_WINDOW` throttle. The
 * payer's wallet then receives live `intent.updated` events as the
 * settlement watcher advances the intent. `subscribe` is the only event this
 * layer handles; if a future event needs to be identity/merchant-scoped, it
 * must check `socket.user` itself — the optional connection auth does NOT
 * imply every event is safe for an anonymous socket.
 */
/**
 * The Socket.IO server this process is serving on, if any.
 *
 * A module-level handle rather than a parameter, because the paths that now
 * need to announce a change — a route handler, the expiry sweeper — are not
 * handed one and threading `io` through every caller would put a transport
 * detail in signatures that have no other reason to know about transports.
 *
 * Last `initSocket` wins. In production there is exactly one server; a test
 * that builds two gateways announces into the second, which is why
 * `emitIntentUpdate(io, …)` stays exported for suites that assert on a
 * specific instance.
 */
let activeIo: Server | null = null;

/**
 * Emit an intent update to whichever server is active, if one is.
 *
 * A no-op with no server registered, deliberately: a realtime frame is a
 * convenience on top of a durable state change and a durable outbox row, and
 * failing a rejection because nobody happened to be listening would be the
 * wrong trade in every direction.
 */
export function emitIntentUpdateToActive(intent: PaymentIntentRow): void {
  if (activeIo === null) return;
  emitIntentUpdate(activeIo, intent);
}

export function initSocket(io: Server, deps: SocketDeps = {}): void {
  activeIo = io;
  const identityAuth = deps.socketAuth ?? oxyClient.authSocket();
  const ipConnectLimiter = new FixedWindowLimiter(IP_CONNECT_WINDOW_MS, IP_CONNECT_MAX);
  const subscribeLimiter = new FixedWindowLimiter(
    SUBSCRIBE_WINDOW_MS,
    SUBSCRIBE_MAX_PER_WINDOW,
  );

  // Swept on a shared interval — unref'd so it never keeps the event loop
  // (or a test run) alive, matching `SettlementWatcher`'s convention.
  const sweepTimer = setInterval(() => {
    ipConnectLimiter.sweep();
    subscribeLimiter.sweep();
  }, LIMITER_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  io.use(ipConnectionThrottle(ipConnectLimiter));
  io.use(optionalSocketAuth(identityAuth));

  io.on("connection", (socket: Socket) => {
    observeEcosystemSocket(socket);
    socket.on(
      "subscribe",
      async (payload: unknown, ack?: (result: { ok: boolean }) => void) => {
        // Keyed by `socket.id` (unique per connection, assigned by
        // socket.io) — independent of the per-IP connection throttle above.
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
        if (
          intent === null ||
          !verifySecret(request.clientSecret, intent.clientSecret)
        ) {
          ack?.({ ok: false });
          return;
        }

        await socket.join(intentRoom(request.intentId));
        ack?.({ ok: true });
      },
    );
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
export function emitIntentUpdate(
  io: Server,
  intent: PaymentIntentRow,
): void {
  io.to(intentRoom(intent.publicId)).emit("intent.updated", toPaymentIntentDTO(intent));
}
