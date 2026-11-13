import { createServer } from 'node:http';
import { describe, expect, test } from 'bun:test';
import { createRestClient } from '../../src/core/client';
import { PEABLE_API_VERSION } from '@peable.to/contracts/vocabulary';
import {
  PeableAuthenticationError,
  PeableConnectionError,
  PeableIdempotencyError,
  PeableInvalidRequestError,
  PeableRateLimitError,
} from '../../src/core/errors';
import type { ServiceTokenProvider } from '../../src/core/serviceToken';
import { createMockFetch } from '../support/mockFetch';
import { TEST_GATEWAY_URL } from '../support/testGateway';

/** A `ServiceTokenProvider` test double: returns `tokens[n]` where `n` is the
 * number of times `invalidate()` has been called, so a 401-retry test can
 * assert the client picked up a freshly-minted token on its second try. */
function fakeTokenProvider(tokens: string[]): {
  provider: ServiceTokenProvider;
  invalidateCalls: number[];
} {
  const invalidateCalls: number[] = [];
  let index = 0;
  return {
    provider: {
      getToken: async () => tokens[Math.min(index, tokens.length - 1)] as string,
      invalidate: () => {
        index += 1;
        invalidateCalls.push(index);
      },
    },
    invalidateCalls,
  };
}

/** No backoff wait. */
const instant = { sleep: async () => {} };

