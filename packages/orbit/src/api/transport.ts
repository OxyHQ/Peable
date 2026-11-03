import type { AuthenticatedResponseRequest } from '@oxy.so/core';

/**
 * The one way Orbit talks to the gateway.
 *
 * Built on the Oxy linked client's RAW authenticated response rather than its
 * `get`/`post` helpers, for two reasons that both decide what a merchant sees:
 *
 *  1. Those helpers unwrap any body with a `data` key and no `pagination` /
 *     `nextCursor` sibling. A Peable list is `{object:'list', data, has_more}`,
 *     so the helper returns the bare array and `has_more` is gone: page two of
 *     a payment list could never be asked for.
 *  2. A gateway error is `{error:{type, code?, param?, message, request_id}}`
 *     (ADR 0014 D1). Reading the body ourselves keeps the message and the
 *     request id, which is what support needs to find the cause.
 *
 * The linked client still owns the bearer: it mints and refreshes the user's
 * Oxy token and replays a string body once after a 401.
 */
export interface RawResponseClient {
  requestAuthenticatedResponse(request: AuthenticatedResponseRequest): Promise<Response>;
}

/** The scalar and structured values a query string carries. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly string[]
  | { readonly [key: string]: string | number | undefined };
export type Query = Readonly<Record<string, QueryValue>>;

/**
 * Encode a query the way the gateway reads it (Express's `qs`): arrays as
 * `key[]=v` (`expand[]=a&expand[]=b`), objects as `key[sub]=v`
 * (`created[gte]=1`); `undefined` and `null` are omitted. Keys keep their order.
 */
export function encodeQuery(query: Query | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(`${key}[]`, String(item));
    } else if (typeof value === 'object') {
      for (const [sub, inner] of Object.entries(value)) {
        if (inner !== undefined) search.append(`${key}[${sub}]`, String(inner));
      }
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

export interface RequestOptions {
  query?: Query;
  /** Serialized as JSON. */
  body?: unknown;
  /**
   * A `multipart/form-data` body instead of `body`, built afresh by each call
   * so the linked client can replay it once after a 401 (a consumed form cannot
   * be re-sent). No `Content-Type` is set: the runtime writes it with the
   * boundary.
   */
  form?: () => FormData;
  /** Sent as `Idempotency-Key` (ADR 0014 D3). Only when the caller has one to keep. */
  idempotencyKey?: string;
  /**
   * `blob` answers the body's raw bytes (a report's CSV) instead of parsing
   * JSON. A refusal is still read as the gateway's JSON error envelope.
   */
  responseType?: 'json' | 'blob';
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface OrbitTransport {
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
}

/**
 * A refusal from the gateway, in its own words.
 *
 * `status` 0 means no HTTP answer was read at all (the body was not JSON).
 */
export class OrbitApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | undefined;
  readonly param: string | undefined;
  readonly requestId: string | undefined;

  constructor(init: {
    status: number;
    type: string;
    message: string;
    code?: string;
    param?: string;
    requestId?: string;
  }) {
    super(init.message);
    this.name = 'OrbitApiError';
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.requestId = init.requestId;
  }
}

export function isOrbitApiError(error: unknown): error is OrbitApiError {
  return error instanceof OrbitApiError;
}

/** Append a query string, dropping `undefined`/`null` values. Keys keep their order. */
export function withQuery(path: string, query: Query | undefined): string {
  const encoded = encodeQuery(query);
  if (!encoded) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${encoded}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Turn a non-2xx response into an {@link OrbitApiError}, whatever shape its body has. */
export async function errorFromResponse(response: Response): Promise<OrbitApiError> {
  const headerRequestId = response.headers.get('Request-Id') ?? undefined;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const envelope =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error: unknown }).error
      : undefined;
  if (envelope && typeof envelope === 'object') {
    const fields = envelope as Record<string, unknown>;
    return new OrbitApiError({
      status: response.status,
      type: stringField(fields.type) ?? 'api_error',
      message: stringField(fields.message) ?? `Request failed (HTTP ${response.status})`,
      code: stringField(fields.code),
      param: stringField(fields.param),
      requestId: stringField(fields.request_id) ?? headerRequestId,
    });
  }
  // Pre-ADR-0014 routes answered `{error: "message"}`; keep the message.
  return new OrbitApiError({
    status: response.status,
    type: 'api_error',
    message: typeof envelope === 'string' ? envelope : `Request failed (HTTP ${response.status})`,
    requestId: headerRequestId,
  });
}

export function createOrbitTransport(client: RawResponseClient): OrbitTransport {
  return {
    async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}) {
      const headers: Record<string, string> = {};
      let body: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      if (options.body !== undefined && options.form) {
        throw new Error('A request carries a JSON body or a form, never both');
      }
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      const response = await client.requestAuthenticatedResponse({
        method,
        url: withQuery(path, options.query),
        ...(body === undefined ? {} : { body }),
        ...(options.form ? { bodyFactory: options.form } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      });
      if (!response.ok) throw await errorFromResponse(response);
      if (options.responseType === 'blob') return (await response.blob()) as T;
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new OrbitApiError({
          status: response.status,
          type: 'api_error',
          message: 'The gateway answered with something that is not JSON',
          requestId: response.headers.get('Request-Id') ?? undefined,
        });
      }
    },
  };
}

/** A user-facing sentence for any thrown value, with the request id when there is one. */
export function describeError(error: unknown, fallback: string): string {
  if (isOrbitApiError(error)) {
    return error.requestId ? `${error.message} (request ${error.requestId})` : error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
