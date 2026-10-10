/**
 * Tests for PIN key derivation and migration (review finding M2).
 *
 * Prove that: a PIN round-trips through the salted-scrypt record; a wrong PIN
 * is rejected; each record uses a fresh random salt (so two wallets with the
 * same PIN have different stored hashes); and a legacy unsalted SHA-256 record
 * still verifies AND yields a scrypt upgrade so the weak hash is replaced.
 */

import { describe, test, expect } from 'bun:test';
import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex } from '@fairco.in/core';
import {
  buildPinRecord,
  verifyPinRecord,
  legacyHashPin,
  isScryptRecord,
  PIN_SCHEME_PREFIX,
} from './pin-kdf';

const PIN = '135790';
const WRONG = '000000';

/** Reproduce a pre-embedding record: `scrypt$<salt>$<hash>` at the old N=2^15. */
async function buildLegacyScryptRecord(pin: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = bytesToHex(
    await scryptAsync(new TextEncoder().encode(pin), salt, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32,
    }),
  );
  return `${PIN_SCHEME_PREFIX}${bytesToHex(salt)}$${hash}`;
}

describe('M2: salted-scrypt PIN records', () => {
  test('a correct PIN verifies against its scrypt record', async () => {
    const record = await buildPinRecord(PIN);
    expect(isScryptRecord(record)).toBe(true);
    const { valid } = await verifyPinRecord(PIN, record);
    expect(valid).toBe(true);
  });

  test('a wrong PIN is rejected', async () => {
    const record = await buildPinRecord(PIN);
    const { valid } = await verifyPinRecord(WRONG, record);
    expect(valid).toBe(false);
  });

  test('the record is NOT the old unsalted SHA-256 of the PIN', async () => {
    const record = await buildPinRecord(PIN);
    // The whole point of M2: the stored value must not be the trivially
    // table-able SHA-256 hash.
    expect(record).not.toContain(legacyHashPin(PIN));
  });

  test('two records for the same PIN differ (per-record random salt)', async () => {
    const a = await buildPinRecord(PIN);
    const b = await buildPinRecord(PIN);
    expect(a).not.toBe(b);
    // Both still verify the same PIN.
    expect((await verifyPinRecord(PIN, a)).valid).toBe(true);
    expect((await verifyPinRecord(PIN, b)).valid).toBe(true);
  });

  test('a malformed scrypt record fails closed without throwing', async () => {
    const bad = `${PIN_SCHEME_PREFIX}nothex$deadbeef`;
    const { valid } = await verifyPinRecord(PIN, bad);
    expect(valid).toBe(false);
  });

  test('a new record embeds its scrypt cost params (self-describing)', async () => {
    const record = await buildPinRecord(PIN);
    // scrypt$<N>$<r>$<p>$<salt>$<hash> — six `$`-separated fields incl. prefix.
    const fields = record.split('$');
    expect(fields[0]).toBe('scrypt');
    expect(Number(fields[1])).toBeGreaterThan(1); // N (power of two)
    expect(Number(fields[2])).toBeGreaterThan(0); // r
    expect(Number(fields[3])).toBeGreaterThan(0); // p
    expect(fields.length).toBe(6);
  });
});

describe('scrypt cost migration (legacy fixed-cost → self-describing)', () => {
  test('a legacy N=2^15 record verifies and upgrades to the current cost', async () => {
    const legacy = await buildLegacyScryptRecord(PIN);
    // Two fields after the prefix: no embedded params.
    expect(legacy.split('$').length).toBe(3);

    const result = await verifyPinRecord(PIN, legacy);
    expect(result.valid).toBe(true);
    // The slow record must be re-costed to the current (fast) params.
    expect(result.upgradedRecord).not.toBeNull();
    const upgraded = result.upgradedRecord ?? '';
    expect(upgraded.split('$').length).toBe(6); // now self-describing

    // The upgraded record still verifies the same PIN and rejects a wrong one.
    expect((await verifyPinRecord(PIN, upgraded)).valid).toBe(true);
    expect((await verifyPinRecord(WRONG, upgraded)).valid).toBe(false);
    // A correct verify of the already-current record needs no further upgrade.
    expect((await verifyPinRecord(PIN, upgraded)).upgradedRecord).toBeNull();
  });

  test('a wrong PIN against a legacy fixed-cost record fails with no upgrade', async () => {
    const legacy = await buildLegacyScryptRecord(PIN);
    const result = await verifyPinRecord(WRONG, legacy);
    expect(result.valid).toBe(false);
    expect(result.upgradedRecord).toBeNull();
  });
});

describe('M2: legacy record verification + migration', () => {
  test('a legacy SHA-256 record verifies and yields a scrypt upgrade', async () => {
    const legacyRecord = legacyHashPin(PIN); // what the old savePin stored
    expect(isScryptRecord(legacyRecord)).toBe(false);

    const result = await verifyPinRecord(PIN, legacyRecord);
    expect(result.valid).toBe(true);
    // The caller must be told to replace the weak hash with a scrypt record.
    expect(result.upgradedRecord).not.toBeNull();
    expect(isScryptRecord(result.upgradedRecord ?? '')).toBe(true);

    // The upgraded record verifies the same PIN and rejects a wrong one.
    const upgraded = result.upgradedRecord ?? '';
    expect((await verifyPinRecord(PIN, upgraded)).valid).toBe(true);
    expect((await verifyPinRecord(WRONG, upgraded)).valid).toBe(false);
  });

  test('a wrong PIN against a legacy record fails with no upgrade', async () => {
    const legacyRecord = legacyHashPin(PIN);
    const result = await verifyPinRecord(WRONG, legacyRecord);
    expect(result.valid).toBe(false);
    expect(result.upgradedRecord).toBeNull();
  });
});