describe('createRestClient', () => {
  test('attaches the bearer token and omits Content-Type/Idempotency-Key when absent', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { object: 'payment_intent' },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('GET', '/v1/payment_intents/pi_1');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1`);
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer tok_1');
    expect(requests[0]?.headers.get('Content-Type')).toBeNull();
    expect(requests[0]?.headers.get('Idempotency-Key')).toBeNull();
  });

  test('a stale invoice approval is surfaced without retrying finalize', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 409,
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'invoice_finalization_conflict',
          message: 'Review the draft again',
        },
      },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL, maxNetworkRetries: 3 }, provider, {
      fetch: fetchImpl,
      ...instant,
    });
    await expect(
      client.request('POST', '/v1/invoices/in_1/finalize', {
        body: { expected_finalization_revision: 'a'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'invoice_finalization_conflict', statusCode: 409 });
    expect(requests).toHaveLength(1);
  });

  test('serializes a JSON body and sets Content-Type', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 201,
      json: { id: 'pi_1' },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('POST', '/v1/payment_intents', { body: { amount: '100' } });

    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ amount: '100' });
  });

  test('sets the Idempotency-Key header when given', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 201, json: {} }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('POST', '/v1/payment_intents', {
      body: { amount: '100' },
      idempotencyKey: 'idem-123',
    });

    expect(requests[0]?.headers.get('Idempotency-Key')).toBe('idem-123');
  });

  /**
   * Every POST carries a key (ADR 0014 D3), as Stripe's SDKs do: without one,
   * a call whose response was lost could only be retried as a SECOND request.
   */
  test('mints a fresh uuid Idempotency-Key per POST call when none is given', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 201, json: {} }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('POST', '/v1/payment_links', { body: { amount: '100' } });
    await client.request('POST', '/v1/payment_links', { body: { amount: '100' } });

    const first = requests[0]?.headers.get('Idempotency-Key');
    const second = requests[1]?.headers.get('Idempotency-Key');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    // Two calls are two operations.
    expect(second).not.toBe(first);
  });

  test('re-attempting a POST after a 401 presents the SAME minted key', async () => {
    let calls = 0;
    const { fetch: fetchImpl, requests } = createMockFetch(() => {
      calls += 1;
      return calls === 1
        ? { status: 401, json: { error: { type: 'authentication_error', message: 'expired' } } }
        : { status: 201, json: { id: 'pi_1' } };
    });
    const { provider } = fakeTokenProvider(['tok_old', 'tok_new']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('POST', '/v1/payment_intents', { body: { amount: '100' } });

    expect(requests).toHaveLength(2);
    const key = requests[0]?.headers.get('Idempotency-Key');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]?.headers.get('Idempotency-Key')).toBe(key ?? 'missing');
  });

  test('never sends a key on a GET', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 200, json: {} }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('GET', '/v1/payment_links');

    expect(requests[0]?.headers.get('Idempotency-Key')).toBeNull();
  });

  test('serializes query params and skips undefined values', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { object: 'list', data: [], has_more: false },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await client.request('GET', '/v1/payment_intents', {
      query: { status: 'succeeded', limit: 10, starting_after: undefined },
    });

    const url = new URL(requests[0]?.url ?? '');
    expect(url.searchParams.get('status')).toBe('succeeded');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('starting_after')).toBe(false);
  });

  test('returns the parsed JSON body on 2xx', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 200,
      json: { id: 'pi_1', status: 'requires_action' },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    const result = await client.request<{ id: string; status: string }>(
      'GET',
      '/v1/payment_intents/pi_1',
    );

    expect(result).toEqual({ id: 'pi_1', status: 'requires_action' });
  });

  test('maps a non-2xx nested-envelope response to a typed PeableError', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 400,
      headers: { 'Request-Id': 'req_abc' },
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'parameter_invalid',
          param: 'amount',
          message: 'bad amount',
          request_id: 'req_abc',
        },
      },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    const failure = await client
      .request('POST', '/v1/payment_intents', { body: {} })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PeableInvalidRequestError);
    expect(failure).toMatchObject({ statusCode: 400, param: 'amount', requestId: 'req_abc' });
  });

  test('takes the request id from the Request-Id header on a flat auth refusal', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 403,
      headers: { 'Request-Id': 'req_flat' },
      json: { error: 'INSUFFICIENT_SCOPE', message: 'missing scope' },
    }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await expect(client.request('GET', '/v1/payment_intents')).rejects.toMatchObject({
      requestId: 'req_flat',
      code: 'INSUFFICIENT_SCOPE',
    });
  });

  test('on 401, invalidates the token and retries once with a fresh token', async () => {
    let callCount = 0;
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      callCount += 1;
      if (callCount === 1) {
        return { status: 401, json: { error: 'TOKEN_EXPIRED', message: 'Service token expired' } };
      }
      // Second attempt must carry the freshly-minted token.
      expect(req.headers.get('Authorization')).toBe('Bearer tok_2');
      return { status: 200, json: { id: 'pi_1' } };
    });
    const { provider, invalidateCalls } = fakeTokenProvider(['tok_1', 'tok_2']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    const result = await client.request<{ id: string }>('GET', '/v1/payment_intents/pi_1');

    expect(result).toEqual({ id: 'pi_1' });
    expect(requests).toHaveLength(2);
    expect(invalidateCalls).toHaveLength(1);
  });

  test('a second consecutive 401 is NOT retried again — throws the mapped auth error', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 401,
      json: { error: 'TOKEN_EXPIRED', message: 'Service token expired' },
    }));
    const { provider, invalidateCalls } = fakeTokenProvider(['tok_1', 'tok_2', 'tok_3']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });

    await expect(client.request('GET', '/v1/payment_intents/pi_1')).rejects.toBeInstanceOf(
      PeableAuthenticationError,
    );
    // Exactly one retry: two fetch attempts, one invalidate.
    expect(requests).toHaveLength(2);
    expect(invalidateCalls).toHaveLength(1);
  });

  test('a network failure is a PeableConnectionError, after the default 2 retries', async () => {
    let attempts = 0;
    const failingFetch = (() => {
      attempts += 1;
      return Promise.reject(new Error('ECONNRESET'));
    }) as unknown as typeof fetch;
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, {
      fetch: failingFetch,
      ...instant,
    });

    await expect(client.request('GET', '/v1/payment_intents/pi_1')).rejects.toBeInstanceOf(
      PeableConnectionError,
    );
    expect(attempts).toBe(3);
  });
});

// Real HTTP response boundary: an accepted remote effect can lose its JSON body.
// The caller must receive a controlled failure and choose to retry the SAME key.
describe('createRestClient real HTTP response integrity', () => {
  for (const [status, body] of [
    [200, ''],
    [201, ''],
    [200, '{incomplete'],
    [201, '<html>upstream</html>'],
  ] as const) {
    test(`rejects missing or malformed JSON on ${status}: ${body.length} bytes`, async () => {
      const keys: Array<string | null> = [];
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          keys.push(request.headers.get('Idempotency-Key'));
          return new Response(body, { status });
        },
      });
      try {
        const { provider } = fakeTokenProvider(['synthetic-token']);
        const client = createRestClient(
          { baseURL: `http://127.0.0.1:${server.port}` },
          provider,
          instant,
        );
        await expect(
          client.request('POST', '/v1/billing/checkout_sessions', {
            body: {},
            idempotencyKey: 'same-intent',
          }),
        ).rejects.toMatchObject({
          name: 'PeableAPIError',
          statusCode: status,
          code: 'invalid_response',
        });
        // A 2xx that is not JSON is not a transport failure: not retried.
        expect(keys).toEqual(['same-intent']);
      } finally {
        await server.stop(true);
      }
    });
  }

  test('preserves valid JSON, explicit 204 and malformed non-success status mapping', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/empty') return new Response(null, { status: 204 });
        if (path === '/failure') return new Response('<html>upstream</html>', { status: 503 });
        return Response.json({ id: 'synthetic-result' }, { status: 201 });
      },
    });
    try {
      const { provider } = fakeTokenProvider(['synthetic-token']);
      const client = createRestClient(
        { baseURL: `http://127.0.0.1:${server.port}` },
        provider,
        instant,
      );
      expect(await client.request<{ id: string }>('GET', '/valid')).toEqual({
        id: 'synthetic-result',
      });
      expect(await client.request<void>('DELETE', '/empty')).toBeUndefined();
      await expect(client.request('GET', '/failure')).rejects.toMatchObject({
        name: 'PeableAPIError',
        statusCode: 503,
      });
    } finally {
      await server.stop(true);
    }
  });
});

