/**
 * iOS: where Peable's own SecureStore items live since the keychain
 * access-group split (oxy ADR 0062 D3, D6; docs/identity/ios-keychain-access-groups.md).
 *
 * Until build 1.2.0 Peable's only keychain group was `group.so.oxy.shared`, so
 * every item written without a group — imported wallets' phrases, cached
 * wallet seeds, the PIN record — landed where EVERY Oxy iOS app can read it.
 * Their home ("own" below) is `@oxy.so/core`'s `ownKeychainItemPlan` write
 * group, never a spelling of our own:
 *
 * - a native build with the app-group probe (`@oxy.so/services` 14.10+):
 *   the app's own group, `<TEAM>.to.peable.app` (`.dev` for the dev build),
 *   which no other app can read — not even Commons. The wallet group the
 *   previous build moved them into (`so.oxy.wallet`, `so.oxy.wallet.dev`: the
 *   default group, which Commons also holds) is then an EARLIER location;
 * - a native build without that probe: the default (wallet) group itself,
 *   with no earlier location — exactly what that build did before.
 *
 * The move into "own" is ONE-SHOT and runs before anything else:
 *
 * - Every operation of the adapter first awaits the one move of this process,
 *   so the app's own reads, writes and deletes never interleave with it: the
 *   move cannot overwrite a value the app just wrote or bring back one it just
 *   deleted.
 * - The move covers exactly the wallet's keys (`./wallet-keys`: the secret
 *   keys `clearAll` deletes, plus the preferences), for the wallets the stored
 *   indexes and active-wallet keys name. Its SOURCES are the earlier group
 *   first (a post-split value, so the newer one) and the shared group — but
 *   NOT the shared group once the earlier group carries
 *   {@link KEYCHAIN_MOVE_MARKER}: the move out of it finished then, and what
 *   sits there now was planted afterwards. For each key: a value already in
 *   "own" is kept (never overwritten); otherwise the first source's value is
 *   copied and read back; then every source's copy is deleted and its absence
 *   read back.
 * - Only when every key is done is {@link KEYCHAIN_MOVE_MARKER} written — to
 *   "own", and read only from there (and, as above, from the earlier group).
 *   From then on no source is read again, for any key: an item another app
 *   plants in the shared group later is ignored, and a deleted key has
 *   nothing to come back from.
 * - If any step fails (a locked keychain), no marker: this process reads the
 *   sources as a read-only fallback for the wallet's keys it has not written
 *   or deleted itself, copies nothing, and the next launch runs the move again.
 *
 * What this cannot prove: BEFORE the shared group's move finished, an item
 * another Oxy app planted there is indistinguishable from the wallet's own
 * pre-split item — same key, same group, no provenance on either. The move
 * adopts it if neither "own" nor the earlier group has anything under that
 * key (an empty wallet index, a missing PIN record). The marker bounds that
 * window to the launches before the first complete move; it cannot close it.
 * Wallet keys the move cannot enumerate (an organization wallet's Pockets
 * when it is not the active wallet) are not adopted and, after the marker,
 * revert to defaults.
 *
 * Writes name "own" explicitly and then remove any copy from the sources
 * (best effort; deleting is not reading). A delete names "own", the earlier
 * group and the shared group, then makes the unscoped call it always made. Every other platform, and an iOS build whose native module
 * predates the keychain probe (`ungrouped`), makes exactly the calls it always
 * made.
 *
 * A DEVELOPMENT build (`variant: '.dev'`, `to.peable.app.dev`) never reads,
 * moves or deletes anything in the shared group (oxy round-5 review R5-5,
 * core 7.35.0): the shared group has no dev variant, so what sits there under
 * the wallet's keys is the production wallet's — or planted. Its sources are
 * its own earlier group (`so.oxy.wallet.dev`) alone, its writes clear only
 * that copy, and its deletes name "own" and the earlier group and make no
 * unscoped call (on iOS that call reaches every entitled group, the shared
 * one included).
 *
 * The identity keys the wallet derives and signs with are NOT here: they are
 * Commons' (`spending-key`), read through `@oxy.so/core`'s KeyManager, which
 * stops falling back to the shared group once Commons' migration record is in
 * the wallet group, and which never lets the wallet write one.
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
  /** Where the wallet's items live and are written. */
  own: string;
  /** Where the previous native build kept them (the default group), if not `own`. */
  earlier: string | null;
  /** `null` on a development build: it never touches the shared group (R5-5). */
  shared: string | null;
}

/**
 * The outcome of this process's one move: `null` groups → the pre-split calls.
 * `sources` are the groups a no-marker fallback may still read, in order.
 */
type Setup = { groups: null } | { groups: Groups; moved: boolean; sources: string[] };

/** The groups that matter here, from core's plan, or `null` for the pre-split calls. */
async function groupsOf(resolveAccess: () => Promise<KeychainAccess>): Promise<Groups | null> {
  const access = await resolveAccess();
  const plan = ownKeychainItemPlan(access);
  const own = plan.write.accessGroup;
  const shared = keychainAccessGroupValue(access, 'shared');
  if (access.mode !== 'grouped' || !own || !shared || own === shared) return null;
  // The plan reads `own`, then the default group when it is not `own`, then `{}`.
  const earlier = plan.read
    .map((option) => option.accessGroup)
    .find((group) => group !== undefined && group !== own && group !== shared);
  return { own, earlier: earlier ?? null, shared: access.variant ? null : shared };
}

