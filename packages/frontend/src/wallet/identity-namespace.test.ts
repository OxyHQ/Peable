/**
 * The one-time move of the pre-round-5 shared identity wallet to the account
 * it is proven to belong to (security review round 5, R5-2).
 */
import { describe, expect, test } from 'bun:test';
import { bytesToHex, getNetwork, hexToBytes } from '@fairco.in/core';
import { getPublicKey } from '@noble/secp256k1';
import { KeyManager } from '@peable.to/pay';
import {
  highestStoredIndices,
  keepsLegacyKey,
  legacyCheckFingerprint,
  legacyNamespaceClosed,
  legacyNamespaceStep,
  markLegacyChecked,
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
  const FP = legacyCheckFingerprint([KEY_A], []);

  test('moves once, to one account; removed or empty is closed for everyone', () => {
    expect(legacyNamespaceStep(parseLegacyNamespaceMarker(null), A, FP)).toBe('prove');
    expect(legacyNamespaceStep(parseLegacyNamespaceMarker('{"boundTo":"x"}'), A, FP)).toBe('skip');
    expect(legacyNamespaceStep(parseLegacyNamespaceMarker('{"empty":true}'), A, FP)).toBe('skip');
    expect(legacyNamespaceClosed(parseLegacyNamespaceMarker('{"removed":true}'))).toBe(true);
  });

  test('a definite failure is not asked again against the same keys (R6-6)', () => {
    const checked = markLegacyChecked({}, A, FP);
    const stored = parseLegacyNamespaceMarker(JSON.stringify(checked));
    expect(legacyNamespaceStep(stored, A, FP)).toBe('skip');
    expect(legacyNamespaceStep(stored, B, FP)).toBe('prove');
  });

  test('a new key in the history or the ring asks again (R6-6)', () => {
    const stored = markLegacyChecked({}, A, FP);
    expect(legacyNamespaceStep(stored, A, legacyCheckFingerprint([KEY_A, KEY_B], []))).toBe(
      'prove',
    );
    expect(legacyNamespaceStep(stored, A, legacyCheckFingerprint([KEY_A], [KEY_B]))).toBe('prove');
  });

  test('the fingerprint is canonical: encoding and order do not matter', () => {
    expect(legacyCheckFingerprint([KEY_B, KEY_A.toUpperCase()], [])).toBe(
      legacyCheckFingerprint([KEY_A, KEY_B], []),
    );
  });

  test("round 5's list of checked accounts is no check at all (it may not have been definite)", () => {
    const old = parseLegacyNamespaceMarker(JSON.stringify({ checked: [A] }));
    expect(legacyNamespaceStep(old, A, FP)).toBe('prove');
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

describe('highestStoredIndices', () => {
  test("covers every stored row of each chain, so the owner's tree derives them all (R6-2)", () => {
    expect(highestStoredIndices([])).toEqual({ external: -1, change: -1 });
    expect(
      highestStoredIndices([
        { index_num: 3, is_change: 0 },
        { index_num: 41, is_change: 0 },
        { index_num: 7, is_change: 1 },
      ]),
    ).toEqual({ external: 41, change: 7 });
  });
});

describe('keepsLegacyKey', () => {
  test("keeps the proving account's keys, drops everything else", () => {
    const history = new Set([KEY_A]);
    expect(keepsLegacyKey(KEY_A, history)).toBe(true);
    expect(keepsLegacyKey(KEY_A.toUpperCase(), history)).toBe(true);
    expect(keepsLegacyKey(KEY_B, history)).toBe(false);
    expect(keepsLegacyKey('not a key', history)).toBe(false);
  });
});
