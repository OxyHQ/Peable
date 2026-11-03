import type { ListParams } from './list';

/**
 * One merchant API request, as Peable recorded it (`req_…`) — the request log
 * Orbit and `peable logs tail` read.
 *
 * Its `id` IS the `Request-Id` that request was answered with, so the id a
 * merchant quotes to support and the log row are the same thing.
 *
 * Deliberately thin: method, path (no query string), status, duration and the
 * `Idempotency-Key` it carried. No body, no headers, no query string, no
 * caller address — a log a merchant can read is a log that must not hold what
 * a request carried. Kept 30 days.
 */
export const REQUEST_LOG_METHODS = ['GET', 'POST', 'DELETE', 'PATCH', 'PUT'] as const;
export type RequestLogMethod = (typeof REQUEST_LOG_METHODS)[number];

export interface RequestLog {
  /** The request's `Request-Id` (`req_…`). */
  id: string;
  object: 'request_log';
  livemode: boolean;
  method: RequestLogMethod;
  /** The path that was requested, without its query string. */
  path: string;
  /** The HTTP status it was answered with. */
  status: number;
  /** How long the gateway took to answer, in milliseconds. */
  duration_ms: number;
  /** The `Idempotency-Key` the request carried, if it carried a valid one. */
  idempotency_key: string | null;
  /** When it was answered, Unix seconds. */
  created: number;
}

/** `status`: one code (`404`) or a class (`2xx`, `4xx`, `5xx`). */
export type RequestLogStatusFilter = number | '2xx' | '3xx' | '4xx' | '5xx';

export interface RequestLogListParams extends ListParams {
  status?: RequestLogStatusFilter;
  method?: RequestLogMethod;
}

/** How long a request log is kept (and served). */
export const REQUEST_LOG_RETENTION_DAYS = 30;