/** The groups other than `own` this build may read, clear or delete in, in order. */
function otherGroups(groups: Groups): string[] {
  return [groups.earlier, groups.shared].filter((g): g is string => g !== null);
}

/** Best effort: a write's superseded copies. Never throws. */
async function removeCopies(store: KeychainStore, key: string, groups: string[]): Promise<void> {
  for (const group of groups) {
    try {
      await store.deleteItemAsync(key, { accessGroup: group });
    } catch {
      // The marker stops it being read; the next write of this key tries again.
    }
  }
}

/**
 * Move one key into `own`: keep an own value (never overwrite), else copy the
 * first source's and read it back; then delete every source's copy and read
 * back its absence. `true` once no source holds anything under `key`. Never
 * throws.
 */
async function moveKey(
  store: KeychainStore,
  key: string,
  own: string,
  sources: string[],
): Promise<boolean> {
  try {
    const found: Array<{ group: string; value: string }> = [];
    for (const group of sources) {
      const value = await store.getItemAsync(key, { accessGroup: group });
      if (value !== null) found.push({ group, value });
    }
    const first = found[0];
    if (!first) return true;
    if ((await store.getItemAsync(key, { accessGroup: own })) === null) {
      await store.setItemAsync(key, first.value, { accessGroup: own });
      if ((await store.getItemAsync(key, { accessGroup: own })) !== first.value) return false;
    }
    for (const { group } of found) {
      await store.deleteItemAsync(key, { accessGroup: group });
      if ((await store.getItemAsync(key, { accessGroup: group })) !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Every group's value of `key`, in order. Throws when one cannot be read. */
async function valuesIn(store: KeychainStore, key: string, groups: string[]): Promise<string[]> {
  const values: string[] = [];
  for (const group of groups) {
    const value = await store.getItemAsync(key, { accessGroup: group });
    if (value !== null) values.push(value);
  }
  return values;
}

/** Whether `group` carries the move's marker. Throws when it cannot be read. */
async function hasMarker(store: KeychainStore, group: string): Promise<boolean> {
  return (await store.getItemAsync(KEYCHAIN_MOVE_MARKER, { accessGroup: group })) !== null;
}

/**
 * Where the wallet's items may still come from, in order: the earlier group,
 * and the shared group unless the earlier group's marker says the move out of
 * it already finished, or this is a development build (never the shared
 * group). Throws when the earlier marker cannot be read.
 */
async function sourcesOf(store: KeychainStore, groups: Groups): Promise<string[]> {
  if (!groups.shared) return groups.earlier ? [groups.earlier] : [];
  if (!groups.earlier) return [groups.shared];
  return (await hasMarker(store, groups.earlier))
    ? [groups.earlier]
    : [groups.earlier, groups.shared];
}

/**
 * The one move (see the module comment). `moved` when the marker exists in
 * `own` — found or written now — and `false` when this launch could not
 * finish. The marker reads decide what may be read at all, so a failure there
 * is the caller's (storage unavailable; the next call asks again); a failure
 * while moving is not: no marker, and the sources stay a read-only fallback.
 */
async function moveOnce(
  store: KeychainStore,
  groups: Groups,
): Promise<{ moved: boolean; sources: string[] }> {
  if (await hasMarker(store, groups.own)) return { moved: true, sources: [] };
  const sources = await sourcesOf(store, groups);
  try {
    // Which wallets' keys to move: every wallet any location's index names,
    // and any location's active wallet (an identity wallet is never indexed).
    const everywhere = [groups.own, ...sources];
    const indexes = await valuesIn(store, SECRET_KEYS.walletsIndex, everywhere);
    const active = await valuesIn(store, SECRET_KEYS.activeWallet, everywhere);
    const ids = [...indexes.flatMap(walletIdsOfIndex), ...active];
    let complete = true;
    for (const key of keychainMoveKeys(ids)) {
      if (!(await moveKey(store, key, groups.own, sources))) complete = false;
    }
    if (!complete) return { moved: false, sources };
    await store.setItemAsync(KEYCHAIN_MOVE_MARKER, '1', { accessGroup: groups.own });
    const moved =
      (await store.getItemAsync(KEYCHAIN_MOVE_MARKER, { accessGroup: groups.own })) === '1';
    return { moved, sources };
  } catch {
    return { moved: false, sources };
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
        return groups ? { groups, ...(await moveOnce(store, groups)) } : { groups: null };
      })();
      // The access probe or a marker read failed: the caller sees it, and the
      // next call asks again.
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
      const [earlier = null] = await valuesIn(store, key, s.sources);
      return touched.has(key) ? store.getItemAsync(key, { accessGroup: s.groups.own }) : earlier;
    },
    setItem: async (key, value) => {
      const s = await ready();
      if (!s.groups) return store.setItemAsync(key, value);
      touched.add(key);
      await store.setItemAsync(key, value, { accessGroup: s.groups.own });
      await removeCopies(store, key, otherGroups(s.groups));
    },
    deleteItem: async (key) => {
      const s = await ready();
      if (!s.groups) return store.deleteItemAsync(key);
      touched.add(key);
      // Every location by name — the app group is not the default group, so
      // the delete must not rest on what an unscoped query reaches — then the
      // unscoped delete it always made, except on a development build, where
      // it would reach the production wallet's copy in the shared group. A
      // thrown delete propagates.
      for (const group of [s.groups.own, ...otherGroups(s.groups)]) {
        await store.deleteItemAsync(key, { accessGroup: group });
      }
      if (s.groups.shared) await store.deleteItemAsync(key);
    },
  };
}