// Actual TCP body interruption after flushed headers; no mocked Response.text.
describe('createRestClient interrupted HTTP body', () => {
  for (const status of [200, 201, 503]) {
    test(`a body cut off after ${status} is retried under the original key, and runs once`, async () => {
      const keys: Array<string | undefined> = [];
      let effects = 0;
      const server = createServer((request, response) => {
        request.resume();
        const key = request.headers['idempotency-key'] as string | undefined;
        keys.push(key);
        if (keys.length === 1) {
          effects += 1; // Synthetic server committed before transport failed.
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.flushHeaders();
          response.write('{"id":');
          setTimeout(() => response.destroy(), 30);
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ id: 'same-committed-result' }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture port');
        const { provider, invalidateCalls } = fakeTokenProvider(['synthetic-token']);
        const client = createRestClient(
          { baseURL: `http://127.0.0.1:${address.port}` },
          provider,
          instant,
        );
        const intent = { body: { storeId: 'synthetic-store' }, idempotencyKey: 'original-intent' };
        expect(
          await client.request<{ id: string }>('POST', '/v1/billing/checkout_sessions', intent),
        ).toEqual({ id: 'same-committed-result' });
        expect(invalidateCalls).toEqual([]);
        expect(keys).toEqual(['original-intent', 'original-intent']);
        expect(effects).toBe(1);
      } finally {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      }
    });
  }
});

describe('createRestClient retries', () => {
  function scripted(
    answers: Array<{ status: number; json?: unknown; headers?: Record<string, string> }>,
  ) {
    let index = 0;
    return createMockFetch(() => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer ?? { status: 500 };
    });
  }
  const error = (type: string, code?: string) => ({
    error: { type, message: `${type} happened`, request_id: 'req_1', ...(code ? { code } : {}) },
  });

  test('retries 5xx, 429 and an in-flight 409 under ONE idempotency key', async () => {
    const { fetch: fetchImpl, requests } = scripted([
      { status: 503, json: error('api_error') },
      { status: 429, json: error('rate_limit_error', 'rate_limited') },
      { status: 409, json: error('idempotency_error', 'idempotency_error') },
      { status: 200, json: { id: 'pi_1' } },
    ]);
    const delays: number[] = [];
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL, maxNetworkRetries: 3 }, provider, {
      fetch: fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1,
    });

    expect(await client.request('POST', '/v1/payment_intents', { body: {} })).toEqual({
      id: 'pi_1',
    });
    expect(requests).toHaveLength(4);
    const keys = new Set(requests.map((r) => r.headers.get('Idempotency-Key')));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[0-9a-f-]{36}$/);
    // Exponential: 500, 1000, 2000 ms (the jitter source pinned to its top).
    expect(delays).toEqual([500, 1000, 2000]);
  });

  test('honours Retry-After when it is longer than the backoff, capped at 60 s', async () => {
    const { fetch: fetchImpl } = scripted([
      { status: 429, json: error('rate_limit_error'), headers: { 'Retry-After': '3' } },
      { status: 429, json: error('rate_limit_error'), headers: { 'Retry-After': '3600' } },
      { status: 200, json: { ok: true } },
    ]);
    const delays: number[] = [];
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, {
      fetch: fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    });
    await client.request('GET', '/v1/balance');
    expect(delays).toEqual([3000, 60_000]);
  });

  test('never retries another 4xx', async () => {
    for (const [status, body, ErrorClass] of [
      [400, error('invalid_request_error', 'parameter_invalid'), PeableInvalidRequestError],
      [400, error('idempotency_error', 'idempotency_error'), PeableIdempotencyError],
      [404, error('invalid_request_error', 'resource_missing'), PeableInvalidRequestError],
      [409, error('invalid_request_error', 'resource_conflict'), PeableInvalidRequestError],
    ] as const) {
      const { fetch: fetchImpl, requests } = scripted([{ status, json: body }]);
      const { provider } = fakeTokenProvider(['tok_1']);
      const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, {
        fetch: fetchImpl,
        ...instant,
      });
      await expect(client.request('POST', '/v1/customers', { body: {} })).rejects.toBeInstanceOf(
        ErrorClass,
      );
      expect(requests).toHaveLength(1);
    }
  });

  test('maxNetworkRetries applies per client and per request; the last error is thrown', async () => {
    const { fetch: fetchImpl, requests } = scripted([
      { status: 429, json: error('rate_limit_error') },
    ]);
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL, maxNetworkRetries: 0 }, provider, {
      fetch: fetchImpl,
      ...instant,
    });
    await expect(client.request('GET', '/v1/balance')).rejects.toBeInstanceOf(PeableRateLimitError);
    expect(requests).toHaveLength(1);
    await expect(
      client.request('GET', '/v1/balance', { maxNetworkRetries: 4 }),
    ).rejects.toMatchObject({ statusCode: 429, requestId: 'req_1' });
    expect(requests).toHaveLength(6);
  });

  test('a per-request timeout is a retried PeableConnectionError with code timeout', async () => {
    let attempts = 0;
    const hanging = ((_url: string, init?: RequestInit) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL, maxNetworkRetries: 1 }, provider, {
      fetch: hanging,
      ...instant,
    });
    await expect(client.request('GET', '/v1/balance', { timeout: 10 })).rejects.toMatchObject({
      name: 'PeableConnectionError',
      code: 'timeout',
    });
    expect(attempts).toBe(2);
  });

  test("a caller's abort ends the call at once, with the caller's reason", async () => {
    const controller = new AbortController();
    const { fetch: fetchImpl, requests } = scripted([{ status: 503, json: error('api_error') }]);
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, {
      fetch: fetchImpl,
      sleep: async () => {
        controller.abort(new Error('caller gave up'));
        throw controller.signal.reason;
      },
    });
    await expect(
      client.request('GET', '/v1/balance', { signal: controller.signal }),
    ).rejects.toThrow('caller gave up');
    expect(requests).toHaveLength(1);
  });
});

