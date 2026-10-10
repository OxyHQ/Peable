import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createServiceTokenProvider } from '../../src/core/serviceToken';
import { PeableApiError, PeableAuthenticationError } from '../../src/core/errors';
import { createMockFetch } from '../support/mockFetch';
import {
  SERVICE_TOKEN_MINT_URL,
  TEST_OXY_API_URL,
  TEST_PUBLIC_KEY,
  TEST_SECRET,
} from '../support/testGateway';

afterEach(() => {
  setSystemTime();
});

describe('createServiceTokenProvider', () => {
  test('mints a token via POST {oxyApiUrl}/auth/service-token with {apiKey, apiSecret}', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { data: { token: 'svc_abc', expiresIn: 3600, appName: 'Test App' } },
    }));
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    const token = await provider.getToken();

    expect(token).toBe('svc_abc');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(SERVICE_TOKEN_MINT_URL);
    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      apiKey: TEST_PUBLIC_KEY,
      apiSecret: TEST_SECRET,
    });
  });

  test('caches the token — a second getToken() before expiry does not re-mint', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { data: { token: 'svc_abc', expiresIn: 3600 } },
    }));
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    await provider.getToken();
    await provider.getToken();

    expect(requests).toHaveLength(1);
  });

  test('concurrent getToken() calls dedupe into a single in-flight mint', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { data: { token: 'svc_abc', expiresIn: 3600 } },
    }));
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);

    expect(a).toBe('svc_abc');
    expect(b).toBe('svc_abc');
    expect(requests).toHaveLength(1);
  });

  test('re-mints proactively once the cached token is within the refresh margin of expiry', async () => {
    let mintCount = 0;
    const { fetch: fetchImpl } = createMockFetch(() => {
      mintCount += 1;
      return { status: 200, json: { data: { token: `svc_${mintCount}`, expiresIn: 3600 } } };
    });
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = await provider.getToken();
    expect(first).toBe('svc_1');

    // Jump to 1 second before expiry — well inside the 60s refresh margin.
    setSystemTime(new Date('2026-01-01T00:59:59Z'));
    const second = await provider.getToken();

    expect(second).toBe('svc_2');
    expect(mintCount).toBe(2);
  });

  test('invalidate() forces the next getToken() to re-mint', async () => {
    let mintCount = 0;
    const { fetch: fetchImpl } = createMockFetch(() => {
      mintCount += 1;
      return { status: 200, json: { data: { token: `svc_${mintCount}`, expiresIn: 3600 } } };
    });
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    await provider.getToken();
    provider.invalidate();
    const second = await provider.getToken();

    expect(second).toBe('svc_2');
    expect(mintCount).toBe(2);
  });

  test('maps a non-2xx mint response (flat oxy-api envelope) to a typed PeableError', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 401,
      json: { error: 'UNAUTHORIZED', message: 'Invalid credentials' },
    }));
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    await expect(provider.getToken()).rejects.toBeInstanceOf(PeableAuthenticationError);
  });

  test('throws PeableApiError when the mint response data envelope is missing token/expiresIn', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 200,
      json: { data: { appName: 'x' } },
    }));
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    await expect(provider.getToken()).rejects.toBeInstanceOf(PeableApiError);
  });

  test('throws PeableApiError when the mint response has no `data` envelope at all', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 200,
      json: { token: 'svc_abc', expiresIn: 3600 },
    }));
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: fetchImpl },
    );

    await expect(provider.getToken()).rejects.toBeInstanceOf(PeableApiError);
  });

  test('wraps a network-level fetch failure as PeableApiError', async () => {
    const failingFetch = (() =>
      Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const provider = createServiceTokenProvider(
      { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
      { fetch: failingFetch },
    );

    await expect(provider.getToken()).rejects.toBeInstanceOf(PeableApiError);
  });
});
