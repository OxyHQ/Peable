/**
 * Tests for the send-screen address gate (review finding M3).
 *
 * The Send button used to enable on a prefix/length check ("starts with F/T,
 * >= 25 chars"), which let a checksum-broken or wrong-network address through —
 * sending to it would burn funds. The screen now gates on the full
 * `validateAddress` (base58check + network version byte). These tests prove the
 * exact cases the old check missed are now rejected.
 */

import { describe, test, expect } from 'bun:test';
import { validateAddress, getNetwork } from '@fairco.in/core';

const MAINNET = getNetwork('mainnet');
const TESTNET = getNetwork('testnet');

// A real, valid FairCoin mainnet P2PKH address.
const VALID_MAINNET = 'FQVANvQqVsLwkwBnAJ5oPDYrqcfXLak7Bf';

describe('M3: send address validation', () => {
  test('accepts a valid mainnet address', () => {
    expect(validateAddress(VALID_MAINNET, MAINNET)).toBe(true);
  });

  test('rejects a checksum-broken address that passes the old prefix check', () => {
    // Same prefix 'F' and length, last char flipped -> bad base58check checksum.
    const tampered = `${VALID_MAINNET.slice(0, -1)}X`;
    expect(tampered.startsWith('F')).toBe(true); // old gate would have allowed it
    expect(tampered.length).toBeGreaterThanOrEqual(25);
    expect(validateAddress(tampered, MAINNET)).toBe(false); // new gate rejects it
  });

  test('rejects a Bitcoin address (wrong network/version byte)', () => {
    const btc = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
    expect(validateAddress(btc, MAINNET)).toBe(false);
  });

  test('rejects a valid mainnet address when the wallet is on testnet', () => {
    // Cross-network sends are a real foot-gun; the version byte must match.
    expect(validateAddress(VALID_MAINNET, TESTNET)).toBe(false);
  });

  test('rejects empty and clearly-partial input without throwing', () => {
    expect(validateAddress('', MAINNET)).toBe(false);
    expect(validateAddress('F', MAINNET)).toBe(false);
    expect(validateAddress('garbage!!!', MAINNET)).toBe(false);
  });
});
