import { EXPLORER_BASE_URL as DEFAULT_EXPLORER_BASE_URL } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';

/**
 * Typed environment reader for the Peable Gateway backend.
 *
 * Every value is validated and defaulted explicitly — no `process.env.X!`,
 * no magic numbers scattered through the code. `loadConfig` is pure over its
 * `env` argument so it can be exercised in isolation; `config` is the process
 * singleton built from `process.env` at import time.
 */

const DEFAULT_PORT = 3001;
const DEFAULT_NETWORK: NetworkType = 'mainnet';
// The hosted checkout page's host (F2.2/F2.3) — see `2026-07-19-fase2-checkout-links.md`.
const DEFAULT_CHECKOUT_BASE_URL = 'https://checkout.peable.to';
// Where a SELLER registers their FairCoin key (ADR 0012 D3): the Peable wallet,
// which already holds the key and the seller's Oxy session.
const DEFAULT_CONNECT_ONBOARDING_BASE_URL = 'https://peable.to/connect';
// This gateway's own public origin — the host a merchant's credential calls.
const DEFAULT_API_BASE_URL = 'https://api.peable.to';
// Oxy's API: the one `oxy` client (`src/oxy.ts`) is built from `config.oxyApiUrl`.
const DEFAULT_OXY_API_URL = 'https://api.oxy.so';

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
   * Base URL of the seller-facing FairCoin onboarding page (no trailing slash)
   * — a link is `<base>/<token>` (ADR 0012 D3). The Peable wallet serves it.
   */
  connectOnboardingBaseUrl: string;
  /**
   * This gateway's public base URL (no trailing slash) — where an object's own
   * URLs point, such as a report file's `GET /v1/files/:id/contents`.
   */
  apiBaseUrl: string;
  /**
   * Base URL of oxy-api (no trailing slash), from which the one `oxy` client
   * (`src/oxy.ts`) is constructed — every Oxy call the gateway makes, including
   * what a signed-in person may do (`services/oxyAccess.ts`), goes through it.
   */
  oxyApiUrl: string;
  /**
   * The Stripe card rail (ADR 0001 D2/D3), test and live side by side
   * (ADR 0017).
   *
   * Each mode's `cardRail` is a CONJUNCTION, not a flag: it is true only when
   * the operator asked for the rail AND that mode holds every secret it cannot
   * work without. A half-configured mode stays OFF and says so once at boot,
   * rather than accepting a checkout and failing mid-request on the first
   * missing secret — which is why `resolveProvider` can answer "this rail is
   * off" instead of throwing.
   */
  stripe: StripeConfig;
  /** Salt for the one-way hash Peable Tax keeps of an IP address given as
   * location evidence. Absent: no trace of the address is kept at all. */
  ipHashSalt?: string;
  /** Oxy Files: file events and reference reconciliation (ADR 0043). */
  oxyFiles: OxyFilesConfig;
  /** Orbit's money model (ADR 0015): the third-party live gate and the default fee. */
  orbit: OrbitMoneyConfig;
}

/**
 * Orbit's funds flow (ADR 0015).
 *
 * `thirdPartyLivePayments` is the ADR's RELEASE GATE in code: until the legal
 * review, the merchant agreement and the negative-balance exposure are signed
 * off, a merchant that is NOT an Oxy first-party product cannot open a live
 * fiat account, take a live destination charge or instruct a live payout.
 * Test mode is always allowed. `ORBIT_THIRD_PARTY_LIVE_PAYMENTS=true` and
 * nothing else opens it.
 *
 * The default fee applies to a merchant with no `fee_schedules` row for the
 * payment's method and currency. It defaults to ZERO because Orbit's fee terms
 * are part of the same gate: no fee is charged that no agreement names.
 */
export interface OrbitMoneyConfig {
  thirdPartyLivePayments: boolean;
  /** 0–10000 basis points (`ORBIT_FEE_PERCENT_BPS`). */
  defaultFeePercentBps: number;
  /** Per-currency fixed fee in base units (`ORBIT_FEE_FIXED=EUR:25,USD:30`). */
  defaultFeeFixed: Readonly<Record<string, string>>;
}

function readFeePercent(raw: string | undefined): number {
  const value = readOptional(raw);
  if (value === undefined) return 0;
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`ORBIT_FEE_PERCENT_BPS must be an integer 0–10000, received "${value}"`);
  }
  return bps;
}

