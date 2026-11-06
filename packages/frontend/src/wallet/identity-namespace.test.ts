/**
 * The one-time move of the pre-round-5 shared identity wallet to the account
 * it is proven to belong to (security review round 5, R5-2).
 */
import { describe, expect, test } from 'bun:test';
import { bytesToHex, getNetwork, hexToBytes } from '@fairco.in/core';
import { getPublicKey } from '@noble/secp256k1';
import { KeyManager } from '@peable.to/pay';
import {
  keepsLegacyKey,
  legacyNamespaceStep,
  parseLegacyNamespaceMarker,
  proveLegacyOwnership,
} from './identity-namespace';

const A = '0123456789abcdef01234567';
const B = '76543210fedcba9876543210';
const KEY_A = bytesToHex(getPublicKey(hexToBytes('11'.repeat(32)), true));
const KEY_B = bytesToHex(getPublicKey(hexToBytes('22'.repeat(32)), true));
const tree = (fill: number): string[] => {
  const km = KeyManager.fromSeed(new Uint8Array(32).fill(fill), getNetwork('testnet'));
  return [...km.getExternalAddresses(), ...km.getChangeAddresses()];
};

describe('the legacy namespace marker', () => {
  test('moves once, to one account; an account that failed does not retry', () => {
    expect(legacyNamespaceStep(parseLegacyNamespaceMarker(null), A)).toBe('prove');
    expect(legacyNamespaceStep(parseLegacyNamespaceMarker('{"boundTo":"x"}'), A)).toBe('skip');
    expect(legacyNamespaceStep(parseLegacyNamespaceMarker('{"empty":true}'), A)).toBe('skip');
    const checked = parseLegacyNamespaceMarker(JSON.stringify({ checked: [A] }));
    expect(legacyNamespaceStep(checked, A)).toBe('skip');
    expect(legacyNamespaceStep(checked, B)).toBe('prove');
  });

  test('an unreadable marker is no marker', () => {
    expect(parseLegacyNamespaceMarker('not json')).toEqual({});
    expect(parseLegacyNamespaceMarker('{"boundTo":""}')).toEqual({});
  });
});

describe('proveLegacyOwnership', () => {
  // The legacy database stores the HD addresses its seed derived: account A's.
  const legacy = new Set(tree(1).slice(0, 3));

  test('the account whose key derived the stored addresses owns it', () => {
    expect(
      proveLegacyOwnership(legacy, [
        { key: KEY_B, addresses: tree(2) },
        { key: KEY_A, addresses: tree(1) },
      ]),
    ).toBe(KEY_A);
  });

  test('another account, whatever keys it holds, does not', () => {
    expect(proveLegacyOwnership(legacy, [{ key: KEY_B, addresses: tree(2) }])).toBeNull();
    expect(proveLegacyOwnership(legacy, [])).toBeNull();
  });
});

describe('keepsLegacyKey', () => {
  test("keeps the proving account's keys and keyless rows, drops everything else", () => {
    const history = new Set([KEY_A]);
    expect(keepsLegacyKey(KEY_A, history)).toBe(true);
    expect(keepsLegacyKey(KEY_A.toUpperCase(), history)).toBe(true);
    expect(keepsLegacyKey(null, history)).toBe(true);
    expect(keepsLegacyKey(KEY_B, history)).toBe(false);
    expect(keepsLegacyKey('not a key', history)).toBe(false);
  });
});
