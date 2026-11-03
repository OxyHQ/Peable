import type {
  List,
  RequestLog,
  RequestLogListParams,
  RequestLogMethod,
  RequestLogStatusFilter,
} from '@peable.to/shared-types';
import type { GatewayClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';
import { liveStream, type LiveStreamOptions } from '../core/liveStream';

export interface RequestLogStreamParams extends LiveStreamOptions {
  /** One code (`404`) or a class (`'4xx'`). */
  status?: RequestLogStatusFilter;
  method?: RequestLogMethod;
}

/**
 * Your own API requests of the last 30 days (`req_…`, the `Request-Id` each
 * was answered with): method, path, status, duration, `Idempotency-Key`.
 * Never a body, a header or a query string.
 */
export class RequestLogsResource {
  constructor(private readonly client: GatewayClient) {}

  /** By `Request-Id`. */
  retrieve(id: string): Promise<RequestLog> {
    return this.client.request<RequestLog>('GET', `/v1/request_logs/${encodeURIComponent(id)}`);
  }

  list(params: RequestLogListParams = {}): ApiListPromise<RequestLog> {
    return listPromise(
      (page: RequestLogListParams) =>
        this.client.request<List<RequestLog>>('GET', '/v1/request_logs', {
          query: listQuery(page, { status: page.status, method: page.method }),
        }),
      params,
    );
  }

  /**
   * Your requests as they are answered — what `peable logs tail` prints. TEST
   * MODE ONLY. Reconnects and resumes on its own; ends when `signal` aborts.
   */
  stream(params: RequestLogStreamParams = {}): AsyncGenerator<RequestLog> {
    const { status, method, ...options } = params;
    return liveStream<RequestLog>(
      this.client,
      '/v1/request_logs/stream',
      'request_log',
      { status, method },
      options,
    );
  }
}
