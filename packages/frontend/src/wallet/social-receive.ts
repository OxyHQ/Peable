/**
 * Peable's on-device half of the social-receive scheme (design spec §4.3).
 * Reads the raw identity private key from `@oxy.so/core`'s EXISTING
 * `KeyManager.getSharedPrivateKey()`/`getPrivateKey()` — no `@oxy.so/core`
 * change needed; this mirrors `deriveIdentitySeed`'s own key-source priority
 * (shared ecosystem identity first, then this device's primary identity) but
 * SKIPS the HKDF step: the social-receive branch is, by design, the ONE
 * place the raw identity key is reused directly for money (spec §4.3's
 * key-separation note) — every other on-device use goes through
 * `deriveIdentitySeed`/`deriveScopedSeed`'s domain-separated HKDF instead.
 * Calls the published `@fairco.in/core` derivation primitives
 * (`deriveSocialReceiveAddress`, `deriveSocialReceiveSpendingKey`,
 * `publicKeyFromPrivateKey`) — generic secp256k1 crypto with no Oxy
 * dependency; this file is the ONLY place in the app that supplies it with
 * Oxy-identity-sourced key material. Also owns the gap-limit-extension math
 * as a pure function, kept here (not in `wallet-store.ts`) so it stays
 * directly unit-testable without any SQLite or SPV setup.
 */
import {
  hexToBytes,
  deriveSocialReceiveAddress,
  deriveSocialReceiveSpendingKey,
  publicKeyFromPrivateKey,
} from "@fairco.in/core";
import type { NetworkConfig } from "@fairco.in/core";
import { KeyManager as IdentityKeyManager } from "@oxy.so/core";

/**
 * How many unused social-receive addresses stay watched beyond the highest
 * USED index — mirrors the FairCoin BIP44 external-chain gap limit
 * (`EXTERNAL_GAP_LIMIT` in `key-manager.ts`).
 */
export const SOCIAL_RECEIVE_GAP_LIMIT = 20;

/**
 * Lowercase + left-pad to 64 hex chars. Mirrors `@oxy.so/core`'s internal
 * `KeyManager.canonicalPrivateKey` (private to that package, not exported) —
 * tolerates the 1-in-256 leading-zero-strip `elliptic`'s `getPrivate('hex')`
 * produces and legacy uppercase-stored keys. Every raw private-key hex
 * string read from `KeyManager` MUST be normalized this way before
 * hex-decoding, or a short/uppercase key silently decodes to the WRONG 32
 * bytes and the derived social-receive branch diverges from what the SAME
 * identity's PUBLIC path (backend/payer) computes.
 */
function canonicalizePrivateKeyHex(hex: string): string {
  return hex.toLowerCase().padStart(64, "0");
}

/**
 * The on-device identity's RAW private key bytes for the social-receive
 * branch ONLY (spec §4.3's key-separation note). `null` on web or a keyless
 * account — both `KeyManager` getters already return `null` in those cases,
 * so no extra platform check is needed here.
 */
export async function getIdentityPrivateKeyBytes(): Promise<Uint8Array | null> {
  const hex =
    (await IdentityKeyManager.getSharedPrivateKey()) ??
    (await IdentityKeyManager.getPrivateKey());
  if (!hex) {
    return null;
  }
  return hexToBytes(canonicalizePrivateKeyHex(hex));
}

/**
 * Compute `count` consecutive social-receive addresses starting at `start`,
 * from the identity PRIVATE key (native-only; the recipient's own device).
 * Address 0 is always the caller's stable default/favourite address.
 */
export function deriveSocialReceiveWatchWindow(
  identityPrivateKey: Uint8Array,
  start: number,
  count: number,
  network: NetworkConfig,
): { index: number; address: string }[] {
  const identityPublicKey = publicKeyFromPrivateKey(identityPrivateKey);
  const window: { index: number; address: string }[] = [];
  for (let i = start; i < start + count; i++) {
    window.push({
      index: i,
      address: deriveSocialReceiveAddress(identityPublicKey, i, network),
    });
  }
  return window;
}

/** The spending private key for social-receive child `index` (recipient only). */
export function getSocialReceiveSpendingKey(
  identityPrivateKey: Uint8Array,
  index: number,
): Uint8Array {
  return deriveSocialReceiveSpendingKey(identityPrivateKey, index);
}

/**
 * Decide whether the persisted, watched social-receive window needs to grow,
 * and if so, which NEW indices to derive — pure, no I/O. Called after
 * persisting a newly-used address; the caller derives + persists whatever
 * this returns and refreshes the Bloom filter if it returns non-null.
 *
 * @param highestWatchedIndex The highest index currently derived+persisted,
 *   or -1 if none yet.
 * @param highestUsedIndex The highest index a real payment has landed on, or
 *   -1 if none yet.
 * @param gapLimit {@link SOCIAL_RECEIVE_GAP_LIMIT} in production; injectable
 *   for tests.
 */
export function computeWindowExtension(
  highestWatchedIndex: number,
  highestUsedIndex: number,
  gapLimit: number,
): { start: number; count: number } | null {
  const target = highestUsedIndex + gapLimit;
  if (target <= highestWatchedIndex) {
    return null;
  }
  return { start: highestWatchedIndex + 1, count: target - highestWatchedIndex };
}
