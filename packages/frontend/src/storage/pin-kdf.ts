/**
 * PIN key-derivation and record format (review finding M2).
 *
 * A 6-digit PIN has only 10^6 possibilities, so the previous unsalted single
 * SHA-256 was trivially brute-forced from a leaked store via a precomputed
 * table. This module derives PIN hashes with scrypt — a memory-hard,
 * deliberately-slow KDF — using a per-record random salt, and defines a
 * versioned on-disk record so legacy PINs can be detected and migrated.
 *
 * Record format is self-describing (like PHC / modular-crypt hashes): the scrypt
 * cost parameters are stored IN the record, so `verifyPinRecord` always re-hashes
 * with the exact cost that produced the stored hash. That decouples the current
 * default cost from what's on disk — changing {@link SCRYPT_PARAMS} never
 * invalidates an existing PIN; the record is simply re-costed on the next
 * successful unlock.
 *
 * Pure (no storage / React Native imports) so the security-critical logic is
 * directly unit-testable.
 */

import { sha256 } from '@noble/hashes/sha256';
import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes } from '@fairco.in/core';

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: number;
}

/**
 * Current scrypt cost. Calibrated for React Native's Hermes engine, where the
 * pure-JS scrypt is ~100x slower than a native implementation: `N=2^10` costs
 * ~1s per unlock on-device (and stays ~instant on desktop V8). The previous
 * `N=2^15` measured ~45s per unlock on Hermes — unusable.
 *
 * A 6-digit PIN's real protection is the hardware-backed SecureStore that holds
 * this record (Android Keystore / iOS Keychain) plus the app's failed-attempt
 * lockout; the scrypt cost is defense-in-depth only if that record ever leaked,
 * and for a 10^6 keyspace a very high `N` buys little. A moderate `N` is the
 * right balance. Because params are embedded per record, this value can be
 * retuned at any time without breaking stored PINs.
 */
const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 10, r: 8, p: 1, dkLen: 32 };

/**
 * Cost for records written before the params were embedded — the two-field
 * `scrypt$<saltHex>$<hashHex>` form. Those were all produced with `N=2^15`, so
 * they must be verified with it; a correct PIN then migrates the record to the
 * current {@link SCRYPT_PARAMS}.
 */
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };

const SCRYPT_SALT_BYTES = 16;

/**
 * Marks a salted-scrypt record. Current form embeds the cost:
 * `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`. The legacy form omits the cost:
 * `scrypt$<saltHex>$<hashHex>`.
 */
export const PIN_SCHEME_PREFIX = 'scrypt$';

/**
 * Legacy (v1) unsalted SHA-256 hash with a domain separator. Exported only so
 * `verifyPinRecord` can verify and then migrate PINs stored before scrypt.
 */
export function legacyHashPin(pin: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(`fairwallet:pin:${pin}`);
  return bytesToHex(sha256(data));
}

