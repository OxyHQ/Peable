/**
 * Every key the wallet keeps in `kv-store`, named once.
 *
 * Two readers depend on this list being complete and identical:
 *
 * - `secure-store`'s `clearAll` deletes {@link walletSecretKeys} — a wipe must
 *   leave no phrase, cached seed, xpub or PIN record behind;
 * - the iOS keychain move (`./keychain-groups`, oxy ADR 0062) moves
 *   {@link keychainMoveKeys} — the same secret keys plus the preferences — out
 *   of the group every Oxy app can read, once, and afterwards never reads that
 *   group again. A key missing here would stay readable by every Oxy app (a
 *   secret) or be dropped by the upgrade (a preference).
 *
 * Pure: no storage or React Native import, so tests and the adapter load it.
 * `wallet-keys.test.ts` fails on a `fairwallet_` key in the app this list does
 * not know.
 */

/** Secret, single-instance keys `secure-store` writes. */
export const SECRET_KEYS = {
  /** Pre-multi-wallet mnemonic, migrated to a per-wallet key on first read. */
  legacyMnemonic: 'fairwallet_mnemonic',
  pin: 'fairwallet_pin',
  created: 'fairwallet_created',
  biometrics: 'fairwallet_biometrics',
  autoLock: 'fairwallet_auto_lock',
  currency: 'fairwallet_currency',
  // Last, so a wipe that stops part-way still finds the wallets it has not
  // reached yet through the index on its next attempt.
  activeWallet: 'fairwallet_active_wallet',
  walletsIndex: 'fairwallet_wallets_index',
} as const;

/** Per-wallet secret keys `secure-store` writes: `<prefix><walletId>`. */
export const SECRET_PREFIXES = {
  mnemonic: 'fairwallet_mnemonic_',
  seed: 'fairwallet_seed_',
  xpub: 'fairwallet_xpub_',
  backedUp: 'fairwallet_backedup_',
} as const;

/**
 * The id a BIP39 seed is cached under on the transient path where no active
 * wallet id is resolvable yet (`wallet-store`'s `activeId ?? 'default'`).
 */
export const DEFAULT_SEED_CACHE_ID = 'default';

/** Preferences other modules keep in `kv-store` (theme, language, PIN attempts, …). */
export const PREFERENCE_KEYS = [
  'fairwallet_theme_mode',
  'fairwallet_language',
  'fairwallet_notification_prefs',
  'fairwallet_crash_log',
  'fairwallet_pin_attempts',
] as const;

/** The PIN attempt count (`pin-attempts.ts`), never adopted with or without the PIN (R7-7). */
const PIN_ATTEMPTS_KEY = 'fairwallet_pin_attempts';

/** Per-wallet preferences other modules keep: `<prefix><walletId>`. */
export const PREFERENCE_PREFIXES = [
  'fairwallet_pockets_',
  'fairwallet_active_pocket_',
  'fairwallet_notification_sub_',
] as const;

/**
 * The person's identity wallet id before round 5 (`wallet/identity-wallet.ts`'s
 * `LEGACY_IDENTITY_WALLET_ID`, asserted equal by the test): never in the wallet
 * index, yet it had Pockets and a notification subscription, which the
 * one-shot keychain move carries out of the shared group before the namespace
 * move (R5-2) carries them to the account's own `oxy-user-<id>`.
 */
export const IDENTITY_WALLET_ID = 'oxy-identity';

/**
 * Written ONLY to the group the wallet's items live in once the move into it
 * is complete; read only from there and from the earlier (wallet) group,
 * where it says the move out of the shared group finished; never written
 * anywhere else or deleted, and not a wallet key — `clearAll` must not reset
 * it, or the next launch would adopt from the shared group again.
 */
export const KEYCHAIN_MOVE_MARKER = 'peable_keychain_split_v1';

/**
 * Written beside {@link KEYCHAIN_MOVE_MARKER} once the wallets a 1.2–1.4
 * build may have adopted from the shared group without recording it are
 * listed in {@link KEYCHAIN_ADOPTED_WALLETS} (R7-7): those builds took phrases
 * and xpubs from there with no proof, and nothing re-checked them. Same rules
 * as the move marker: written and read only in the wallet's own group, never
 * deleted, not a wallet key.
 */
