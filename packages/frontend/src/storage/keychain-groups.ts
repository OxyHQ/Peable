/**
 * iOS: where Peable's own SecureStore items live since the keychain
 * access-group split (oxy ADR 0062, docs/identity/ios-keychain-access-groups.md).
 *
 * Until this build Peable's only keychain group was `group.so.oxy.shared`, so
 * every item written without a group — imported wallets' phrases, cached
 * wallet seeds, the PIN record — landed where EVERY Oxy iOS app can read it.
 * This build lists `[so.oxy.wallet, group.so.oxy.shared]`: the wallet group,
 * which only Commons and Peable hold, is the default. So:
 *
 * - a write names the default group explicitly, and then removes the
 *   superseded copy from the shared group (a write replaces the value; it
 *   would have overwritten that copy before the split);
 * - a read looks in the default group first, then in every group; an item
 *   found only outside is MOVED: copied to the default group, read back, and
 *   only then deleted from the shared group. A failed step leaves it readable
 *   where it was, and the next read tries again;
 * - a delete reaches every group, as it always did.
 *
 * Every other platform, and an iOS build whose native module predates the
 * keychain probe (`ungrouped`), makes exactly the calls it always made.
 */
import type { KeychainAccess } from '@oxy.so/core/crypto';
import { keychainAccessGroupValue, ownKeychainItemPlan } from '@oxy.so/core/crypto';

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

/** The two groups that matter here, or `null` for the calls made before the split. */
async function groupsOf(
  resolveAccess: () => Promise<KeychainAccess>,
): Promise<{ own: string; shared: string } | null> {
  const access = await resolveAccess();
  const own = ownKeychainItemPlan(access).write.accessGroup;
  const shared = keychainAccessGroupValue(access, 'shared');
  return own && shared && own !== shared ? { own, shared } : null;
}

/** Best effort: the item stays readable through the fallback until a move succeeds. */
async function removeSharedCopy(store: KeychainStore, key: string, shared: string): Promise<void> {
  try {
    await store.deleteItemAsync(key, { accessGroup: shared });
  } catch {
    // Retried on the next write or read of this key.
  }
}

/** Copy, read back, and only then delete the shared copy. Never throws. */
async function moveToOwnGroup(
  store: KeychainStore,
  key: string,
  value: string,
  groups: { own: string; shared: string },
): Promise<void> {
  try {
    await store.setItemAsync(key, value, { accessGroup: groups.own });
    if ((await store.getItemAsync(key, { accessGroup: groups.own })) !== value) return;
  } catch {
    return;
  }
  await removeSharedCopy(store, key, groups.shared);
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
  return {
    getItem: async (key) => {
      const groups = await groupsOf(resolveAccess);
      if (!groups) return store.getItemAsync(key);
      const own = await store.getItemAsync(key, { accessGroup: groups.own });
      if (own !== null) return own;
      const anywhere = await store.getItemAsync(key);
      if (anywhere !== null) await moveToOwnGroup(store, key, anywhere, groups);
      return anywhere;
    },
    setItem: async (key, value) => {
      const groups = await groupsOf(resolveAccess);
      if (!groups) return store.setItemAsync(key, value);
      await store.setItemAsync(key, value, { accessGroup: groups.own });
      await removeSharedCopy(store, key, groups.shared);
    },
    deleteItem: (key) => store.deleteItemAsync(key),
  };
}
