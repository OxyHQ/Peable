// `RestClient` — the thin HTTP layer every resource namespace calls through.
// Prefixes `baseURL`, attaches the bearer service token, sets
// `Idempotency-Key` on every POST (the caller's, or a fresh one), serializes
// query params, parses JSON, and maps every non-2xx response via `errors.ts`.

import { randomUUID } from 'node:crypto';
import { resolveRequestTimeout } from './config';
import { encodeQuery, type QueryValue } from './list';
import { errorFromResponse, PeableApiError } from './errors';
import type { ServiceTokenProvider } from './serviceToken';
import { timeoutSignal } from './timeoutSignal';

const HTTP_UNAUTHORIZED = 401;

export interface RestClientRequestOptions {
  /** JSON-encoded. Mutually exclusive with `form`. */
  body?: unknown;
  /**
   * Sent as `multipart/form-data` — a file upload. `fetch` writes the
   * `Content-Type` with its boundary, so none is set here; `Idempotency-Key`
   * is still sent, and the gateway binds it to the purpose and the bytes'
   * hash.
   */
  form?: FormData;
  /** Arrays encode as `key[]=v`, objects as `key[sub]=v` — see `encodeQuery`. */
  query?: Readonly<Record<string, QueryValue>>;
  /**
   * Sent as `Idempotency-Key`. On a POST without one, the client mints a uuid
   * per call — the same key for every attempt of that call — so a retry of
   * the same call can never run twice (ADR 0014 D3). Pass your own to make a
   * retry ACROSS calls (after a crash, from a queue) converge too.
   */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface RestClientStreamOptions {
  query?: Readonly<Record<string, QueryValue>>;
  headers?: Record<string, string>;
  /** Aborts the connection — the only way a long-lived stream ends early. */
  signal?: AbortSignal;
}

export interface RestClient {
  request<T>(method: string, path: string, opts?: RestClientRequestOptions): Promise<T>;
}

/**
 * The client `createRestClient` builds: `request`, and `stream` for the two
 * live tails (`events.stream`, `requestLogs.stream`). A separate interface so
 * the `RestClient` an integrator implements (Orbit's contributions client)
 * does not have to grow a method it never needs.
 */
export interface GatewayClient extends RestClient {
  /**
   * Open a long-lived `GET` (Server-Sent Events) with the same authentication
   * and the same single 401 retry as `request`, and hand back the response
   * whose body is the stream. A non-2xx answer is read and thrown as the same
   * typed error `request` would throw. No request timeout applies: a stream is
   * meant to stay open, and `signal` is how the caller ends it.
   */
  stream(path: string, opts?: RestClientStreamOptions): Promise<Response>;
}

export interface RestClientConfig {
  /** Gateway base URL, already stripped of a trailing slash. */
  baseURL: string;
  requestTimeoutMs?: number;
}

function buildUrl(
  baseURL: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  const queryString = encodeQuery(query);
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
  tokenProvider: ServiceTokenProvider | undefined,
  deps: { fetch?: typeof fetch } = {},
): GatewayClient {
  const fetchImpl = deps.fetch ?? fetch;
  const timeout = resolveRequestTimeout(config.requestTimeoutMs);

  async function performRequest<T>(
    method: string,
    path: string,
    opts: RestClientRequestOptions,
    allowRetryOn401: boolean,
  ): Promise<T> {
    const token = await tokenProvider?.getToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    if (opts.body !== undefined && opts.form !== undefined) {
      throw new PeableApiError('A request carries a JSON body or a form, never both');
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.headers) Object.assign(headers, opts.headers);

    // One deadline over the headers AND the body, released once both are in.
    const deadline = timeout === undefined ? undefined : timeoutSignal(timeout);
    let response: Response;
    let body: unknown;
    try {
      try {
        response = await fetchImpl(buildUrl(config.baseURL, path, opts.query), {
          method,
          headers,
          ...(deadline === undefined ? {} : { signal: deadline.signal }),
          body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
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
      // retry exactly once with a freshly minted token, under its own deadline.
      if (response.status === HTTP_UNAUTHORIZED && allowRetryOn401 && tokenProvider) {
        tokenProvider.invalidate();
        return performRequest<T>(method, path, opts, false);
      }

      // The Gateway echoes a date-based `Peable-Version` response header
      // (Stripe parity). No SDK behavior depends on it yet, so it is
      // deliberately not read here — nothing to do with it today.
      try {
        body = await readJsonBody(response);
      } catch {
        // Headers can arrive before the connection fails during body consumption.
        // Preserve the known status, but do not infer whether a mutation committed
        // or retry it automatically. Recovery keeps the caller's original key.
        throw new PeableApiError(
          'The Peable Gateway response body could not be read; remote outcome is unknown',
          {
            statusCode: response.status,
            code: 'invalid_response',
          },
        );
      }
    } finally {
      deadline?.dispose();
    }
    if (!response.ok) {
      throw errorFromResponse(response.status, body, response.headers.get('Request-Id'));
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

  async function openStream(
    path: string,
    opts: RestClientStreamOptions,
    allowRetryOn401: boolean,
  ): Promise<Response> {
    const token = await tokenProvider?.getToken();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    };
    let response: Response;
    try {
      response = await fetchImpl(buildUrl(config.baseURL, path, opts.query), {
        method: 'GET',
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (cause) {
      if (opts.signal?.aborted) throw cause;
      throw new PeableApiError(
        `Failed to reach the Peable Gateway at ${config.baseURL}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    if (response.status === HTTP_UNAUTHORIZED && allowRetryOn401 && tokenProvider) {
      await response.body?.cancel();
      tokenProvider.invalidate();
      return openStream(path, opts, false);
    }
    if (!response.ok) {
      const body = await readJsonBody(response).catch(() => undefined);
      throw errorFromResponse(response.status, body, response.headers.get('Request-Id'));
    }
    return response;
  }

  return {
    stream(path: string, opts: RestClientStreamOptions = {}): Promise<Response> {
      return openStream(path, opts, true);
    },
    request<T>(method: string, path: string, opts: RestClientRequestOptions = {}): Promise<T> {
      // Minted ONCE per call, above the attempts, so the 401 re-attempt below
      // presents the same key: a request the gateway already ran is answered
      // with its stored result rather than run again.
      const idempotencyKey =
        opts.idempotencyKey ?? (method.toUpperCase() === 'POST' ? randomUUID() : undefined);
      return performRequest<T>(
        method,
        path,
        idempotencyKey === undefined ? opts : { ...opts, idempotencyKey },
        true,
      );
    },
  };
}