function readFeeFixed(raw: string | undefined): Record<string, string> {
  const value = readOptional(raw);
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const [currency, amount] = pair.split(':').map((part) => part.trim());
    if (
      !currency ||
      !/^[A-Z]{3,4}$/.test(currency) ||
      !amount ||
      !/^(0|[1-9][0-9]*)$/.test(amount)
    ) {
      throw new Error(
        `ORBIT_FEE_FIXED must be CUR:amount pairs (EUR:25,USD:30), received "${value}"`,
      );
    }
    out[currency] = amount;
  }
  return out;
}

/**
 * How the nightly Oxy file-reference reconciliation runs.
 *
 *  - `apply`   — the default and the steady state: Oxy adds the references
 *                Peable uses and removes the stale ones.
 *  - `dry-run` — Oxy reports what it WOULD change and changes nothing; the
 *                counts land in `oxy_file_reconciliation_runs`. For a first
 *                look at a database whose avatars predate references.
 *  - `off`     — not run.
 */
export type OxyFileReconciliationMode = 'apply' | 'dry-run' | 'off';

export interface OxyFilesConfig {
  /**
   * The signing secret of Peable's file-events endpoint, shown ONCE by Oxy
   * when the endpoint is set (`oxy.apps.setFilesWebhook` / console → Webhooks
   * → File events). Absent: the endpoint still answers Oxy's verification
   * challenge — that is how it gets set — and refuses every event with a 503,
   * which Oxy retries.
   */
  webhookSecret: string | undefined;
  /** The rotation window: the outgoing secret, accepted beside the new one until removed. */
  webhookSecretPrevious: string | undefined;
  reconciliationMode: OxyFileReconciliationMode;
}

function readReconciliationMode(raw: string | undefined): OxyFileReconciliationMode {
  const value = raw?.trim();
  if (!value) return 'apply';
  if (value === 'apply' || value === 'dry-run' || value === 'off') return value;
  throw new Error(
    `OXY_FILE_RECONCILIATION_MODE must be "apply", "dry-run" or "off", received "${raw}"`,
  );
}

/** Which of the provider's two worlds a key, a row or an event belongs to. */
export type StripeMode = 'test' | 'live';

/**
 * One mode's half of the Stripe configuration (ADR 0017).
 *
 * A deployment holds BOTH modes at once: a `production` merchant's money moves
 * through the live key and every other environment's through the test key, and
 * nothing a caller sends chooses between them — the credential's environment
 * does (`services/providers/environmentGuard.ts`). A mode whose secret key is
 * absent does not exist here at all, and its card rail answers 503 like any
 * rail this deployment has not configured.
 */
export interface StripeModeConfig {
  accountId?: string | undefined;
  mode: StripeMode;
  /** `mode === 'live'`, spelled the way Stripe's own objects spell it. */
  livemode: boolean;
  /**
   * `sk_<mode>_…` or `rk_<mode>_…`. Its prefix is checked against the variable
   * it came from at load, and a contradiction refuses to boot: a live key in
   * `STRIPE_SECRET_KEY_TEST` would charge real cards for every development
   * credential, and no later check could tell that apart from a test charge.
   */
  secretKey: string;
  /**
   * The PUBLISHABLE key — public by construction, and the one Stripe value
   * that is meant to reach a browser.
   *
   * The hosted checkout needs it to mount the provider's own card fields, and
   * it must not be a build-time constant in that bundle: the checkout is
   * deployed once and serves payments of both modes, so it is served per
   * payment from `POST /v1/payment_intents/:id/client_action`, in the mode of
   * the payment it confirms. `pk_<mode>_…`, checked at load like the secret.
   *
   * Not required for the card rail: a server-side integrator (Mercaria mounts
   * its own fields) needs no publishable key.
   */
  publishableKey: string | undefined;
  /** Platform-scope endpoint secret of this mode's endpoint. */
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
   * Whether this mode's CARD RAIL is on — a conjunction, not a flag: the
   * operator asked for the rail (`STRIPE_ENABLED`) AND this mode holds both
   * endpoint secrets. A rail that took payments it could never hear about would
   * move money the gateway never learns moved, so a partial mode stays off and
   * says so once at boot. Tax and recurring billing need only the key and do
   * not read this.
   */
  cardRail: boolean;
}

/**
 * The Stripe card rail (ADR 0001 D2/D3) and the platform account's key for
 * tax and billing, per mode (ADR 0017).
 *
 * A reviewed expected account independently pins each configured mode before
 * its card rail starts. Connected-account ids remain scoped to their own rows.
 */
export interface StripeConfig {
  test: StripeModeConfig | undefined;
  live: StripeModeConfig | undefined;
}

