// Own Oxy products use the shared workload transport through { oxy }.
// External customers retain ApplicationCredential and tokenProvider support.
// The Gateway resolves the merchant from the verified application/environment
// and applies merchant and finance rules independently of authentication.

import type { ServiceTokenProvider } from './serviceToken';

/** Oxy owns workload mint, proof binding and authenticated HTTP transport. */
export interface PeableOxyHost {
  createServiceClient(options: {
    baseURL: string;
    audience: string;
    requester?: PeableRequester;
  }): { fetch: typeof globalThis.fetch; dispose(): void };
}
export type PeableRequester = { accountId: string } & (
  | { token: string; taskId?: never; requesterContext?: never }
  | { taskId: string; token?: never; requesterContext?: never }
  | { requesterContext: string; token?: never; taskId?: never }
);
export const PEABLE_SERVICE_AUDIENCE = 'oxy-service:6a2f851751b784a86fd0e958';

/** Default Gateway host (`api.peable.to`) — the SDK never sends a `livemode`
 * flag; the credential's `environment` rides in the minted service JWT and
 * the Gateway resolves test/live from it. */
export const DEFAULT_GATEWAY_BASE_URL = 'https://api.peable.to';

/** Default oxy-api host used to mint the short-lived service token. */
export const DEFAULT_OXY_API_URL = 'https://api.oxy.so';

/** Options shared by the supported authentication methods. */
export interface PeableConfigOptions {
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
  oxy?: undefined;
  requester?: undefined;
}

/** Authenticate with Oxy service tokens the caller already knows how to obtain. */
export interface PeableTokenProviderConfig extends PeableConfigOptions {
  /** Supplies the bearer for every Gateway request. `invalidate()` is called
   * when the Gateway answers 401, before the single retry; the next
   * `getToken()` must then return a freshly minted token. */
  tokenProvider: ServiceTokenProvider;
  oxy?: undefined;
  requester?: undefined;
  publicKey?: undefined;
  secret?: undefined;
}

export interface PeableWorkloadConfig extends PeableConfigOptions {
  oxy: PeableOxyHost;
  requester?: PeableRequester;
  publicKey?: undefined;
  secret?: undefined;
  tokenProvider?: undefined;
}
export type PeableConfig =
  | PeableCredentialConfig
  | PeableTokenProviderConfig
  | PeableWorkloadConfig;

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
  oxy?: undefined;
  requester?: undefined;
}

/** `PeableTokenProviderConfig` with every optional field defaulted and normalized. */
export interface ResolvedPeableTokenProviderConfig extends ResolvedPeableConfigOptions {
  tokenProvider: ServiceTokenProvider;
  oxy?: undefined;
  requester?: undefined;
  publicKey?: undefined;
  secret?: undefined;
}

/** `PeableConfig` with every optional field defaulted and normalized. */
export type ResolvedPeableConfig =
  | ResolvedPeableCredentialConfig
  | ResolvedPeableTokenProviderConfig
  | (PeableWorkloadConfig & ResolvedPeableConfigOptions);

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
export function resolveConfig(
  config: PeableWorkloadConfig,
): PeableWorkloadConfig & ResolvedPeableConfigOptions;
export function resolveConfig(config: PeableConfig): ResolvedPeableConfig;
export function resolveConfig(config: PeableConfig): ResolvedPeableConfig {
  // Read loosely: a JavaScript caller is not held to the union, and "both" is
  // exactly the shape the types forbid.
  const { tokenProvider, publicKey, secret } = config as {
    tokenProvider?: unknown;
    publicKey?: unknown;
    secret?: unknown;
  };
  if (config.oxy !== undefined) {
    if (
      tokenProvider !== undefined ||
      publicKey !== undefined ||
      secret !== undefined ||
      typeof config.oxy.createServiceClient !== 'function'
    ) {
      throw new Error(
        'Peable: a shared workload client cannot be combined with external credentials',
      );
    }
  } else if (tokenProvider !== undefined) {
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
  if (config.oxy !== undefined)
    return {
      ...options,
      oxy: config.oxy,
      ...(config.requester ? { requester: { ...config.requester } } : {}),
    };
  return config.tokenProvider !== undefined
    ? { ...options, tokenProvider: config.tokenProvider }
    : { ...options, publicKey: config.publicKey, secret: config.secret };
}
