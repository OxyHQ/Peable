import { afterEach, expect, mock, test } from 'bun:test';
import { gatewayGet, gatewayPost } from '../gatewayFetch';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('gatewayGet forwards `init` (e.g. headers) to fetch unchanged', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await gatewayGet('/v1/checkout_sessions/cs_1/public', {
    headers: { 'X-Peable-Client-Secret': 'secret_abc' },
  });

  expect(new Headers(capturedInit?.headers).get('X-Peable-Client-Secret')).toBe('secret_abc');
});

test('a failed request throws an Error whose message never contains a client_secret or a query string', async () => {
  const fetchMock = mock(async () => new Response(null, { status: 403 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  let caught: unknown;
  try {
    await gatewayGet('/v1/checkout_sessions/cs_1/public?client_secret=leaked_secret_value');
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).not.toContain('client_secret');
  expect(message).not.toContain('leaked_secret_value');
  expect(message).not.toContain('?');
  expect(message).toBe(
    'Gateway request to /v1/checkout_sessions/cs_1/public failed with status 403',
  );
});

test('a failed POST throws an Error identifying the path and status', async () => {
  const fetchMock = mock(async () => new Response(null, { status: 500 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(gatewayPost('/v1/payment_links/link_1/payment_intent')).rejects.toThrow(
    'Gateway request to /v1/payment_links/link_1/payment_intent failed with status 500',
  );
});
