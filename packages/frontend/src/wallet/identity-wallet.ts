/**
 * Bridge from the Oxy self-sovereign identity to the single FairCoin wallet.
 *
 * The wallet seed is derived on-device from the Oxy identity key via
 * `@oxy.so/core`'s `KeyManager.deriveScopedSeed` (HKDF, domain-separated) — the
 * identity private key never enters this app: on Android Commons computes the
 * seed and answers over IPC, on iOS the SDK derives it from the keychain-group
 * key. The 32-byte seed feeds the
 * FairCoin HD `KeyManager.fromSeed` directly; it is NEVER routed through a BIP39
 * mnemonic (`mnemonicToSeed` does not validate its input and would silently
 * derive a different, wrong seed — spec §4.1).
 */

import { KeyManager as IdentityKeyManager } from '@oxy.so/core/crypto';
import { bytesToHex } from '@fairco.in/core';

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
export const PEABLE_SEED_INFO = 'peable/faircoin/v1';

/** Fixed wallet id for the person's own identity-derived wallet (SQLite namespace). */
export const OXY_IDENTITY_WALLET_ID = 'oxy-identity';

/**
 * Prefix of an ORGANIZATION's identity wallet id (oxy ADR 0061): the wallet a
 * person sees while acting as that organization, derived from the
 * organization's own key. Its own SQLite namespace, so the organization's
 * coins, addresses and social-receive window never mix with the person's.
 * Only characters secure-store keys accept (`[A-Za-z0-9._-]`); an Oxy account
 * id is 24-hex or a uuid.
 */
export const ORGANIZATION_WALLET_ID_PREFIX = 'oxy-org-';

/**
 * Whose key an identity wallet derives from. A person acting as an
 * organization (oxy ADR 0001) sees the ORGANIZATION's wallet, from the
 * organization's key; it is never derived from the person's own key, which
 * would hand the organization's payers addresses that leave with that person.
 */
export type IdentitySubject =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly accountId: string };

export const PERSONAL_SUBJECT: IdentitySubject = { kind: 'personal' };

/** The wallet id (SQLite namespace) of a subject's identity wallet. */
export function identityWalletIdOf(subject: IdentitySubject): string {
  return subject.kind === 'personal'
    ? OXY_IDENTITY_WALLET_ID
    : `${ORGANIZATION_WALLET_ID_PREFIX}${subject.accountId}`;
}

/**
 * The subject an identity wallet id names, or `null` for any other wallet (a
 * BIP39 or watch-only one). The inverse of {@link identityWalletIdOf}, so a PIN
 * unlock that only knows the active wallet id re-derives from the right key.
 */
export function identitySubjectOfWalletId(walletId: string): IdentitySubject | null {
  if (walletId === OXY_IDENTITY_WALLET_ID) return PERSONAL_SUBJECT;
  if (walletId.startsWith(ORGANIZATION_WALLET_ID_PREFIX)) {
    const accountId = walletId.slice(ORGANIZATION_WALLET_ID_PREFIX.length);
    return accountId.length > 0 ? { kind: 'organization', accountId } : null;
  }
  return null;
}

/** The `opts` `@oxy.so/core`'s key reads take for a subject: none for the person. */
export function identityKeyOptions(subject: IdentitySubject): { accountId: string } | undefined {
  return subject.kind === 'organization' ? { accountId: subject.accountId } : undefined;
}

/**
 * Marker prefix for the in-memory "secret" the store's `initialize` accepts to
 * build a KeyManager straight from a 32-byte seed (mirrors the `xpub:` marker).
 * The seed is NEVER persisted — it is re-derived from the identity each boot.
 */
export const SEED_SECRET_PREFIX = 'seed:';

/**
 * Derive the FairCoin wallet seed from the on-device Oxy identity, or `null`
 * on web / when the account is keyless (no identity key). Native-only.
 *
 * For an organization the seed comes from ITS key (`{ accountId }`), which
 * Commons holds for the organization's owners and admins (oxy ADR 0061 D6), and
 * is `null` when this phone cannot reach that key — `@oxy.so/core` never falls
 * back to the person's key, and neither does this.
 */
export async function deriveIdentitySeed(
  subject: IdentitySubject = PERSONAL_SUBJECT,
): Promise<Uint8Array | null> {
  const options = identityKeyOptions(subject);
  return options
    ? IdentityKeyManager.deriveScopedSeed(PEABLE_SEED_INFO, options)
    : IdentityKeyManager.deriveScopedSeed(PEABLE_SEED_INFO);
}

/** Encode a 32-byte seed as the `seed:<hex>` secret the store consumes. */
export function buildSeedSecret(seed: Uint8Array): string {
  return `${SEED_SECRET_PREFIX}${bytesToHex(seed)}`;
}
