import { describe, expect, it } from 'bun:test';
import { BillingResource } from '../../src/resources/billing';
import { createRestClient } from '../../src/core/client';
import type { BillingCheckoutOperationRecovery } from '@peable.to/shared-types';

const params = {
  idempotencyKey: 'checkout:fixture',
  providerCustomerId: 'cus_fixture',
  providerPriceId: 'price_fixture',
  storeId: 'store:fixture',
  planId: 'plan:fixture',
};
const source = {
  ...params,
  merchantId: 'merch_fixture',
  appId: 'app_fixture',
  mode: 'test' as const,
  environment: 'development' as const,
  taxQuoteId: 'quote_fixture',
};
function resource(reply: unknown, status = 200) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return {
    calls,
    billing: new BillingResource(
      createRestClient(
        { baseURL: 'https://example.invalid' },
        {
          getToken: async () => 'synthetic-owner-token',
          invalidate() {},
        },
        { fetch: fakeFetch },
      ),
    ),
  };
}

describe('checkout operation recovery official SDK transport', () => {
  it('uses authenticated GET with complete encoded identity and no create body/idempotency write header', async () => {
    const expected: BillingCheckoutOperationRecovery = {
      state: 'succeeded',
      source,
      checkout: { id: 'cs_test_fixture', expiresAt: '2026-10-01T00:00:00Z' },
    };
    const fixture = resource(expected);
    expect(await fixture.billing.retrieveCheckoutOperation(params)).toEqual(expected);
    expect(fixture.calls).toHaveLength(1);
    const request = fixture.calls[0];
    if (!request) throw new Error('Expected request');
    expect(request.url.pathname).toBe('/v1/billing/checkout_operations/checkout%3Afixture');
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      providerCustomerId: params.providerCustomerId,
      providerPriceId: params.providerPriceId,
      storeId: params.storeId,
      planId: params.planId,
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
      expect((await fixture.billing.retrieveCheckoutOperation(params)).state).toBe(state);
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls.every((call) => call.init.method === 'GET')).toBe(true);
    }
  });
  it('propagates provider uncertainty and foreign-owner failures with no fallback request', async () => {
    for (const status of [404, 503]) {
      const fixture = resource({ error: { message: 'synthetic_recovery_unavailable' } }, status);
      await expect(fixture.billing.retrieveCheckoutOperation(params)).rejects.toThrow();
      expect(fixture.calls).toHaveLength(1);
    }
  });
});
