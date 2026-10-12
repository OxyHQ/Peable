import { describe, expect, test } from 'bun:test';
import type { ServiceTokenProvider } from '../../src/core/serviceToken';
import {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_OXY_API_URL,
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

test('optional HTTP deadline preserves the existing default and refuses invalid explicit values', () => {
  expect(
    resolveConfig({ publicKey: 'fixture', secret: 'fixture' }).requestTimeoutMs,
  ).toBeUndefined();
  for (const requestTimeoutMs of [0, -1, Infinity, NaN, 1.5, 2147483648]) {
    expect(() =>
      resolveConfig({ publicKey: 'fixture', secret: 'fixture', requestTimeoutMs }),
    ).toThrow(/requestTimeoutMs/);
  }
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

  test('still validates requestTimeoutMs', () => {
    expect(() => resolveConfig({ tokenProvider, requestTimeoutMs: 0 })).toThrow(/requestTimeoutMs/);
  });
});
