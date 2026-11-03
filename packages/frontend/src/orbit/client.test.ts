import type { AuthenticatedResponseRequest } from '@oxy.so/core';
import { expect, it, mock } from 'bun:test';
import {
  createOrbitReader,
  orbitAmount,
  orbitKey,
  orbitPath,
  OrbitReadError,
  type OrbitScope,
} from './client';
const scope: OrbitScope = { applicationId: 'app/a', environment: 'development' };
it('uses authenticated read transport with explicit application/environment and encoded pagination', async () => {
  const request = mock(async (_request: AuthenticatedResponseRequest) =>
    Response.json({ object: 'list', data: [], has_more: true }),
  );
  const reader = createOrbitReader({ requestAuthenticatedResponse: request });
  expect(await reader.payments(scope, 'pi_next?environment=production')).toEqual({
    data: [],
    hasMore: true,
  });
  const call = request.mock.calls[0]?.[0] as { method: string; url: string } | undefined;
  expect(call?.method).toBe('GET');
  const url = new URL(call?.url ?? '', 'https://example.test');
  expect(url.pathname).toBe('/v1/dashboard/applications/app%2Fa/payment_intents');
  expect(url.searchParams.getAll('environment')).toEqual(['development']);
  expect(url.searchParams.get('starting_after')).toBe('pi_next?environment=production');
});
it('keeps authorization errors distinct from empty records and rejects malformed envelopes', async () => {
  const request = mock(async (_request: AuthenticatedResponseRequest) =>
    Response.json({}, { status: 403 }),
  );
  const reader = createOrbitReader({ requestAuthenticatedResponse: request });
  await expect(reader.payments(scope)).rejects.toBeInstanceOf(OrbitReadError);
  request.mockResolvedValueOnce(Response.json({ data: [] }));
  await expect(reader.deliveries(scope)).rejects.toThrow('Invalid Orbit list response');
});
it('never retains payer secrets or merchant watch-only keys in view models', async () => {
  const request = mock(async (_request: AuthenticatedResponseRequest) =>
    Response.json({
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'pi_one',
          amount: '599',
          currency: 'USD',
          clientSecret: 'secret-not-for-ui',
          metadata: { private: 'ignored' },
        },
      ],
    }),
  );
  const reader = createOrbitReader({ requestAuthenticatedResponse: request });
  expect(JSON.stringify(await reader.payments(scope))).not.toContain('secret-not-for-ui');
  expect(JSON.stringify(await reader.payments(scope))).not.toContain('metadata');
  request.mockResolvedValueOnce(
    Response.json({
      object: 'merchant',
      id: 'merch_one',
      oxyAppId: scope.applicationId,
      environment: scope.environment,
      xpub: 'watch-only-not-for-ui',
    }),
  );
  expect(JSON.stringify(await reader.merchant(scope))).not.toContain('watch-only-not-for-ui');
});
it('fails closed on mismatched merchant scope and payment identity', async () => {
  const request = mock(async (_request: AuthenticatedResponseRequest) =>
    Response.json({ object: 'merchant', oxyAppId: scope.applicationId, environment: 'production' }),
  );
  const reader = createOrbitReader({ requestAuthenticatedResponse: request });
  await expect(reader.merchant(scope)).rejects.toThrow('scope mismatch');
  request.mockResolvedValueOnce(Response.json({ object: 'payment_intent', id: 'pi_other' }));
  await expect(reader.payment(scope, 'pi_expected')).rejects.toThrow('identity mismatch');
  expect(() => orbitPath({ ...scope, applicationId: '' }, 'merchant')).toThrow();
});
it('separates viewer, organization, application and environment cache identities', () => {
  const original = orbitKey('viewer-a', 'org-a', scope);
  for (const changed of [
    orbitKey('viewer-b', 'org-a', scope),
    orbitKey('viewer-a', 'org-b', scope),
    orbitKey('viewer-a', 'org-a', { ...scope, applicationId: 'app-b' }),
    orbitKey('viewer-a', 'org-a', { ...scope, environment: 'production' }),
  ])
    expect(changed).not.toEqual(original);
});
it('formats exact smallest units without losing FairCoin precision or assuming cents', () => {
  expect(orbitAmount('599', 'USD')).toBe('5.99 USD');
  expect(orbitAmount('599', 'JPY')).toBe('599 JPY');
  expect(orbitAmount('1', 'FAIR')).toBe('0.00000001 FAIR');
  expect(orbitAmount('99999999999999999', 'FAIR')).toBe('999999999.99999999 FAIR');
});
