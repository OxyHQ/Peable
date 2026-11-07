import { describe, expect, test } from 'bun:test';
import {
  asWalletKeyError,
  isIdentityUnavailable,
  WalletKeyUnavailableError,
} from './identity-unavailable';

const named = (name: string): Error => Object.assign(new Error(name), { name });

describe('isIdentityUnavailable', () => {
  test('core\'s two "cannot tell now" errors, by name (two bundled copies of core never share a class)', () => {
    expect(isIdentityUnavailable(named('IdentityUnavailableError'))).toBe(true);
    expect(isIdentityUnavailable(named('RetiredKeyRingUnreadableError'))).toBe(true);
  });

  test('anything else is not', () => {
    expect(isIdentityUnavailable(new Error('boom'))).toBe(false);
    expect(isIdentityUnavailable(named('IdentityPersistError'))).toBe(false);
    expect(isIdentityUnavailable('IdentityUnavailableError')).toBe(false);
    expect(isIdentityUnavailable(null)).toBe(false);
  });
});

describe('asWalletKeyError', () => {
  test('wraps core\'s error with a "try again" message, keeping its name and cause', () => {
    const core = named('IdentityUnavailableError');
    const wrapped = asWalletKeyError(core);
    expect(wrapped).toBeInstanceOf(WalletKeyUnavailableError);
    expect(isIdentityUnavailable(wrapped)).toBe(true);
    expect((wrapped as Error).message).toMatch(/try again/i);
    expect((wrapped as Error).cause).toBe(core);
  });

  test('leaves any other error, and an already wrapped one, as it is', () => {
    const other = new Error('boom');
    expect(asWalletKeyError(other)).toBe(other);
    const wrapped = new WalletKeyUnavailableError();
    expect(asWalletKeyError(wrapped)).toBe(wrapped);
  });
});
