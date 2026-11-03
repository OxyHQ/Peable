// `createRestClient` — the one HTTP layer every resource method calls through.
//
// Per call it prefixes `baseURL`, sends `Peable-Version`, the bearer, and
// `Peable-Account` where the route accepts one; mints ONE `Idempotency-Key` for
// a `POST` that brought none; and then runs ATTEMPTS: each under its own
// deadline (headers and body together), a 401 re-attempted once with a freshly
// minted token, and a retryable failure (`retry.ts`) re-attempted with backoff
// up to `maxNetworkRetries` — every attempt presenting the same key, so a
// request the gateway already ran is answered with its stored result rather
// than run again (ADR 0014 D3).

import { randomUUID } from 'node:crypto';
import { PEABLE_API_VERSION, type PeableApiVersion } from '@peable.to/contracts/vocabulary';
import {
  DEFAULT_MAX_NETWORK_RETRIES,
  DEFAULT_TIMEOUT_MS,
  resolveMaxNetworkRetries,
  resolveTimeout,
} from './config';
import { errorFromResponse, PeableAPIError, PeableConnectionError, PeableError } from './errors';
import { encodeQuery, type QueryValue } from './list';
import { isRetryable, retryAfterMs, retryDelayMs, sleep } from './retry';
import type { ServiceTokenProvider } from './serviceToken';
import { timeoutSignal } from './timeoutSignal';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;

/** What every request accepts as its last argument. */
export interface RequestOptions {
  /** Replaces the client's `apiVersion` for this request (`Peable-Version`). */
  apiVersion?: PeableApiVersion;
  /** Replaces the client's `maxNetworkRetries` for this request. */
  maxNetworkRetries?: number;
  /** Replaces the client's `timeout` (milliseconds per attempt) for this request. */
  timeout?: number;
  /** Aborts the request — the attempt in flight and any backoff wait. */
  signal?: AbortSignal;
}

/** What a `POST` accepts beside {@link RequestOptions}. */
export interface IdempotencyOptions {
  /**
   * Sent as `Idempotency-Key`. Without one the SDK mints a uuid per CALL — the
   * same key on every attempt of it — so the call's own retries never run it
   * twice. Pass your own to make retries ACROSS calls converge too (after a
   * crash, from a queue).
   */
  idempotencyKey?: string;
}

/** What a route that accepts `Peable-Account` takes beside {@link RequestOptions}. */
export interface AccountOptions {
  /**
   * A connected account (`ca_…`) to act on, sent as `Peable-Account`: a
   * platform reading or acting on one of its sellers with its own credential.
   * Replaces the client's `peableAccount` for this request.
   */
  peableAccount?: string;
}

/**
 * The options of a hand-written resource method: every field, whatever the
 * route. The generated methods take exactly the fields their route accepts.
 */
export type PeableRequestOptions = RequestOptions & IdempotencyOptions & AccountOptions;

export interface RestClientRequestOptions extends PeableRequestOptions {
  /** JSON-encoded. Mutually exclusive with `form`. */
  body?: unknown;
  /**
   * Sent as `multipart/form-data` — a file upload. `fetch` writes the
   * `Content-Type` with its boundary, so none is set here.
   */
  form?: FormData;
  /** Arrays encode as `key[]=v`, objects as `key[sub]=v` — see `encodeQuery`. */
  query?: Readonly<Record<string, QueryValue>>;
  /**
   * The route accepts `Peable-Account`, so the client's default
   * `peableAccount` applies to it. The gateway refuses the header on every
   * other route, which is why a client default cannot simply go everywhere.
   */
  acceptsPeableAccount?: boolean;
  headers?: Record<string, string>;
}

/** The bytes of a binary answer (`GET /v1/files/:id/contents`, a report's CSV). */
export interface DownloadedBytes {
  readonly bytes: Uint8Array;
  /** The response's `Content-Type` (`text/csv`), when it named one. */
  readonly contentType: string | null;
  /** The name `Content-Disposition` gives the file, when it gives one. */
  readonly filename: string | null;
}

export interface RestClientStreamOptions
  extends Pick<RequestOptions, 'apiVersion' | 'signal'>,
    AccountOptions {
  query?: Readonly<Record<string, QueryValue>>;
  headers?: Record<string, string>;
  acceptsPeableAccount?: boolean;
}

