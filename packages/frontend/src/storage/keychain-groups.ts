/**
 * iOS: where Peable's own SecureStore items live since the keychain
 * access-group split (oxy ADR 0062, docs/identity/ios-keychain-access-groups.md).
 *
 * Until build 1.2.0 Peable's only keychain group was `group.so.oxy.shared`, so
 * every item written without a group — imported wallets' phrases, cached
 * wallet seeds, the PIN record — landed where EVERY Oxy iOS app can read it.
 * The app now lists `[so.oxy.wallet, group.so.oxy.shared]`: the wallet group,
 * which only Commons and Peable hold, is the default ("own" below).
 *
 * The move out of the shared group is ONE-SHOT and runs before anything else:
 *
 * - Every operation of the adapter first awaits the one move of this process,
 *   so the app's own reads, writes and deletes never interleave with it: the
 *   move cannot overwrite a value the app just wrote or bring back one it just
 *   deleted.
 * - The move covers exactly the wallet's keys (`./wallet-keys`: the secret
 *   keys `clearAll` deletes, plus the preferences), for the wallets the stored
 *   index and active-wallet keys name. For each: a value already in the own
 *   group is kept (never overwritten); otherwise the shared value is copied
 *   and read back; then the shared copy is deleted and its absence read back.
 * - Only when every key is done is {@link KEYCHAIN_MOVE_MARKER} written — to
 *   the own group, and read only from there. From then on the shared group is
 *   NEVER read again, for any key: an item another app plants there later is
 *   ignored, and a deleted key has nothing to come back from.
 * - If any step fails (a locked keychain), no marker: this process reads the
 *   shared group as a read-only fallback for the wallet's keys it has not
 *   written or deleted itself, copies nothing, and the next launch runs the
 *   move again.
 *
 * What this cannot prove: BEFORE the marker exists, an item another Oxy app
 * planted in the shared group is indistinguishable from the wallet's own
 * pre-split item — same key, same group, no provenance on either. The move
 * adopts it if the own group has nothing under that key (an empty wallet
 * index, a missing PIN record). The marker bounds that window to the launches
 * before the first complete move; it cannot close it. Wallet keys the move
 * cannot enumerate (an organization wallet's Pockets when it is not the
 * active wallet) are not adopted and, after the marker, revert to defaults.
 *
 * Writes name the own group explicitly and then remove any copy from the
 * shared group (best effort; deleting is not reading). A delete reaches every
 * group, as it always did. Every other platform, and an iOS build whose native
 * module predates the keychain probe (`ungrouped`), makes exactly the calls it
 * always made.
 */
import type { KeychainAccess } from '@oxy.so/core/crypto';
import { keychainAccessGroupValue, ownKeychainItemPlan } from '@oxy.so/core/crypto';
import {
  isWalletKey,
  KEYCHAIN_MOVE_MARKER,
  keychainMoveKeys,
  SECRET_KEYS,
  walletIdsOfIndex,
} from './wallet-keys';

export interface KeychainStore {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
}

export interface KeyValueAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

interface Groups {
  own: string;
  shared: string;
}

/** The outcome of this process's one move: `null` groups → the pre-split calls. */
type Setup = { groups: null } | { groups: Groups; moved: boolean };

/** The two groups that matter here, or `null` for the calls made before the split. */
async function groupsOf(resolveAccess: () => Promise<KeychainAccess>): Promise<Groups | null> {
  const access = await resolveAccess();
  const own = ownKeychainItemPlan(access).write.accessGroup;
  const shared = keychainAccessGroupValue(access, 'shared');
  return own && shared && own !== shared ? { own, shared } : null;
}

/** Best effort: a write's superseded shared copy. Never throws. */
async function removeSharedCopy(store: KeychainStore, key: string, shared: string): Promise<void> {
  try {
    await store.deleteItemAsync(key, { accessGroup: shared });
  } catch {
    // The marker stops it being read; the next write of this key tries again.
  }
}

/**
 * Move one key: keep an own value (never overwrite), else copy the shared one
 * and read it back; then delete the shared copy and read back its absence.
 * `true` once the shared group holds nothing under `key`. Never throws.
 */
