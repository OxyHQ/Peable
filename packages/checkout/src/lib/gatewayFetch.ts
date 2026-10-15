// Thin fetch wrapper for the Gateway's plain REST routes that sit outside
// `@peable.to/sdk/checkout` — payment links and checkout sessions have no SDK
// client core (only payment intents do; see `intentClient.ts`), so
// LinkRoute/SessionRoute call the Gateway directly. Centralizes the base URL
// + error handling so neither route hand-rolls response checking.
import { GATEWAY_URL } from './config';

async function gatewayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, init);
  if (!response.ok) {
    // Strip the query string before it lands in a thrown Error.message — a
    // route can render this message straight into the DOM (SessionRoute),
    // and the path must never carry a capability token even if some future
    // caller passes one as a query param again (defense in depth).
    const pathWithoutQuery = path.split('?')[0];
    throw new Error(`Gateway request to ${pathWithoutQuery} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function gatewayGet<T>(path: string, init?: RequestInit): Promise<T> {
  return gatewayFetch<T>(path, init);
}

export function gatewayPost<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  return gatewayFetch<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
  });
}