export interface RestClient {
  request<T>(method: string, path: string, opts?: RestClientRequestOptions): Promise<T>;
}

/**
 * The client `createRestClient` builds: `request`, `download` for a binary
 * answer, and `stream` for a live tail.
 */
export interface GatewayClient extends RestClient {
  /**
   * Open a long-lived `GET` (Server-Sent Events) with the same headers and the
   * same single 401 re-attempt as `request`, and hand back the response whose
   * body is the stream. A non-2xx answer is thrown as the typed error. No
   * deadline and no retries apply: a stream is meant to stay open, `signal`
   * ends it, and the live tail (`liveStream.ts`) owns reconnecting.
   */
  stream(path: string, opts?: RestClientStreamOptions): Promise<Response>;
  /** A request whose success is BYTES, not JSON. Same attempts, deadline and retries as `request`. */
  download(method: string, path: string, opts?: RestClientRequestOptions): Promise<DownloadedBytes>;
}

export interface RestClientConfig {
  /** Gateway base URL, already stripped of a trailing slash. */
  baseURL: string;
  apiVersion?: PeableApiVersion;
  peableAccount?: string;
  maxNetworkRetries?: number;
  /** Milliseconds per attempt. */
  timeout?: number;
}

export interface RestClientDeps {
  fetch?: typeof fetch;
  /** The backoff wait — a test makes it instant. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The jitter source, in [0, 1). */
  random?: () => number;
}

function buildUrl(
  baseURL: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  const queryString = encodeQuery(query);
  return `${baseURL}${path}${queryString ? `?${queryString}` : ''}`;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `attachment; filename="x.csv"` → `x.csv`. */
function filenameOf(disposition: string | null): string | null {
  const match = disposition === null ? null : /filename="([^"]*)"/.exec(disposition);
  return match?.[1] ?? null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A body that started arriving and then failed: the outcome is unknown, the attempt retryable. */
function interrupted(response: Response, cause: unknown): PeableConnectionError {
  return new PeableConnectionError(
    `The Peable Gateway response body could not be read: ${describe(cause)}`,
    { statusCode: response.status, code: 'response_interrupted', raw: cause },
  );
}

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw interrupted(response, cause);
  }
  const body = parseJson(text);
  // Only an explicit No Content satisfies a void answer: a missing or
  // malformed JSON success is not a typed resource.
  if (body === undefined && response.status !== HTTP_NO_CONTENT) {
    throw new PeableAPIError('The Peable Gateway returned an invalid JSON response', {
      statusCode: response.status,
      code: 'invalid_response',
      ...(text.length === 0 ? {} : { raw: text }),
    });
  }
  return body;
}

async function readBytes(response: Response): Promise<DownloadedBytes> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw interrupted(response, cause);
  }
  return {
    bytes,
    contentType: response.headers.get('Content-Type'),
    filename: filenameOf(response.headers.get('Content-Disposition')),
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return parseJson(await response.text());
  } catch {
    return undefined;
  }
}

