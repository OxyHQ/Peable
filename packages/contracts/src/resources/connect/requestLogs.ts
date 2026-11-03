import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, listQuery, queryInteger } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { REQUEST_LOG_METHODS, REQUEST_LOG_STATUS_CLASSES } from '../../vocabulary/reporting';

/**
 * One merchant API request, as Peable recorded it (`req_…`) — the request log
 * Orbit and `peable logs tail` read. Its `id` IS the `Request-Id` that request
 * was answered with, so the id a merchant quotes to support and the log row
 * are the same thing.
 *
 * Deliberately thin: method, path (no query string), status, duration and the
 * `Idempotency-Key` it carried. No body, no headers, no query string, no caller
 * address — a log a merchant can read is a log that must not hold what a
 * request carried. Kept 30 days.
 */
export const requestLogSchema = defineObject(
  'request_log',
  'RequestLog',
  z
    .object({
      id: z.string().describe("The request's `Request-Id` (`req_…`)."),
      object: z.literal('request_log'),
      livemode,
      method: z.enum(REQUEST_LOG_METHODS),
      path: z.string().describe('The path that was requested, without its query string.'),
      status: z.number().int().describe('The HTTP status it was answered with.'),
      duration_ms: z
        .number()
        .int()
        .nonnegative()
        .describe('How long the gateway took to answer, in milliseconds.'),
      idempotency_key: z
        .string()
        .nullable()
        .describe('The `Idempotency-Key` the request carried, if it carried a valid one.'),
      created: unixSeconds.describe('When it was answered.'),
    })
    .strict(),
  {
    examples: [
      {
        id: 'req_0193b8f35e9c4f2a7b18',
        object: 'request_log',
        livemode: false,
        method: 'POST',
        path: '/v1/payment_intents',
        status: 201,
        duration_ms: 84,
        idempotency_key: '5f1d3c2e-8a4b-4f6e-9d2c-1b7a0e3f4c5d',
        created: 1793750400,
      },
    ],
  },
);
export type RequestLog = Expand<z.output<typeof requestLogSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    request_log: RequestLog;
  }
}

/** `status=404` (one code) or `status=4xx` (a class). */
const requestLogStatusFilter = z
  .union([queryInteger({ min: 100, max: 599 }), z.enum(REQUEST_LOG_STATUS_CLASSES)])
  .describe('One status code (`404`) or a class (`2xx`, `3xx`, `4xx`, `5xx`).');
export type RequestLogStatusFilter = z.output<typeof requestLogStatusFilter>;

const requestLogFilters = {
  status: requestLogStatusFilter.optional(),
  method: z.enum(REQUEST_LOG_METHODS).optional(),
} as const;

export const listRequestLogsQuery = listQuery(requestLogFilters);
export type RequestLogListParams = z.input<typeof listRequestLogsQuery>;

/** The live tail's filters: the list's, without paging. */
export const streamRequestLogsQuery = z.object(requestLogFilters).strict();
export type RequestLogStreamParams = z.input<typeof streamRequestLogsQuery>;

export const requestLogRoutes = [
  defineRoute({
    operationId: 'listRequestLogs',
    method: 'get',
    path: '/v1/request_logs',
    tag: 'Request logs',
    summary: 'List request logs',
    description:
      'Your API requests of the last 30 days, newest first, filtered by `status`, `method` and `created`.',
    auth: 'service',
    scope: 'payments:read',
    query: listRequestLogsQuery,
    response: listOf(requestLogSchema),
    sdk: 'requestLogs.list',
    expandable: 'request_log',
  }),
  defineRoute({
    operationId: 'streamRequestLogs',
    method: 'get',
    path: '/v1/request_logs/stream',
    tag: 'Request logs',
    summary: 'Stream request logs',
    description:
      'Server-Sent Events: each request as it is answered (`event: request_log`), after a `ready` event. Reconnect with `Last-Event-ID` to resume without a gap. Test mode only; a stream ends after 15 minutes.',
    auth: 'service',
    scope: 'payments:read',
    testModeOnly: true,
    query: streamRequestLogsQuery,
    response: { kind: 'stream', event: requestLogSchema },
    sdk: 'requestLogs.stream',
  }),
  defineRoute({
    operationId: 'retrieveRequestLog',
    method: 'get',
    path: '/v1/request_logs/{id}',
    tag: 'Request logs',
    summary: 'Retrieve a request log',
    description: 'By `Request-Id`; 404 once older than 30 days.',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The `Request-Id` (`req_…`).' },
    query: expandOnlyQuery,
    response: requestLogSchema,
    sdk: 'requestLogs.retrieve',
  }),
] as const;