/** How a Stripe secret key names its own mode. */
export type StripeKeyMode = StripeMode | 'unknown';

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
  if (secretKey === undefined) return 'unknown';
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

/** The raw variables of one mode, each read by its full NAME in `readStripeConfig`. */
interface StripeModeVariables {
  accountId?: string | undefined;
  secretKey: string | undefined;
  publishableKey: string | undefined;
  webhookSecret: string | undefined;
  webhookSecretPrevious: string | undefined;
  connectWebhookSecret: string | undefined;
  connectWebhookSecretPrevious: string | undefined;
}

/**
 * Build one mode, refusing to boot on a key that names the other one.
 *
 * A contradiction is a THROW, not a warning that turns the mode off: the
 * operator put a key where it does not belong, and the mode the deployment
 * would then quietly lack is the one somebody is about to rely on. The key
 * itself never appears in the message.
 */
function readStripeMode(
  mode: StripeMode,
  railAsked: boolean,
  raw: StripeModeVariables,
): StripeModeConfig | undefined {
  const suffix = mode.toUpperCase();
  if (raw.secretKey === undefined) {
    const stray = Object.entries(raw)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    if (stray.length > 0) {
      process.emitWarning(
        `[Stripe] the ${mode} mode has settings but no STRIPE_SECRET_KEY_${suffix}; ` +
          `it stays OFF. Set: ${stray.join(', ')}`,
      );
    }
    return undefined;
  }
  const keyMode = classifyStripeKey(raw.secretKey);
  if (keyMode !== mode) {
    throw new Error(
      `STRIPE_SECRET_KEY_${suffix} must be a ${mode} key (sk_${mode}_… or rk_${mode}_…); ` +
        (keyMode === 'unknown'
          ? 'its prefix is not a recognised Stripe secret key'
          : `it is a ${keyMode} key`),
    );
  }
  if (raw.publishableKey !== undefined && !raw.publishableKey.startsWith(`pk_${mode}_`)) {
    throw new Error(`STRIPE_PUBLISHABLE_KEY_${suffix} must be a pk_${mode}_… key`);
  }
  const missing: string[] = [];
  if (raw.webhookSecret === undefined) missing.push(`STRIPE_WEBHOOK_SECRET_${suffix}`);
  if (raw.connectWebhookSecret === undefined) {
    missing.push(`STRIPE_CONNECT_WEBHOOK_SECRET_${suffix}`);
  }
  if (railAsked && missing.length > 0) {
    // Once, at boot, naming what is missing. Not per request, and not silent.
    process.emitWarning(
      `[Stripe] STRIPE_ENABLED is set but the ${mode} card rail is incomplete; ` +
        `it stays OFF. Missing: ${missing.join(', ')}`,
    );
  }
  return {
    mode,
    accountId: raw.accountId,
    livemode: mode === 'live',
    secretKey: raw.secretKey,
    publishableKey: raw.publishableKey,
    webhookSecret: raw.webhookSecret,
    webhookSecretPrevious: raw.webhookSecretPrevious,
    connectWebhookSecret: raw.connectWebhookSecret,
    connectWebhookSecretPrevious: raw.connectWebhookSecretPrevious,
    cardRail: railAsked && missing.length === 0,
  };
}

/**
 * Both modes, each optional (ADR 0017).
 *
 * Every variable is read by its full name rather than built from the mode, so
 * `db/__tests__/deploySecrets.test.ts` — which finds them by `env.NAME` — can
 * hold the deploy's secret sync to each one.
 */
function readStripeConfig(env: Record<string, string | undefined>): StripeConfig {
  const railAsked = readOptional(env.STRIPE_ENABLED) === 'true';
  const stripe: StripeConfig = {
    test: readStripeMode('test', railAsked, {
      accountId: readOptional(env.STRIPE_ACCOUNT_ID_TEST) ?? readOptional(env.STRIPE_ACCOUNT_ID),
      secretKey: readOptional(env.STRIPE_SECRET_KEY_TEST),
      publishableKey: readOptional(env.STRIPE_PUBLISHABLE_KEY_TEST),
      webhookSecret: readOptional(env.STRIPE_WEBHOOK_SECRET_TEST),
      webhookSecretPrevious: readOptional(env.STRIPE_WEBHOOK_SECRET_PREVIOUS_TEST),
      connectWebhookSecret: readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET_TEST),
      connectWebhookSecretPrevious: readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS_TEST),
    }),
    live: readStripeMode('live', railAsked, {
      accountId: readOptional(env.STRIPE_ACCOUNT_ID_LIVE) ?? readOptional(env.STRIPE_ACCOUNT_ID),
      secretKey: readOptional(env.STRIPE_SECRET_KEY_LIVE),
      publishableKey: readOptional(env.STRIPE_PUBLISHABLE_KEY_LIVE),
      webhookSecret: readOptional(env.STRIPE_WEBHOOK_SECRET_LIVE),
      webhookSecretPrevious: readOptional(env.STRIPE_WEBHOOK_SECRET_PREVIOUS_LIVE),
      connectWebhookSecret: readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET_LIVE),
      connectWebhookSecretPrevious: readOptional(env.STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS_LIVE),
    }),
  };
  if (railAsked && !stripe.test && !stripe.live) {
    process.emitWarning(
      '[Stripe] STRIPE_ENABLED is set but neither STRIPE_SECRET_KEY_TEST nor ' +
        'STRIPE_SECRET_KEY_LIVE is; the card rail stays OFF.',
    );
  }
  return stripe;
}

