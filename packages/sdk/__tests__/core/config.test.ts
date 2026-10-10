import { describe, expect, test } from 'bun:test';
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
