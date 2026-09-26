import { EXPLORER_BASE_URL as DEFAULT_EXPLORER_BASE_URL } from "@fairco.in/core";
import type { NetworkType } from "@fairco.in/core";

/**
 * Typed environment reader for the Peable Gateway backend.
 *
 * Every value is validated and defaulted explicitly — no `process.env.X!`,
 * no magic numbers scattered through the code. `loadConfig` is pure over its
 * `env` argument so it can be exercised in isolation; `config` is the process
 * singleton built from `process.env` at import time.
 */

const DEFAULT_PORT = 3001;
const DEFAULT_NETWORK: NetworkType = "mainnet";
// The hosted checkout page's host (F2.2/F2.3) — see `2026-07-19-fase2-checkout-links.md`.
const DEFAULT_CHECKOUT_BASE_URL = "https://checkout.peable.to";
// Oxy's API. The `oxy` client (`src/oxy.ts`) is built from `config.oxyApiUrl`,
// so it and the direct fetches in `services/appMembership.ts` never drift.
const DEFAULT_OXY_API_URL = "https://api.oxy.so";

export interface AppConfig {
  /** Base URL of the FairCoin block explorer (no trailing slash). */
  explorerBaseUrl: string;
  /** Network the gateway operates on (`mainnet` | `testnet`). */
  network: NetworkType;
  /**
   * The ONE network on which this deployment mints social-receive addresses
   * (pay by `@username`).
   *
   * Separate from `network`, and defaulting to `testnet`, because it is a
   * different question: the gateway can settle merchant payments on mainnet
   * while person-to-person addresses — derived from a recipient's identity key
   * rather than from a registered xpub — stay off it until that derivation has
   * cleared its release gates. Until this file said so, the restriction lived
   * only in the wallet, so any other client could reserve a mainnet address.
   */
  socialPayNetwork: NetworkType;
  /**
   * PostgreSQL connection string. REQUIRED — there is no default and no
   * `undefined` case.
   *
   * Every route reads Postgres and `server.ts` opens the pool at boot, so a
   * deployment without this variable cannot serve a single request. Refusing
   * it here means a task definition missing `DATABASE_URL` crash-loops with a
   * message naming the variable, instead of starting and answering every
   * request with a 500. It is also why `deploy-aws.yml` no longer probes the
   * task definition before running migrations: the state that probe skipped
   * over — a live service with no database — is no longer reachable.
   */
  databaseUrl: string;
  /** HTTP port the API listens on. */
  port: number;
  /**
   * Exact browser origins allowed to open a realtime Socket.io connection AND
   * (F2.5) to call the REST API cross-origin — both `createGateway`'s Socket.io
   * `cors.origin` check and `createOxyCors({ appOrigins })` in `server.ts` read
   * this same list (comma-separated `PEABLE_ALLOWED_ORIGINS`). It exists
   * because `createOxyCors`'s built-in Oxy-family allowlist only trusts
   * ONE-LABEL `*.oxy.so` subdomains — a two-label host like
   * `dashboard.peable.to` must be listed here explicitly. Requests with no
   * `Origin` (native apps / server-to-server) are always allowed; an arbitrary
   * browser origin is NEVER reflected — it must be listed here. REST routes
   * remain gated by their own auth (service token / Oxy user bearer /
   * `client_secret`) regardless of CORS.
   */
  allowedOrigins: string[];
  /**
   * Base URL of the hosted checkout page (no trailing slash) — used to build
   * `PaymentLink.url` (`/l/<id>`) and `CheckoutSession.url` (`/c/<id>`).
   */
  checkoutBaseUrl: string;
  /**
   * Base URL of oxy-api (no trailing slash) — `services/appMembership.ts`
   * forwards the dashboard caller's Oxy bearer here (`GET
   * /applications/:applicationId`) to delegate `/v1/dashboard/*` authorization
   * to oxy-api's own Application RBAC (zero RBAC duplication). The `oxy`
   * client (`src/oxy.ts`) is constructed from this same value.
   */
  oxyApiUrl: string;
  /**
   * The Stripe card rail (ADR 0001 D2/D3).
   *
   * `enabled` is a CONJUNCTION, not a flag: it is true only when the operator
   * asked for the rail AND every secret it cannot work without is present. A
   * half-configured integration stays OFF and says so once at boot, rather than
   * accepting a checkout and failing mid-request on the first missing secret —
   * the same shape Mercaria's `resolveStripeEnabled` uses, and it is why
   * `resolveProvider` can answer "this rail is off" instead of throwing.
   *
   * There is deliberately no account-id variable: the platform account is
   * implied by the secret key, and connected-account ids live only in rows.
   */
  stripe: StripeConfig;
}