function readOrigins(raw: string | undefined): string[] {
  // Peable's own clients must work without an optional deployment override.
  return [
    ...new Set([
      'https://peable.to',
      'https://checkout.peable.to',
      // Orbit by Peable, the merchant dashboard (`packages/orbit`).
      'https://orbit.peable.to',
      // The Oxy apps that open Pay with Peable — the payment sheet,
      // `@peable.to/sdk/checkout/ui` `PeableSheetCheckout` — in a browser. Its
      // payer routes are anonymous (the order's own client secret), so these
      // origins gain nothing but the ability to read the order they were handed.
      'https://mention.earth',
      'https://mercaria.co',
      'https://dashboard.mercaria.co',
      ...(raw ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
  ];
}

function readNetwork(raw: string | undefined): NetworkType {
  if (raw === undefined || raw.trim() === '') return DEFAULT_NETWORK;
  const value = raw.trim();
  if (value === 'mainnet' || value === 'testnet') return value;
  throw new Error(`PEABLE_NETWORK must be "mainnet" or "testnet", received "${raw}"`);
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PORT must be a positive integer, received "${raw}"`);
  }
  return value;
}

function readNonEmpty(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === '' ? fallback : value;
}

function readOptional(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
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
function readRequired(raw: string | undefined, name: string): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      `${name} is required and was not set. The backend is Postgres-native: ` +
        'every route reads it and the pool is opened at boot. For local ' +
        'development start the server with ' +
        '`docker compose -f docker-compose.postgres.yml up -d`.',
    );
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    explorerBaseUrl: readNonEmpty(env.EXPLORER_BASE_URL, DEFAULT_EXPLORER_BASE_URL),
    network: readNetwork(env.PEABLE_NETWORK),
    socialPayNetwork: readNetwork(env.PEABLE_SOCIAL_PAY_NETWORK ?? 'testnet'),
    databaseUrl: readRequired(env.DATABASE_URL, 'DATABASE_URL'),
    port: readPort(env.PORT),
    allowedOrigins: readOrigins(env.PEABLE_ALLOWED_ORIGINS),
    checkoutBaseUrl: readNonEmpty(env.PEABLE_CHECKOUT_BASE_URL, DEFAULT_CHECKOUT_BASE_URL),
    connectOnboardingBaseUrl: readNonEmpty(
      env.PEABLE_CONNECT_ONBOARDING_BASE_URL,
      DEFAULT_CONNECT_ONBOARDING_BASE_URL,
    ).replace(/\/+$/, ''),
    apiBaseUrl: readNonEmpty(env.PEABLE_API_BASE_URL, DEFAULT_API_BASE_URL).replace(/\/+$/, ''),
    oxyApiUrl: readNonEmpty(env.OXY_API_URL, DEFAULT_OXY_API_URL),
    ipHashSalt: readOptional(env.IP_HASH_SALT),
    stripe: readStripeConfig(env),
    oxyFiles: {
      webhookSecret: readOptional(env.OXY_FILES_WEBHOOK_SECRET),
      webhookSecretPrevious: readOptional(env.OXY_FILES_WEBHOOK_SECRET_PREVIOUS),
      reconciliationMode: readReconciliationMode(env.OXY_FILE_RECONCILIATION_MODE),
    },
    orbit: {
      thirdPartyLivePayments: readOptional(env.ORBIT_THIRD_PARTY_LIVE_PAYMENTS) === 'true',
      defaultFeePercentBps: readFeePercent(env.ORBIT_FEE_PERCENT_BPS),
      defaultFeeFixed: readFeeFixed(env.ORBIT_FEE_FIXED),
    },
  };
}

export const config = loadConfig();
