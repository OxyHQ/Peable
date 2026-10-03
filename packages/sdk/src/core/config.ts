// Configuration for the server-side `Peable` client. The SDK is configured
// with a confidential `ApplicationCredential` (`{publicKey, secret}`, the
// SAME credential Oxy Console already issues for a `type:'service'`
// credential) — never a bespoke "Peable API key". See the SDK plan's
// "Architecture / auth" section.

/** Default Gateway host (`api.peable.to`) — the SDK never sends a `livemode`
 * flag; the credential's `environment` rides in the minted service JWT and
 * the Gateway resolves test/live from it. */
export const DEFAULT_GATEWAY_BASE_URL = 'https://api.peable.to';

/** Default oxy-api host used to mint the short-lived service token. */
export const DEFAULT_OXY_API_URL = 'https://api.oxy.so';

export interface PeableConfig {
  /** ApplicationCredential publicKey (e.g. `oxy_dk_...`). */
  publicKey: string;
  /** ApplicationCredential plaintext secret. */
  secret: string;
  /** Gateway base URL. Default `https://api.peable.to`. */
  baseURL?: string;
  /** oxy-api host used to mint the service token. Default `https://api.oxy.so`. */
  oxyApiUrl?: string;
  /** Optional deadline per HTTP attempt, including body consumption. */
  requestTimeoutMs?: number;
}

/** `PeableConfig` with every optional field defaulted and normalized. */
export interface ResolvedPeableConfig {
  publicKey: string;
  secret: string;
  baseURL: string;
  oxyApiUrl: string;
  requestTimeoutMs?: number;
}

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

/**
 * Validate and normalize an `PeableConfig`. Throws a plain `Error` for a
 * missing `publicKey`/`secret` — a programmer error caught at construction
 * time, not an API-response failure, so it deliberately does not go through
 * the `PeableError` hierarchy (which models mapped HTTP responses).
 */
export function resolveConfig(config: PeableConfig): ResolvedPeableConfig {
  if (!config.publicKey) {
    throw new Error('Peable: `publicKey` is required');
  }
  if (!config.secret) {
    throw new Error('Peable: `secret` is required');
  }
  return {
    requestTimeoutMs: resolveRequestTimeout(config.requestTimeoutMs),
    publicKey: config.publicKey,
    secret: config.secret,
    baseURL: stripTrailingSlash(config.baseURL ?? DEFAULT_GATEWAY_BASE_URL),
    oxyApiUrl: stripTrailingSlash(config.oxyApiUrl ?? DEFAULT_OXY_API_URL),
  };
}
