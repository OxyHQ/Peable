import type { AuthenticatedResponseRequest } from '@oxy.so/core';

/** Preserve Peable's domain list envelope through shared authenticated transport. */
export async function readTaxList<T>(
  client: {
    requestAuthenticatedResponse(request: AuthenticatedResponseRequest): Promise<Response>;
  },
  url: string,
): Promise<{ object: 'list'; data: T[] }> {
  const response = await client.requestAuthenticatedResponse({ method: 'GET', url });
  if (!response.ok) throw new Error(`Unable to load tax data (HTTP ${response.status})`);
  const body = await response.json();
  if (body?.object !== 'list' || !Array.isArray(body.data))
    throw new Error('Invalid Peable tax list response');
  return body;
}