export interface StripeConfig {
  /** True only when `STRIPE_ENABLED` is set AND every required secret is present. */
  enabled: boolean;
  secretKey: string | undefined;
  /**
   * The PUBLISHABLE key — public by construction, and the one Stripe value
   * that is meant to reach a browser.
   *
   * The hosted checkout needs it to mount the provider's own card fields, and
   * it must not be a build-time constant in that bundle: the checkout is
   * deployed once and serves whichever gateway it is pointed at, so a key baked
   * into it would be the wrong mode the first time a test deployment used the
   * same page. It is served from `POST /v1/payment_intents/:id/client_action`
   * beside the confirmation credential, which is the one response that already
   * proves the caller may pay this payment.
   *
   * NOT part of `resolveStripeEnabled`'s required set: a deployment that only
   * serves server-side integrators (Mercaria mounts its own fields) needs no
   * publishable key, and refusing to enable the rail without one would turn a
   * working configuration off.
   */
  publishableKey: string | undefined;
  /** Platform-scope endpoint secret. */
  webhookSecret: string | undefined;
  /** Connect-scope endpoint secret — a DIFFERENT endpoint with its own secret. */
  connectWebhookSecret: string | undefined;
  /**
   * The rotation window. Stripe cannot atomically swap an endpoint secret, so a
   * rotation is: add the new one here as the previous, switch, remove. Without
   * these, every in-flight delivery signed with the old secret is rejected as a
   * forgery during the swap.
   */
  webhookSecretPrevious: string | undefined;
  connectWebhookSecretPrevious: string | undefined;
  /**
   * Whether this deployment's key is a LIVE key, derived from the key itself
   * rather than configured separately.
   *
   * Read by the webhook ingress to drop events of the other mode: a production
   * URL receives test events too, and processing one would settle a payment
   * that does not exist. Read again, before any provider call, by
   * `services/providers/environmentGuard.ts` — the mode a deployment holds and
   * the environment a merchant's credential carries have to agree, and only the
   * guard checks that.
   */
  livemode: boolean;
  /**
   * The key's mode, classified — and `unknown` is a real answer.
   *
   * `livemode` used to be `secretKey.startsWith('sk_live_')` and nothing else,
   * which gets a RESTRICTED live key (`rk_live_…`) wrong in the most expensive
   * direction: the deployment holds a live key, `livemode` reads `false`, every
   * live webhook is dropped as a mode mismatch and a development credential is
   * cleared to create live charges. A restricted key is the recommended shape
   * for exactly the Accounts v2 + transfers surface this gateway uses, so it is
   * not a hypothetical.
   *
   * Anything that is not one of the four known prefixes is `unknown`, and an
   * unknown key does not enable the rail. Guessing a mode from a key nobody
   * recognises is how a test deployment decides it is live.
   */
  keyMode: StripeKeyMode;
}

/** How a Stripe secret key names its own mode. */
export type StripeKeyMode = "live" | "test" | "unknown";

/**
 * Classify a Stripe secret key.
 *
 * FOUR prefixes, not one. `sk_` is a standard key and `rk_` a restricted one;
 * both exist in both modes, and Stripe's restricted keys are what a platform
 * with a narrow permission set actually deploys. The mode is the second
 * segment in every case, which is why this matches on the pair rather than on
 * `includes('live')` — `sk_test_live_something` is a legal random suffix.
 */
export function classifyStripeKey(secretKey: string | undefined): StripeKeyMode {
  if (secretKey === undefined) return "unknown";
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  return "unknown";
}

function readOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

