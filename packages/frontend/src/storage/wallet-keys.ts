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

/** Per-wallet preferences other modules keep: `<prefix><walletId>`. */
export const PREFERENCE_PREFIXES = [
  'fairwallet_pockets_',
  'fairwallet_active_pocket_',
  'fairwallet_notification_sub_',
] as const;

/**
 * The person's identity wallet id (`wallet/identity-wallet.ts`'s
 * `OXY_IDENTITY_WALLET_ID`, asserted equal by the test): never in the wallet
 * index, yet it has Pockets and a notification subscription.
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
