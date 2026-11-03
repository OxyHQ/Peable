// Shared fixtures for wiring a real `RestClient` (service-token provider +
// REST client, exactly what `Peable`'s constructor builds) against an
// injected fetch mock, so resource-level tests exercise the FULL path
// (resource → RestClient → fetch) instead of stubbing `RestClient` itself.

import { createRestClient, type GatewayClient } from '../../src/core/client';
import { createServiceTokenProvider } from '../../src/core/serviceToken';
import type { MockResponseSpec } from './mockFetch';

export const TEST_OXY_API_URL = 'https://api.oxy.test';
export const TEST_GATEWAY_URL = 'https://api.pay.oxy.test';
export const TEST_SERVICE_TOKEN = 'svc_test_token';
export const TEST_PUBLIC_KEY = 'oxy_dk_test';
export const TEST_SECRET = 'sk_test_secret';

export const SERVICE_TOKEN_MINT_URL = `${TEST_OXY_API_URL}/auth/service-token`;

export function serviceTokenMintResponse(
  overrides: Partial<{ token: string; expiresIn: number }> = {},
): MockResponseSpec {
  return {
    status: 200,
    json: {
      data: {
        token: overrides.token ?? TEST_SERVICE_TOKEN,
        expiresIn: overrides.expiresIn ?? 3600,
        appName: 'Test App',
      },
    },
  };
}

/** Build a `RestClient` wired exactly like `Peable`'s constructor, against the given fetch. */
export function buildTestClient(fetchImpl: typeof fetch): GatewayClient {
  const tokenProvider = createServiceTokenProvider(
    { publicKey: TEST_PUBLIC_KEY, secret: TEST_SECRET, oxyApiUrl: TEST_OXY_API_URL },
    { fetch: fetchImpl },
  );
  return createRestClient({ baseURL: TEST_GATEWAY_URL }, tokenProvider, { fetch: fetchImpl });
}