describe('createRestClient headers', () => {
  test('sends Peable-Version: the contracts wire date by default, or the one asked for', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 200, json: {} }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient({ baseURL: TEST_GATEWAY_URL }, provider, { fetch: fetchImpl });
    await client.request('GET', '/v1/customers');
    await client.request('GET', '/v1/customers', { apiVersion: PEABLE_API_VERSION });
    expect(requests.map((r) => r.headers.get('Peable-Version'))).toEqual([
      PEABLE_API_VERSION,
      PEABLE_API_VERSION,
    ]);
  });

  test("the client's peableAccount goes only to routes that accept it; a request's own wins", async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({ status: 200, json: {} }));
    const { provider } = fakeTokenProvider(['tok_1']);
    const client = createRestClient(
      { baseURL: TEST_GATEWAY_URL, peableAccount: 'ca_default' },
      provider,
      { fetch: fetchImpl },
    );
    await client.request('GET', '/v1/balance', { acceptsPeableAccount: true });
    await client.request('GET', '/v1/customers');
    await client.request('GET', '/v1/balance', {
      acceptsPeableAccount: true,
      peableAccount: 'ca_other',
    });
    expect(requests.map((r) => r.headers.get('Peable-Account'))).toEqual([
      'ca_default',
      null,
      'ca_other',
    ]);
  });
});
