import { ContributionsResource } from '@peable.to/sdk/contributions';
import { gateway } from './gateway-client';
/** The owning SDK validates every response; Oxy owns session refresh. */
export const contributions = new ContributionsResource({
  request: async <T>(method: string, path: string, options = {}) => {
    const opts = options as import('@peable.to/sdk/contributions').RestClientRequestOptions;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {}))
      if (value !== undefined) query.set(key, String(value));
    const url = path + (query.size ? `?${query}` : '');
    const headers = opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    if (method === 'GET') return gateway.client.get<T>(url, { cache: false });
    if (method === 'POST') return gateway.client.post<T>(url, opts.body, { headers });
    if (method === 'PATCH') return gateway.client.patch<T>(url, opts.body, { headers });
    throw new Error('Unsupported contribution operation');
  },
});