function readNetwork(raw: string | undefined): NetworkType {
  if (raw === undefined || raw.trim() === "") return DEFAULT_NETWORK;
  const value = raw.trim();
  if (value === "mainnet" || value === "testnet") return value;
  throw new Error(
    `PEABLE_NETWORK must be "mainnet" or "testnet", received "${raw}"`,
  );
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PORT must be a positive integer, received "${raw}"`);
  }
  return value;
}

function readNonEmpty(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === "" ? fallback : value;
}

function readOptional(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/**
 * Read a variable the service cannot run without.
 *
 * Throws at load time rather than returning `undefined` for a caller to check:
 * the whole point of a required variable is that no downstream code should
 * have to handle its absence. An empty or whitespace-only value is treated as
 * absent, because `DATABASE_URL=""` in a task definition is a misconfiguration
 * that would otherwise reach postgres.js as a connection string.
 */
/**
 * Whether the Stripe rail is on.
 *
 * `STRIPE_ENABLED` alone is not enough. A deployment that set the flag and
 * forgot a webhook secret would accept payments it can never confirm — the
 * money would move and the gateway would never learn it did. Refusing to turn
 * the rail on, loudly and once, is the only safe reading of a partial
 * configuration.
 */
function resolveStripeEnabled(env: Record<string, string | undefined>): boolean {
  const asked = readOptional(env.STRIPE_ENABLED) === "true";
  if (!asked) return false;
  const required = [
    ["STRIPE_SECRET_KEY", readOptional(env.STRIPE_SECRET_KEY)],
    ["STRIPE_WEBHOOK_SECRET", readOptional(env.STRIPE_WEBHOOK_SECRET)],
    ["STRIPE_CONNECT_WEBHOOK_SECRET", readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET)],
  ] as const;
  const missing = required.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    // Once, at boot, naming what is missing. Not per request, and not silent.
    process.emitWarning(
      `[Stripe] STRIPE_ENABLED is set but the integration is incomplete; staying OFF. Missing: ${missing.join(", ")}`,
    );
    return false;
  }
  // A key whose mode cannot be read is a key whose mode cannot be ENFORCED.
  // Everything downstream — the ingress livemode filter, the environment guard
  // before every provider call — is derived from the classification, so a rail
  // turned on with an unclassifiable key would run with both of them answering
  // from a guess.
  if (classifyStripeKey(readOptional(env.STRIPE_SECRET_KEY)) === "unknown") {
    process.emitWarning(
      "[Stripe] STRIPE_SECRET_KEY is not a recognised sk_live_/rk_live_/sk_test_/rk_test_ " +
        "key, so its mode cannot be classified; staying OFF rather than guessing.",
    );
    return false;
  }
  return true;
}

function readRequired(raw: string | undefined, name: string): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      `${name} is required and was not set. The backend is Postgres-native: ` +
        "every route reads it and the pool is opened at boot. For local " +
        "development start the server with " +
        "`docker compose -f docker-compose.postgres.yml up -d`.",
    );
  }
  return value;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return {
    explorerBaseUrl: readNonEmpty(
      env.EXPLORER_BASE_URL,
      DEFAULT_EXPLORER_BASE_URL,
    ),
    network: readNetwork(env.PEABLE_NETWORK),
    socialPayNetwork: readNetwork(env.PEABLE_SOCIAL_PAY_NETWORK ?? "testnet"),
    databaseUrl: readRequired(env.DATABASE_URL, "DATABASE_URL"),
    port: readPort(env.PORT),
    allowedOrigins: readOrigins(env.PEABLE_ALLOWED_ORIGINS),
    checkoutBaseUrl: readNonEmpty(env.PEABLE_CHECKOUT_BASE_URL, DEFAULT_CHECKOUT_BASE_URL),
    oxyApiUrl: readNonEmpty(env.OXY_API_URL, DEFAULT_OXY_API_URL),
    stripe: {
      enabled: resolveStripeEnabled(env),
      secretKey: readOptional(env.STRIPE_SECRET_KEY),
      publishableKey: readOptional(env.STRIPE_PUBLISHABLE_KEY),
      webhookSecret: readOptional(env.STRIPE_WEBHOOK_SECRET),
      connectWebhookSecret: readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET),
      webhookSecretPrevious: readOptional(env.STRIPE_WEBHOOK_SECRET_PREVIOUS),
      connectWebhookSecretPrevious: readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS),
      // Derived, never configured: a deployment cannot claim live mode with a
      // test key or the reverse, so the two cannot disagree. `classifyStripeKey`
      // rather than a `sk_live_` prefix test — a restricted live key
      // (`rk_live_…`) is a live key, and reading it as test drops every live
      // webhook while clearing a development credential to charge live cards.
      livemode: classifyStripeKey(readOptional(env.STRIPE_SECRET_KEY)) === "live",
      keyMode: classifyStripeKey(readOptional(env.STRIPE_SECRET_KEY)),
    },
  };
}

export const config = loadConfig();
