import { describe, expect, test } from 'bun:test';
import type { ServiceTokenProvider } from '../../src/core/serviceToken';
import { PEABLE_API_VERSION } from '@peable.to/contracts/vocabulary';
import {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_MAX_NETWORK_RETRIES,
  DEFAULT_OXY_API_URL,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
} from '../../src/core/config';

describe('resolveConfig', () => {
  test('applies default baseURL and oxyApiUrl when omitted', () => {
    const resolved = resolveConfig({ publicKey: 'oxy_dk_x', secret: 'sk_x' });
    expect(resolved.baseURL).toBe(DEFAULT_GATEWAY_BASE_URL);
    expect(resolved.oxyApiUrl).toBe(DEFAULT_OXY_API_URL);
    expect(resolved.publicKey).toBe('oxy_dk_x');
    expect(resolved.secret).toBe('sk_x');
  });

  test('strips a trailing slash from custom URLs', () => {
    const resolved = resolveConfig({
      publicKey: 'oxy_dk_x',
      secret: 'sk_x',
      baseURL: 'https://gateway.example.com/',
      oxyApiUrl: 'https://oxy.example.com/',
    });
    expect(resolved.baseURL).toBe('https://gateway.example.com');
    expect(resolved.oxyApiUrl).toBe('https://oxy.example.com');
  });

  test('throws when publicKey is missing', () => {
    expect(() => resolveConfig({ publicKey: '', secret: 'sk_x' })).toThrow(/publicKey/);
  });

  test('throws when secret is missing', () => {
    expect(() => resolveConfig({ publicKey: 'oxy_dk_x', secret: '' })).toThrow(/secret/);
  });
});

test('defaults: an 80 s timeout, 2 retries, the contracts wire date, no account', () => {
  const resolved = resolveConfig({ publicKey: 'fixture', secret: 'fixture' });
  expect(resolved.timeout).toBe(80_000);
  expect(resolved.timeout).toBe(DEFAULT_TIMEOUT_MS);
  expect(resolved.maxNetworkRetries).toBe(DEFAULT_MAX_NETWORK_RETRIES);
  expect(resolved.maxNetworkRetries).toBe(2);
  expect(resolved.apiVersion).toBe(PEABLE_API_VERSION);
  expect(resolved.peableAccount).toBeUndefined();
});

test('refuses an invalid timeout, retry count, api version or account', () => {
  for (const timeout of [0, -1, Infinity, NaN, 1.5, 2147483648]) {
    expect(() => resolveConfig({ publicKey: 'fixture', secret: 'fixture', timeout })).toThrow(
      /timeout/,
    );
  }
  for (const maxNetworkRetries of [-1, 1.5, NaN]) {
    expect(() =>
      resolveConfig({ publicKey: 'fixture', secret: 'fixture', maxNetworkRetries }),
    ).toThrow(/maxNetworkRetries/);
  }
  expect(() =>
    resolveConfig({
      publicKey: 'fixture',
      secret: 'fixture',
      apiVersion: '2020-01-01' as typeof PEABLE_API_VERSION,
    }),
  ).toThrow(/apiVersion/);
  expect(() =>
    resolveConfig({ publicKey: 'fixture', secret: 'fixture', peableAccount: '' }),
  ).toThrow(/peableAccount/);
  expect(
    resolveConfig({ publicKey: 'fixture', secret: 'fixture', maxNetworkRetries: 0, timeout: 5 }),
  ).toMatchObject({ maxNetworkRetries: 0, timeout: 5 });
});

describe('resolveConfig with a tokenProvider', () => {
  const tokenProvider: ServiceTokenProvider = {
    getToken: async () => 'token',
    invalidate: () => {},
  };

  test('accepts a tokenProvider alone and carries it through', () => {
    const resolved = resolveConfig({ tokenProvider, baseURL: 'https://gateway.example.com/' });
    expect(resolved.tokenProvider).toBe(tokenProvider);
    expect(resolved.publicKey).toBeUndefined();
    expect(resolved.secret).toBeUndefined();
    expect(resolved.baseURL).toBe('https://gateway.example.com');
  });

  test('rejects a tokenProvider passed with a credential', () => {
    const both = /either `tokenProvider` or `publicKey` \+ `secret`, not both/;
    // The types forbid every one of these; a JavaScript caller is not held to them.
    const loose = resolveConfig as (config: unknown) => unknown;
    expect(() => loose({ tokenProvider, publicKey: 'oxy_dk_x', secret: 'sk_x' })).toThrow(both);
    expect(() => loose({ tokenProvider, publicKey: 'oxy_dk_x' })).toThrow(both);
    expect(() => loose({ tokenProvider, secret: 'sk_x' })).toThrow(both);
    expect(() => loose({ tokenProvider, publicKey: '' })).toThrow(both);
  });

  test('rejects a config with neither a tokenProvider nor a credential', () => {
    const loose = resolveConfig as (config: unknown) => unknown;
    expect(() => loose({})).toThrow(/either `publicKey` \+ `secret` or a `tokenProvider`/);
    expect(() => loose({ baseURL: 'https://gateway.example.com' })).toThrow(/tokenProvider/);
  });

  test('rejects a tokenProvider without getToken() and invalidate()', () => {
    const loose = resolveConfig as (config: unknown) => unknown;
    for (const bad of [null, 'token', { getToken: async () => 'token' }, { invalidate() {} }]) {
      expect(() => loose({ tokenProvider: bad })).toThrow(/getToken\(\)` and `invalidate\(\)/);
    }
  });

  test('still validates timeout', () => {
    expect(() => resolveConfig({ tokenProvider, timeout: 0 })).toThrow(/timeout/);
  });
});