async function moveKey(store: KeychainStore, key: string, groups: Groups): Promise<boolean> {
  try {
    const shared = await store.getItemAsync(key, { accessGroup: groups.shared });
    if (shared === null) return true;
    const own = await store.getItemAsync(key, { accessGroup: groups.own });
    if (own === null) {
      await store.setItemAsync(key, shared, { accessGroup: groups.own });
      if ((await store.getItemAsync(key, { accessGroup: groups.own })) !== shared) return false;
    }
    await store.deleteItemAsync(key, { accessGroup: groups.shared });
    return (await store.getItemAsync(key, { accessGroup: groups.shared })) === null;
  } catch {
    return false;
  }
}

/** Both groups' values of `key`, own first. Throws when either cannot be read. */
async function bothValues(store: KeychainStore, key: string, groups: Groups): Promise<string[]> {
  const own = await store.getItemAsync(key, { accessGroup: groups.own });
  const shared = await store.getItemAsync(key, { accessGroup: groups.shared });
  return [own, shared].filter((v): v is string => v !== null);
}

/**
 * The one move (see the module comment). `true` when the marker exists — found
 * or written now — and `false` when this launch could not finish. Never throws.
 */
async function moveOnce(store: KeychainStore, groups: Groups): Promise<boolean> {
  try {
    if ((await store.getItemAsync(KEYCHAIN_MOVE_MARKER, { accessGroup: groups.own })) !== null) {
      return true;
    }
    // Which wallets' keys to move: every wallet either group's index names,
    // and either group's active wallet (an identity wallet is never indexed).
    const indexes = await bothValues(store, SECRET_KEYS.walletsIndex, groups);
    const active = await bothValues(store, SECRET_KEYS.activeWallet, groups);
    const ids = [...indexes.flatMap(walletIdsOfIndex), ...active];
    let complete = true;
    for (const key of keychainMoveKeys(ids)) {
      if (!(await moveKey(store, key, groups))) complete = false;
    }
    if (!complete) return false;
    await store.setItemAsync(KEYCHAIN_MOVE_MARKER, '1', { accessGroup: groups.own });
    return (await store.getItemAsync(KEYCHAIN_MOVE_MARKER, { accessGroup: groups.own })) === '1';
  } catch {
    return false;
  }
}

/**
 * The SecureStore adapter Peable's `kv-store` uses on native. `resolveAccess`
 * is `@oxy.so/core`'s `resolveKeychainAccess` (injected for tests); off iOS it
 * answers `ungrouped`.
 */
export function createGroupedKeychainAdapter(
  store: KeychainStore,
  resolveAccess: () => Promise<KeychainAccess>,
): KeyValueAdapter {
  let setup: Promise<Setup> | null = null;
  /** Keys this process wrote or deleted: the no-marker fallback never answers for them. */
  const touched = new Set<string>();

  function ready(): Promise<Setup> {
    if (!setup) {
      const pending = (async (): Promise<Setup> => {
        const groups = await groupsOf(resolveAccess);
        return groups ? { groups, moved: await moveOnce(store, groups) } : { groups: null };
      })();
      // The access probe failed: the caller sees it, and the next call asks again.
      pending.catch(() => {
        if (setup === pending) setup = null;
      });
      setup = pending;
    }
    return setup;
  }

  return {
    getItem: async (key) => {
      const s = await ready();
      if (!s.groups) return store.getItemAsync(key);
      const own = await store.getItemAsync(key, { accessGroup: s.groups.own });
      if (own !== null || s.moved || touched.has(key) || !isWalletKey(key)) return own;
      // No marker yet (this launch's move failed): read, never copy.
      const shared = await store.getItemAsync(key, { accessGroup: s.groups.shared });
      return touched.has(key) ? store.getItemAsync(key, { accessGroup: s.groups.own }) : shared;
    },
    setItem: async (key, value) => {
      const s = await ready();
      if (!s.groups) return store.setItemAsync(key, value);
      touched.add(key);
      await store.setItemAsync(key, value, { accessGroup: s.groups.own });
      await removeSharedCopy(store, key, s.groups.shared);
    },
    deleteItem: async (key) => {
      const s = await ready();
      if (s.groups) touched.add(key);
      await store.deleteItemAsync(key);
    },
  };
}