export function createRestClient(
  config: RestClientConfig,
  tokenProvider: ServiceTokenProvider | undefined,
  deps: RestClientDeps = {},
): GatewayClient {
  const fetchImpl = deps.fetch ?? fetch;
  const wait = deps.sleep ?? sleep;
  const random = deps.random ?? Math.random;
  const defaults = {
    apiVersion: config.apiVersion ?? PEABLE_API_VERSION,
    peableAccount: config.peableAccount,
    maxNetworkRetries: resolveMaxNetworkRetries(
      config.maxNetworkRetries,
      DEFAULT_MAX_NETWORK_RETRIES,
    ),
    timeout: resolveTimeout(config.timeout, DEFAULT_TIMEOUT_MS),
  };

  function baseHeaders(
    token: string | undefined,
    opts: Pick<RestClientRequestOptions, 'apiVersion' | 'peableAccount' | 'acceptsPeableAccount'>,
  ): Record<string, string> {
    const account =
      opts.peableAccount ?? (opts.acceptsPeableAccount ? defaults.peableAccount : undefined);
    return {
      'Peable-Version': opts.apiVersion ?? defaults.apiVersion,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(account === undefined ? {} : { 'Peable-Account': account }),
    };
  }

  /** Run the attempts of one call; `read` turns a 2xx into the call's answer. */
  async function send<T>(
    method: string,
    path: string,
    opts: RestClientRequestOptions,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const verb = method.toUpperCase();
    if (opts.body !== undefined && opts.form !== undefined) {
      throw new TypeError('Peable: a request carries a JSON body or a form, never both');
    }
    // Minted ONCE per call, above the attempts, so every attempt presents it.
    const idempotencyKey = opts.idempotencyKey ?? (verb === 'POST' ? randomUUID() : undefined);
    const maxRetries = resolveMaxNetworkRetries(opts.maxNetworkRetries, defaults.maxNetworkRetries);
    const timeout = resolveTimeout(opts.timeout, defaults.timeout);
    const url = buildUrl(config.baseURL, path, opts.query);
    const payload = opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    let retries = 0;
    let reauthenticated = false;

    for (;;) {
      let failure: PeableError;
      let retryAfter: number | undefined;
      const deadline = timeoutSignal(
        timeout,
        opts.signal,
        `The request to ${path} timed out after ${timeout} ms`,
      );
      try {
        const token = await tokenProvider?.getToken();
        const headers: Record<string, string> = {
          ...baseHeaders(token, opts),
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
          ...opts.headers,
        };
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: verb,
            headers,
            signal: deadline.signal,
            ...(payload === undefined ? {} : { body: payload }),
          });
        } catch (cause) {
          throw new PeableConnectionError(
            deadline.signal.aborted && !opts.signal?.aborted
              ? `The request to ${path} timed out after ${timeout} ms`
              : `Failed to reach the Peable Gateway at ${config.baseURL}: ${describe(cause)}`,
            {
              ...(deadline.signal.aborted && !opts.signal?.aborted ? { code: 'timeout' } : {}),
              raw: cause,
            },
          );
        }
        // A 401 means the cached token expired or was revoked mid-flight:
        // drop it and re-attempt ONCE with a fresh one. Not a retry: it does
        // not count against `maxNetworkRetries`.
        if (response.status === HTTP_UNAUTHORIZED && !reauthenticated && tokenProvider) {
          await response.body?.cancel().catch(() => undefined);
          tokenProvider.invalidate();
          reauthenticated = true;
          continue;
        }
        if (!response.ok) {
          retryAfter = retryAfterMs(response.headers.get('Retry-After'));
          throw errorFromResponse(
            response.status,
            await readErrorBody(response),
            response.headers.get('Request-Id'),
          );
        }
        return await read(response);
      } catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? error;
        if (!(error instanceof PeableError)) throw error;
        failure = error;
      } finally {
        deadline.dispose();
      }
      if (!isRetryable(failure) || retries >= maxRetries) throw failure;
      await wait(retryDelayMs(retries, retryAfter, random()), opts.signal);
      retries += 1;
    }
  }

  async function openStream(
    path: string,
    opts: RestClientStreamOptions,
    reauthenticated: boolean,
  ): Promise<Response> {
    const token = await tokenProvider?.getToken();
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...baseHeaders(token, opts),
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
      throw new PeableConnectionError(
        `Failed to reach the Peable Gateway at ${config.baseURL}: ${describe(cause)}`,
        { raw: cause },
      );
    }
    if (response.status === HTTP_UNAUTHORIZED && !reauthenticated && tokenProvider) {
      await response.body?.cancel().catch(() => undefined);
      tokenProvider.invalidate();
      return openStream(path, opts, true);
    }
    if (!response.ok) {
      throw errorFromResponse(
        response.status,
        await readErrorBody(response),
        response.headers.get('Request-Id'),
      );
    }
    return response;
  }

  return {
    request<T>(method: string, path: string, opts: RestClientRequestOptions = {}): Promise<T> {
      return send(method, path, opts, (response) => readJson(response) as Promise<T>);
    },
    download(
      method: string,
      path: string,
      opts: RestClientRequestOptions = {},
    ): Promise<DownloadedBytes> {
      return send(method, path, opts, readBytes);
    },
    stream(path: string, opts: RestClientStreamOptions = {}): Promise<Response> {
      return openStream(path, opts, false);
    },
  };
}

/** The `PeableRequestOptions` a hand-written method passes on, for a route that accepts `Peable-Account`. */
export function requestOptionsOf(
  options: PeableRequestOptions | undefined,
): RestClientRequestOptions {
  return { ...options, acceptsPeableAccount: true };
}
