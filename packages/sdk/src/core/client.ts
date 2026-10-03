// `RestClient` — the thin HTTP layer every resource namespace calls through.
// Prefixes `baseURL`, attaches the bearer service token, sets
// `Idempotency-Key` when given, serializes query params, parses JSON, and
// maps every non-2xx response via `errors.ts`.

import { resolveRequestTimeout } from './config';
import { errorFromResponse, PeableApiError } from './errors';
import type { ServiceTokenProvider } from './serviceToken';

const HTTP_UNAUTHORIZED = 401;

export interface RestClientRequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface RestClient {
  request<T>(method: string, path: string, opts?: RestClientRequestOptions): Promise<T>;
}

export interface RestClientConfig {
  /** Gateway base URL, already stripped of a trailing slash. */
  baseURL: string;
  requestTimeoutMs?: number;
}

function buildUrl(
  baseURL: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
): string {
  const search = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      search.set(key, String(value));
    }
  }
  const queryString = search.toString();
  return `${baseURL}${path}${queryString ? `?${queryString}` : ''}`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createRestClient(
  config: RestClientConfig,
  tokenProvider: ServiceTokenProvider,
  deps: { fetch?: typeof fetch } = {},
): RestClient {
  const fetchImpl = deps.fetch ?? fetch;
  const timeout = resolveRequestTimeout(config.requestTimeoutMs);

  async function performRequest<T>(
    method: string,
    path: string,
    opts: RestClientRequestOptions,
    allowRetryOn401: boolean,
  ): Promise<T> {
    const token = await tokenProvider.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.headers) Object.assign(headers, opts.headers);

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(config.baseURL, path, opts.query), {
        method,
        headers,
        ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (cause) {
      throw new PeableApiError(
        `Failed to reach the Peable Gateway at ${config.baseURL}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    // A 401 here means the cached service token expired or was revoked
    // mid-flight (it was valid when minted, or a prior request would have
    // failed at `tokenProvider.getToken()` already). Invalidate the cache and
    // retry exactly once with a freshly minted token before giving up.
    if (response.status === HTTP_UNAUTHORIZED && allowRetryOn401) {
      tokenProvider.invalidate();
      return performRequest<T>(method, path, opts, false);
    }

    // The Gateway echoes a date-based `Peable-Version` response header
    // (Stripe parity). No SDK behavior depends on it yet, so it is
    // deliberately not read here — nothing to do with it today.
    let body: unknown;
    try {
      body = await readJsonBody(response);
    } catch {
      // Headers can arrive before the connection fails during body consumption.
      // Preserve the known status, but do not infer whether a mutation committed
      // or retry it automatically. Recovery keeps the caller's original key.
      throw new PeableApiError('The Peable Gateway response body could not be read; remote outcome is unknown', {
        statusCode: response.status,
        code: 'invalid_response',
      });
    }
    if (!response.ok) {
      throw errorFromResponse(response.status, body);
    }
    // Only explicit No Content can satisfy a void response. A missing or
    // malformed JSON success is indeterminate, not a typed resource. Do not
    // retry a mutation automatically: callers retain the original intent key.
    if (body === undefined && response.status !== 204) {
      throw new PeableApiError('The Peable Gateway returned an invalid JSON response', {
        statusCode: response.status,
        code: 'invalid_response',
      });
    }
    return body as T;
  }

  return {
    request<T>(method: string, path: string, opts: RestClientRequestOptions = {}): Promise<T> {
      return performRequest<T>(method, path, opts, true);
    },
  };
}