export const KEYCHAIN_RECHECK_MARKER = 'peable_keychain_split_v2';

/**
 * The nonce that binds this app's install evidence to THIS phone (R7-7): a
 * keychain item in the wallet's own group written "this device only", so it
 * never reaches another phone through a backup — encrypted or not — while
 * the evidence file in the sandbox does. Not a wallet key: never adopted,
 * never cleared by `clearAll`.
 */
export const INSTALL_EVIDENCE_NONCE = 'peable_install_evidence_v2';

/**
 * Where the one-time move of the pre-round-5 shared identity wallet
 * (`oxy-identity`) to its proven account stands (R5-2,
 * `wallet/identity-namespace.ts`). Not a wallet key: the keychain move never
 * adopts it from the shared group (another app could write it there), and
 * `clearAll` leaves it.
 */
export const LEGACY_IDENTITY_NAMESPACE_MARKER = 'peable_identity_namespace_v1';

/**
 * The wallets the keychain move adopted from the SHARED group (R6-4): a JSON
 * list of wallet ids, written to the wallet's own group before the move's
 * marker. Another Oxy app could have planted what was adopted there, so each
 * such wallet offers nothing to receive into until the person confirms it is
 * theirs (`wallet/receive-gate.ts`), which removes its id. Not a wallet key:
 * never adopted from the shared group, and `clearAll` leaves it.
 */
export const KEYCHAIN_ADOPTED_WALLETS = 'peable_keychain_adopted_v1';

/** The wallet ids {@link KEYCHAIN_ADOPTED_WALLETS} lists, or `[]` for an absent or unreadable one. */
export function parseAdoptedWallets(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? uniqueSafeIds(parsed.filter((id): id is string => typeof id === 'string'))
      : [];
  } catch {
    return [];
  }
}

/**
 * Evidence that THIS app ran before on this phone, from its own sandbox and
 * never from a keychain group (R6-4): the wallet ids whose SQLite file the
 * sandbox held when this build first looked (`fairwallet.db` is the id-less
 * wallet, `''`). Another app cannot write here. It counts only while the
 * nonce it was recorded with is still in the wallet's own group, "this device
 * only" ({@link INSTALL_EVIDENCE_NONCE}, R7-7).
 */
export interface InstallEvidence {
  readonly walletIds: ReadonlySet<string>;
}

const DATABASE_FILE = /^fairwallet(?:_(.+?))?(?:_acct\d+)?\.db$/;

/** The wallet id a wallet database file name belongs to (`db-name.ts`), or `null` for another file. */
export function walletIdOfDatabaseFile(name: string): string | null {
  const match = DATABASE_FILE.exec(name);
  if (!match) return null;
  return match[1] ?? '';
}

/** The per-wallet key's wallet id, or `null` for a key that names none. */
function walletIdOfKey(key: string): string | null {
  for (const prefix of [...Object.values(SECRET_PREFIXES), ...PREFERENCE_PREFIXES]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

/**
 * What the keychain move may take from the SHARED group for `key`, given
 * `value` found there, or `null` to take nothing (R6-4). Every Oxy app can
 * write that group, so nothing is taken without evidence that this app ran
 * here before (`evidence`):
 *
 * - no evidence at all (every fresh install): nothing;
 * - a cached seed: never — it is re-derived from the phrase, and a planted one
 *   would open the wallet on someone else's keys;
 * - the pre-multi-wallet phrase: never — this app only ever migrates it;
 * - the wallet index: only its entries whose wallet has evidence;
 * - the active-wallet pointer and every per-wallet key: only for a wallet
 *   with evidence;
 * - the PIN record and the PIN attempt count: never (R7-7) — a planted PIN
 *   would be the lock on a phrase this app then adopts; the person sets a
 *   new one;
 * - the other single keys: only with some evidence.
 */
export function adoptableFromShared(
  key: string,
  value: string,
  evidence: InstallEvidence,
): string | null {
  const ids = evidence.walletIds;
  if (ids.size === 0) return null;
  if (key === SECRET_KEYS.legacyMnemonic || key.startsWith(SECRET_PREFIXES.seed)) return null;
  if (key === SECRET_KEYS.pin || key === PIN_ATTEMPTS_KEY) return null;
  if (key === SECRET_KEYS.walletsIndex) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return null;
      const kept = parsed.filter(
        (w: unknown) =>
          w !== null &&
          typeof w === 'object' &&
          typeof (w as { id?: unknown }).id === 'string' &&
          ids.has((w as { id: string }).id),
      );
      return kept.length > 0 ? JSON.stringify(kept) : null;
    } catch {
      return null;
    }
  }
  if (key === SECRET_KEYS.activeWallet) return ids.has(value) ? value : null;
  const walletId = walletIdOfKey(key);
  if (walletId !== null) return ids.has(walletId) ? value : null;
  return value;
}

