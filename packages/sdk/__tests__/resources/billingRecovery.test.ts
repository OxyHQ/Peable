import { describe, expect, it } from 'bun:test';
import { createRestClient } from '../../src/core/client';
import { resources } from '../support/testGateway';
import type { BillingCheckoutOperationRecovery } from '@peable.to/shared-types';

const params = {
  idempotency_key: 'checkout:fixture',
  provider_customer_id: 'cus_fixture',
  provider_price_id: 'price_fixture',
  store_id: 'store:fixture',
  plan_id: 'plan:fixture',
};
const { idempotency_key: operationKey, ...operationQuery } = params;
const source = {
  ...params,
  merchant_id: 'merch_fixture',
  app_id: 'app_fixture',
  mode: 'test' as const,
  environment: 'development' as const,
  tax_quote_id: 'quote_fixture',
};
function resource(reply: unknown, status = 200) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return {
    calls,
    billing: resources(
      createRestClient(
        { baseURL: 'https://example.invalid' },
        {
          getToken: async () => 'synthetic-owner-token',
          invalidate() {},
        },
        { fetch: fakeFetch, sleep: async () => {} },
      ),
    ).billing,
  };
}

describe('checkout operation recovery official SDK transport', () => {
  it('uses authenticated GET with complete encoded identity and no create body/idempotency write header', async () => {
    const expected: BillingCheckoutOperationRecovery = {
      state: 'succeeded',
      source,
      checkout: { id: 'cs_test_fixture', expires_at: 1790812800 },
    };
    const fixture = resource(expected);
    expect(await fixture.billing.retrieveCheckoutOperation(operationKey, operationQuery)).toEqual(expected);
    expect(fixture.calls).toHaveLength(1);
    const request = fixture.calls[0];
    if (!request) throw new Error('Expected request');
    expect(request.url.pathname).toBe('/v1/billing/checkout_operations/checkout%3Afixture');
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      provider_customer_id: params.provider_customer_id,
      provider_price_id: params.provider_price_id,
      store_id: params.store_id,
      plan_id: params.plan_id,
    });
    expect(request.init.method).toBe('GET');
    expect(request.init.body).toBeUndefined();
    const headers = new Headers(request.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer synthetic-owner-token');
    expect(headers.has('Idempotency-Key')).toBe(false);
  });
  it('preserves absent/pending/indeterminate observations without cancellation or another write', async () => {
    for (const state of ['not_found', 'pending', 'indeterminate'] as const) {
      const fixture = resource({ state, source });
      expect((await fixture.billing.retrieveCheckoutOperation(operationKey, operationQuery)).state).toBe(state);
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls.every((call) => call.init.method === 'GET')).toBe(true);
    }
  });
  it('propagates provider uncertainty and foreign-owner failures with no fallback request', async () => {
    // A 404 is answered once; a 503 is the SAME read retried (the default
    // two retries), never another request.
    for (const [status, attempts] of [
      [404, 1],
      [503, 3],
    ] as const) {
      const fixture = resource({ error: { message: 'synthetic_recovery_unavailable' } }, status);
      await expect(fixture.billing.retrieveCheckoutOperation(operationKey, operationQuery)).rejects.toThrow();
      expect(fixture.calls).toHaveLength(attempts);
      expect(new Set(fixture.calls.map((call) => `${call.init.method} ${call.url}`)).size).toBe(1);
    }
  });
});
