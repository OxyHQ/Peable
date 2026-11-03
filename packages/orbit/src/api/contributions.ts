import {
  ContributionsResource,
  type RestClient,
  type RestClientRequestOptions,
} from '@peable.to/sdk/contributions';
import type { HttpMethod, OrbitTransport } from './transport';

const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'POST', 'PATCH']);

/**
 * The SDK's contribution resource — the same client the wallet's screen uses,
 * which validates every response against `@peable.to/contracts` — over Orbit's
 * transport, so a contribution list keeps its `has_more` and a refusal keeps
 * the gateway's message and request id.
 */
export function createContributionsApi(transport: OrbitTransport): ContributionsResource {
  const client: RestClient = {
    request<T>(method: string, path: string, options: RestClientRequestOptions = {}) {
      if (!METHODS.has(method)) {
        return Promise.reject(new Error(`Unsupported contribution operation: ${method}`));
      }
      return transport.request<T>(method as HttpMethod, path, {
        query: options.query,
        body: options.body,
        idempotencyKey: options.idempotencyKey,
      });
    },
  };
  return new ContributionsResource(client);
}