/** The wallet a key's adopted value makes spendable here (its phrase or xpub), or `null`. */
export function walletOfAdoptedSecret(key: string): string | null {
  for (const prefix of [SECRET_PREFIXES.mnemonic, SECRET_PREFIXES.xpub]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

/** The characters `expo-secure-store` accepts in a key; anything else it never wrote. */
const KEY_SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** The cached-seed key of a wallet. */
export function walletSeedKey(walletId: string): string {
  return `${SECRET_PREFIXES.seed}${walletId}`;
}

/**
 * THE wallet's secret keys for these wallet ids: what `clearAll` deletes and
 * the first part of what the keychain move moves. Includes the seed cached
 * under {@link DEFAULT_SEED_CACHE_ID}. Ordered per-wallet keys first and the
 * index last.
 */
export function walletSecretKeys(walletIds: readonly string[]): string[] {
  const ids = uniqueSafeIds(walletIds);
  return [
    ...ids.flatMap((id) => Object.values(SECRET_PREFIXES).map((prefix) => `${prefix}${id}`)),
    walletSeedKey(DEFAULT_SEED_CACHE_ID),
    ...Object.values(SECRET_KEYS),
  ];
}

/** The preference keys for these wallet ids (identity wallet included). */
export function walletPreferenceKeys(walletIds: readonly string[]): string[] {
  const ids = uniqueSafeIds([...walletIds, IDENTITY_WALLET_ID]);
  return [
    ...PREFERENCE_KEYS,
    ...ids.flatMap((id) => PREFERENCE_PREFIXES.map((prefix) => `${prefix}${id}`)),
  ];
}

/** Everything the one-shot keychain move moves: the secret keys, then the preferences. */
export function keychainMoveKeys(walletIds: readonly string[]): string[] {
  return [...new Set([...walletSecretKeys(walletIds), ...walletPreferenceKeys(walletIds)])];
}

/**
 * Whether `key` is one of the wallet's keys (secret or preference) — the only
 * keys the keychain move may adopt from the shared group.
 */
export function isWalletKey(key: string): boolean {
  if ((Object.values(SECRET_KEYS) as string[]).includes(key)) return true;
  if ((PREFERENCE_KEYS as readonly string[]).includes(key)) return true;
  return [...Object.values(SECRET_PREFIXES), ...PREFERENCE_PREFIXES].some(
    (prefix) => key.startsWith(prefix) && KEY_SAFE_ID.test(key.slice(prefix.length)),
  );
}

/**
 * The wallet ids a stored wallet index names, or `[]` for an absent or
 * unreadable one. Ids a keychain key cannot carry are dropped: no such key was
 * ever written, and asking for one would fail every time.
 */
export function walletIdsOfIndex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return uniqueSafeIds(
      parsed.map((w: unknown) =>
        w !== null && typeof w === 'object' && typeof (w as { id?: unknown }).id === 'string'
          ? (w as { id: string }).id
          : '',
      ),
    );
  } catch {
    return [];
  }
}

function uniqueSafeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => KEY_SAFE_ID.test(id)))];
}
