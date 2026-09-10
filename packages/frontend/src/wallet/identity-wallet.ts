/**
 * Bridge from the Oxy self-sovereign identity to the single FairCoin wallet.
 *
 * The wallet seed is derived on-device from the Oxy identity key via
 * `@oxy.so/core`'s `KeyManager.deriveScopedSeed` (HKDF, domain-separated) — the
 * raw identity private key never enters this app. The 32-byte seed feeds the
 * FairCoin HD `KeyManager.fromSeed` directly; it is NEVER routed through a BIP39
 * mnemonic (`mnemonicToSeed` does not validate its input and would silently
 * derive a different, wrong seed — spec §4.1).
 */

import { KeyManager as IdentityKeyManager } from "@oxy.so/core";
import { bytesToHex } from "@fairco.in/core";

/**
 * HKDF `info` binding the derived seed to Peable's FairCoin wallet.
 *
 * The VALUE is an HKDF input, so it is part of the derivation itself: a
 * different `info` derives a different seed, hence a different wallet, and no
 * migration can recover the old one. It was renamed from `oxypay/faircoin/v1`
 * with the Peable rebrand ONLY because nothing had shipped yet — there were no
 * wallets to strand. From here on it is frozen: bump the `v1` suffix if the
 * derivation ever has to change, and never edit this string in place.
 */
export const PEABLE_SEED_INFO = "peable/faircoin/v1";

/** Fixed wallet id for the single identity-derived wallet (SQLite namespace). */
export const OXY_IDENTITY_WALLET_ID = "oxy-identity";

/**
 * Marker prefix for the in-memory "secret" the store's `initialize` accepts to
 * build a KeyManager straight from a 32-byte seed (mirrors the `xpub:` marker).
 * The seed is NEVER persisted — it is re-derived from the identity each boot.
 */
export const SEED_SECRET_PREFIX = "seed:";

/**
 * Derive the FairCoin wallet seed from the on-device Oxy identity, or `null`
 * on web / when the account is keyless (no identity key). Native-only.
 */
export async function deriveIdentitySeed(): Promise<Uint8Array | null> {
  return IdentityKeyManager.deriveScopedSeed(PEABLE_SEED_INFO);
}

/** Encode a 32-byte seed as the `seed:<hex>` secret the store consumes. */
export function buildSeedSecret(seed: Uint8Array): string {
  return `${SEED_SECRET_PREFIX}${bytesToHex(seed)}`;
}