/** Cryptographically-random salt for a new PIN record. */
function generatePinSalt(): Uint8Array {
  const salt = new Uint8Array(SCRYPT_SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

/** Derive the scrypt hash of `pin` with `salt` under `params`, returned as hex. */
async function scryptHashPin(pin: string, salt: Uint8Array, params: ScryptParams): Promise<string> {
  const encoder = new TextEncoder();
  const derived = await scryptAsync(encoder.encode(pin), salt, params);
  return bytesToHex(derived);
}

/** Whether a stored record uses the salted-scrypt scheme. */
export function isScryptRecord(record: string): boolean {
  return record.startsWith(PIN_SCHEME_PREFIX);
}

/** Serialize a self-describing record: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`. */
function formatRecord(params: ScryptParams, salt: Uint8Array, hashHex: string): string {
  return `${PIN_SCHEME_PREFIX}${params.N}$${params.r}$${params.p}$${bytesToHex(salt)}$${hashHex}`;
}

/** Parse and validate embedded scrypt cost fields; null if malformed. */
function parseScryptParams(nStr: string, rStr: string, pStr: string): ScryptParams | null {
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  // N must be a power of two ≥ 2 (scrypt requirement); r, p positive integers.
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1) return null;
  if (!Number.isInteger(p) || p < 1) return null;
  return { N, r, p, dkLen: SCRYPT_PARAMS.dkLen };
}

function sameParams(a: ScryptParams, b: ScryptParams): boolean {
  return a.N === b.N && a.r === b.r && a.p === b.p && a.dkLen === b.dkLen;
}

/**
 * Build a fresh salted-scrypt record for `pin` using the current cost. Each call
 * uses a new random salt, so two wallets with the same PIN store different hashes.
 */
export async function buildPinRecord(pin: string): Promise<string> {
  const salt = generatePinSalt();
  const hashHex = await scryptHashPin(pin, salt, SCRYPT_PARAMS);
  return formatRecord(SCRYPT_PARAMS, salt, hashHex);
}

/** Constant-time string comparison to avoid timing leaks on PIN verification. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export interface PinVerifyResult {
  /** Whether the supplied PIN matched the stored record. */
  readonly valid: boolean;
  /**
   * A new record to persist (the matched record used a legacy scheme or a stale
   * cost and should be re-stored under the current {@link SCRYPT_PARAMS}), or
   * null when no migration is needed.
   */
  readonly upgradedRecord: string | null;
}

/**
 * Verify `pin` against a stored `record`. Handles three schemes, oldest-first:
 * the current self-describing scrypt record, the legacy fixed-cost scrypt record
 * (`scrypt$<salt>$<hash>`, cost `N=2^15`), and the pre-scrypt unsalted SHA-256.
 * Whenever a match uses anything other than the current cost, an `upgradedRecord`
 * is returned so the caller can transparently re-store the PIN under the current
 * parameters — so a slow or weak record never survives the next unlock.
 */
export async function verifyPinRecord(pin: string, record: string): Promise<PinVerifyResult> {
  if (isScryptRecord(record)) {
    const parts = record.slice(PIN_SCHEME_PREFIX.length).split('$');

    // Current self-describing form: N$r$p$salt$hash.
    if (parts.length === 5) {
      const params = parseScryptParams(parts[0], parts[1], parts[2]);
      if (!params) return { valid: false, upgradedRecord: null };
      let salt: Uint8Array;
      try {
        salt = hexToBytes(parts[3]);
      } catch {
        return { valid: false, upgradedRecord: null };
      }
      const candidate = await scryptHashPin(pin, salt, params);
      const valid = constantTimeEqual(candidate, parts[4]);
      // Re-cost if the record's params differ from the current target, so a
      // retune (or a legacy over-cost read via the branch below) migrates on
      // the next successful unlock.
      const upgradedRecord =
        valid && !sameParams(params, SCRYPT_PARAMS) ? await buildPinRecord(pin) : null;
      return { valid, upgradedRecord };
    }

    // Legacy fixed-cost form (no embedded params): salt$hash, produced at N=2^15.
    if (parts.length === 2) {
      let salt: Uint8Array;
      try {
        salt = hexToBytes(parts[0]);
      } catch {
        return { valid: false, upgradedRecord: null };
      }
      const candidate = await scryptHashPin(pin, salt, LEGACY_SCRYPT_PARAMS);
      const valid = constantTimeEqual(candidate, parts[1]);
      return {
        valid,
        upgradedRecord: valid ? await buildPinRecord(pin) : null,
      };
    }

    return { valid: false, upgradedRecord: null };
  }

  // Legacy unsalted SHA-256 record.
  const valid = constantTimeEqual(record, legacyHashPin(pin));
  if (!valid) {
    return { valid: false, upgradedRecord: null };
  }
  return { valid: true, upgradedRecord: await buildPinRecord(pin) };
}
