import { ContributionsResource, encodeQuery } from '@peable.to/sdk/contributions';
import { gateway } from './gateway-client';
/** The owning SDK validates every response; Oxy owns session refresh. */
export const contributions = new ContributionsResource({
  request: async <T>(method: string, path: string, options = {}) => {
    const opts = options as import('@peable.to/sdk/contributions').RestClientRequestOptions;
    // The SDK's own encoder, so `created[gte]` and `expand[]` reach the gateway
    // in the shape it parses rather than as `[object Object]`.
    const query = encodeQuery(opts.query);
    const url = path + (query ? `?${query}` : '');
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    if (method === 'GET') return gateway.client.get<T>(url, { cache: false });
    // Every write — create and update alike — is a POST on this API.
    if (method === 'POST') return gateway.client.post<T>(url, opts.body, { headers });
    throw new Error('Unsupported contribution operation');
  },
});
