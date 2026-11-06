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

import { KeyManager as IdentityKeyManager, listRetiredIdentityKeys } from '@oxy.so/core/crypto';
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

/**
 * The ONE wallet id every person's identity wallet shared before security
 * review round 5 (R5-2), whoever was signed in: a phone that two accounts
 * used held both in one namespace, and the second could open the first's
 * previous keys. Never opened again. `identity-namespace.ts` moves it, once,
 * to the account it is PROVEN to belong to (`PERSONAL_WALLET_ID_PREFIX`), or
 * leaves it closed.
 */
export const LEGACY_IDENTITY_WALLET_ID = 'oxy-identity';

/**
 * Prefix of a PERSON's identity wallet id: `oxy-user-<accountId>`, one SQLite
 * namespace (and one set of per-wallet preferences) per Oxy account (R5-2),
 * so nothing one account's wallet stored — its social-receive set, its
 * previous-key trees, its HD tree — is ever read for another account signed in
 * on the same phone. Only characters secure-store keys accept
 * (`[A-Za-z0-9._-]`); an Oxy account id is 24-hex or a uuid.
 */
export const PERSONAL_WALLET_ID_PREFIX = 'oxy-user-';

/**
 * Prefix of an ORGANIZATION's identity wallet id (oxy ADR 0061): the wallet a
 * person sees while acting as that organization, derived from the
 * organization's own key. Its own SQLite namespace, so the organization's
 * coins, addresses and social-receive window never mix with the person's.
 */
export const ORGANIZATION_WALLET_ID_PREFIX = 'oxy-org-';

/**
 * Whose key an identity wallet derives from, and which Oxy account it belongs
 * to. A person acting as an organization (oxy ADR 0001) sees the
 * ORGANIZATION's wallet, from the organization's key; it is never derived from
 * the person's own key, which would hand the organization's payers addresses
 * that leave with that person. The person's own wallet is named by THEIR
 * account id (R5-2): two people signing in on one phone open two wallets.
 */
export type IdentitySubject =
  | { readonly kind: 'personal'; readonly accountId: string }
  | { readonly kind: 'organization'; readonly accountId: string };

/** The person's own identity wallet subject, for the Oxy account `accountId`. */
export function personalSubject(accountId: string): IdentitySubject {
  return { kind: 'personal', accountId };
}

/** The wallet id (SQLite namespace) of a subject's identity wallet. */
export function identityWalletIdOf(subject: IdentitySubject): string {
  return subject.kind === 'personal'
    ? `${PERSONAL_WALLET_ID_PREFIX}${subject.accountId}`
    : `${ORGANIZATION_WALLET_ID_PREFIX}${subject.accountId}`;
}

/**
 * The subject an identity wallet id names, or `null` for any other wallet (a
 * BIP39 or watch-only one) — and for the legacy shared id, which names no
 * account and is never opened. The inverse of {@link identityWalletIdOf}, so a
 * PIN unlock that only knows the active wallet id re-derives from the right key.
 */
export function identitySubjectOfWalletId(walletId: string): IdentitySubject | null {
  for (const [prefix, kind] of [
    [PERSONAL_WALLET_ID_PREFIX, 'personal'],
    [ORGANIZATION_WALLET_ID_PREFIX, 'organization'],
  ] as const) {
    if (walletId.startsWith(prefix)) {
      const accountId = walletId.slice(prefix.length);
      return accountId.length > 0 ? { kind, accountId } : null;
    }
  }
  return null;
}

/** Whether `walletId` is an identity wallet's, the legacy shared one included. */
export function isIdentityWalletId(walletId: string): boolean {
  return walletId === LEGACY_IDENTITY_WALLET_ID || identitySubjectOfWalletId(walletId) !== null;
}

/**
 * The `opts` `@oxy.so/core`'s key reads take for a subject: the organization's
 * `accountId`, or the person's `ownerAccountId` — since core 7.33.0 the
 * personal retired ring is bound to its owner, and a personal read reaches only
 * that account's previous keys, never the last person's on this phone (R5-2).
 */
export function identityKeyOptions(
  subject: IdentitySubject,
): { accountId: string } | { ownerAccountId: string } {
  return subject.kind === 'organization'
    ? { accountId: subject.accountId }
    : { ownerAccountId: subject.accountId };
}

/**
 * Marker prefix for the in-memory "secret" the store's `initialize` accepts to
 * build a KeyManager straight from a 32-byte seed (mirrors the `xpub:` marker).
 * The seed is NEVER persisted — it is re-derived from the identity each boot.
 */
export const SEED_SECRET_PREFIX = 'seed:';

/**
 * Derive the FairCoin wallet seed of ONE of the subject's keys, named by its
 * public key (security review round 5, R5-1): the key the wallet decided to
 * open with (`identity-key.ts`), never "whatever key this device holds". The
 * unselected read takes the iOS keychain group every Oxy app can write, so a
 * key planted there would become the wallet; a selector reaches only the key
 * it names (current or retired, oxy ADR 0061 D7) and is `null` when this device
 * cannot reach it — never another key's seed in its place. Native-only; the
 * caller zeroes the bytes once its KeyManager is built.
 */
export async function deriveIdentitySeed(
  subject: IdentitySubject,
  publicKey: string,
): Promise<Uint8Array | null> {
  return IdentityKeyManager.deriveScopedSeed(PEABLE_SEED_INFO, {
    ...identityKeyOptions(subject),
    publicKey,
  });
}

/** Encode a 32-byte seed as the `seed:<hex>` secret the store consumes. */
export function buildSeedSecret(seed: Uint8Array): string {
  return `${SEED_SECRET_PREFIX}${bytesToHex(seed)}`;
}

/**
 * The wallet seed of a PREVIOUS key of the subject (ADR 0002, amended
 * 2026-11-06 "previous keys stay spendable"): {@link deriveIdentitySeed} by
 * another name, kept so the two uses read apart.
 */
export const derivePreviousKeySeed = deriveIdentitySeed;

/**
 * The previous keys Commons says this device holds for the subject, as a HINT
 * only: the keys that matter are those the gateway recorded on the account's
 * addresses (`identity_public_key`, ADR 0021 D9), and this list adds the ones
 * that only ever received to the HD tree. Empty on any failure (web, an SDK
 * without the ring, Commons absent): a missing hint hides nothing the
 * recorded keys name.
 */
export async function listPreviousKeyHints(subject: IdentitySubject): Promise<string[]> {
  try {
    const keys = await listRetiredIdentityKeys(identityKeyOptions(subject));
    return keys.map((entry) => entry.publicKey);
  } catch {
    return [];
  }
}
