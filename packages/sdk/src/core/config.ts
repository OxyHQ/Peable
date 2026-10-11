// Configuration for the server-side `Peable` client. The SDK authenticates with
// an Oxy service token, obtained one of two ways:
//
// - a confidential `ApplicationCredential` (`{publicKey, secret}`, the SAME
//   credential Oxy Console already issues for a `type:'service'` credential) —
//   never a bespoke "Peable API key" — from which the SDK mints the token
//   itself. See the SDK plan's "Architecture / auth" section; or
// - a caller-supplied `tokenProvider`, for a workload that already holds an Oxy
//   identity (e.g. an ECS task role attested through workload identity) and
//   has no key pair to hand over. The Gateway resolves the merchant from the
//   token's application id and environment, not from how it was minted.

import type { ServiceTokenProvider } from './serviceToken';

/** Default Gateway host (`api.peable.to`) — the SDK never sends a `livemode`
 * flag; the credential's `environment` rides in the minted service JWT and
 * the Gateway resolves test/live from it. */
export const DEFAULT_GATEWAY_BASE_URL = 'https://api.peable.to';

/** Default oxy-api host used to mint the short-lived service token. */
export const DEFAULT_OXY_API_URL = 'https://api.oxy.so';

/** Options shared by both ways of authenticating. */
interface PeableConfigOptions {
  /** Gateway base URL. Default `https://api.peable.to`. */
  baseURL?: string;
  /** oxy-api host used to mint the service token. Default `https://api.oxy.so`.
   * Unused with `tokenProvider`, which mints its own. */
  oxyApiUrl?: string;
  /** Optional deadline per HTTP attempt, including body consumption. */
  requestTimeoutMs?: number;
  /** Pinned Ed25519 authority keys, obtained from trusted deployment configuration. */
  invoiceAuthorityKeys?: Readonly<Record<string, string>>;
  taxQuoteAuthorityKeys?: Readonly<Record<string, string>>;
}

/** Authenticate with an `ApplicationCredential`; the SDK mints the token. */
export interface PeableCredentialConfig extends PeableConfigOptions {
  /** ApplicationCredential publicKey (e.g. `oxy_dk_...`). */
  publicKey: string;
  /** ApplicationCredential plaintext secret. */
  secret: string;
  tokenProvider?: undefined;
}

/** Authenticate with Oxy service tokens the caller already knows how to obtain. */
export interface PeableTokenProviderConfig extends PeableConfigOptions {
  /** Supplies the bearer for every Gateway request. `invalidate()` is called
   * when the Gateway answers 401, before the single retry; the next
   * `getToken()` must then return a freshly minted token. */
  tokenProvider: ServiceTokenProvider;
  publicKey?: undefined;
  secret?: undefined;
}

export type PeableConfig = PeableCredentialConfig | PeableTokenProviderConfig;

interface ResolvedPeableConfigOptions {
  baseURL: string;
  oxyApiUrl: string;
  requestTimeoutMs?: number;
  invoiceAuthorityKeys?: Readonly<Record<string, string>>;
  taxQuoteAuthorityKeys?: Readonly<Record<string, string>>;
}

/** `PeableCredentialConfig` with every optional field defaulted and normalized. */
export interface ResolvedPeableCredentialConfig extends ResolvedPeableConfigOptions {
  publicKey: string;
  secret: string;
  tokenProvider?: undefined;
}

/** `PeableTokenProviderConfig` with every optional field defaulted and normalized. */
export interface ResolvedPeableTokenProviderConfig extends ResolvedPeableConfigOptions {
  tokenProvider: ServiceTokenProvider;
  publicKey?: undefined;
  secret?: undefined;
}

/** `PeableConfig` with every optional field defaulted and normalized. */
export type ResolvedPeableConfig =
  | ResolvedPeableCredentialConfig
  | ResolvedPeableTokenProviderConfig;

export function resolveRequestTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timeout = value;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new Error('Peable: requestTimeoutMs must be a positive32-bit integer');
  }
  return timeout;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function isServiceTokenProvider(value: unknown): value is ServiceTokenProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { getToken?: unknown; invalidate?: unknown };
  return typeof candidate.getToken === 'function' && typeof candidate.invalidate === 'function';
}

/**
 * Validate and normalize an `PeableConfig`. Throws a plain `Error` for a
 * missing `publicKey`/`secret`, for a `tokenProvider` passed alongside either
 * of them or for neither being passed — a programmer error caught at
 * construction time, not an API-response failure, so it deliberately does not
 * go through the `PeableError` hierarchy (which models mapped HTTP responses).
 */
export function resolveConfig(config: PeableCredentialConfig): ResolvedPeableCredentialConfig;
export function resolveConfig(config: PeableTokenProviderConfig): ResolvedPeableTokenProviderConfig;
export function resolveConfig(config: PeableConfig): ResolvedPeableConfig;
export function resolveConfig(config: PeableConfig): ResolvedPeableConfig {
  // Read loosely: a JavaScript caller is not held to the union, and "both" is
  // exactly the shape the types forbid.
  const { tokenProvider, publicKey, secret } = config as {
    tokenProvider?: unknown;
    publicKey?: unknown;
    secret?: unknown;
  };
  if (tokenProvider !== undefined) {
    if (publicKey !== undefined || secret !== undefined) {
      throw new Error('Peable: pass either `tokenProvider` or `publicKey` + `secret`, not both');
    }
    if (!isServiceTokenProvider(tokenProvider)) {
      throw new Error('Peable: `tokenProvider` must have `getToken()` and `invalidate()`');
    }
  } else {
    if (publicKey === undefined && secret === undefined) {
      throw new Error('Peable: either `publicKey` + `secret` or a `tokenProvider` is required');
    }
    if (!config.publicKey) {
      throw new Error('Peable: `publicKey` is required');
    }
    if (!config.secret) {
      throw new Error('Peable: `secret` is required');
    }
  }
  const options: ResolvedPeableConfigOptions = {
    requestTimeoutMs: resolveRequestTimeout(config.requestTimeoutMs),
    taxQuoteAuthorityKeys: config.taxQuoteAuthorityKeys
      ? Object.freeze({ ...config.taxQuoteAuthorityKeys })
      : undefined,
    invoiceAuthorityKeys: config.invoiceAuthorityKeys
      ? Object.freeze({ ...config.invoiceAuthorityKeys })
      : undefined,
    baseURL: stripTrailingSlash(config.baseURL ?? DEFAULT_GATEWAY_BASE_URL),
    oxyApiUrl: stripTrailingSlash(config.oxyApiUrl ?? DEFAULT_OXY_API_URL),
  };
  return config.tokenProvider !== undefined
    ? { ...options, tokenProvider: config.tokenProvider }
    : { ...options, publicKey: config.publicKey, secret: config.secret };
}
