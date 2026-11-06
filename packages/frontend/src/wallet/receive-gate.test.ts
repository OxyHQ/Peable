/** One receive gate for every surface that shows an address (R6-1, R6-4). */
import { describe, expect, test } from 'bun:test';
import { receiveGate } from './receive-gate';

const base = {
  identityReceiveConfirmed: false,
  socialReceiveKeyMismatch: false,
  adoptedWalletUnconfirmed: false,
};

describe('receiveGate', () => {
  test('an identity wallet opens only once the gateway confirmed its key', () => {
    expect(receiveGate({ ...base, activeWalletId: 'oxy-user-abc' }).kind).toBe('unconfirmed');
    expect(
      receiveGate({ ...base, activeWalletId: 'oxy-org-abc', identityReceiveConfirmed: true }).kind,
    ).toBe('open');
    expect(
      receiveGate({ ...base, activeWalletId: 'oxy-user-abc', socialReceiveKeyMismatch: true }).kind,
    ).toBe('mismatch');
  });

  test('a wallet adopted from the shared keychain group waits for the person', () => {
    expect(
      receiveGate({ ...base, activeWalletId: 'w1', adoptedWalletUnconfirmed: true }).kind,
    ).toBe('adopted');
    expect(receiveGate({ ...base, activeWalletId: 'w1' }).kind).toBe('open');
  });
});
