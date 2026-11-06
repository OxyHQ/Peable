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
 * Nothing is taken from the SHARED group without proof that THIS app ran on
 * this phone before (security review round 6, R6-4): every Oxy app can write
 * that group, and without a marker — every fresh install — a malicious one
 * could pre-plant a wallet index, an active-wallet pointer and a phrase that
 * Peable would then open and offer for receiving. The proof is this app's own
 * sandbox, never a keychain group: the wallet databases (`fairwallet_<id>.db`)
 * the sandbox held when this build first looked, recorded once
 * (`InstallEvidence`, `kv-store.ts`). Then (`wallet-keys.ts`'s
 * `adoptableFromShared`): no evidence, nothing; a cached seed or the
 * pre-multi-wallet phrase, never; the index, the active-wallet pointer and
 * every per-wallet key only for a wallet with evidence; the PIN record and the
 * other single keys only with some evidence. Every shared-group read goes
 * through the injected non-prompting reader ({@link nonPromptingSharedRead}
 * over `@oxy.so/core`'s `readSharedWithoutInteraction`, i.e. `OxyIdentity`'s
 * `readKeychainItemWithoutInteraction`), so an item planted with
 * `requireAuthentication` never raises a Face ID prompt; a native build
 * without that reader never reads the shared group at all. A
 * wallet whose phrase or xpub WAS taken from the shared group is listed in
 * {@link KEYCHAIN_ADOPTED_WALLETS}, and offers nothing to receive into until
 * the person confirms it is theirs. What is not taken stays where it is.
 *
 * What this still cannot prove: on a phone that ran a pre-split build, an
 * item another Oxy app wrote over that build's own copy before the move
 * finished is indistinguishable from it — same key, same group, a wallet
 * with evidence. The receive gate above covers its phrase; the marker bounds
 * the window to the launches before the first complete move.
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
import type { KeychainStoreLike, readSharedWithoutInteraction } from '@oxy.so/core/session';
import {
  adoptableFromShared,
  type InstallEvidence,
  isWalletKey,
  KEYCHAIN_ADOPTED_WALLETS,
  KEYCHAIN_MOVE_MARKER,
  keychainMoveKeys,
  parseAdoptedWallets,
  SECRET_KEYS,
  walletIdsOfIndex,
  walletOfAdoptedSecret,
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

/** How the shared group may be read at all (R6-4). */
export interface SharedGroupPolicy {
  /**
   * Read `key` from `accessGroup` without ever prompting the user, or `null`
   * when this native build has no such read — the shared group is then never
   * read.
   */
  readonly readWithoutInteraction:
    | ((key: string, accessGroup: string) => Promise<string | null>)
    | null;
  /** This app's own evidence of an earlier install on this phone (never a keychain read). */
  readonly evidence: () => Promise<InstallEvidence>;
}

/**
 * The store core's `readSharedWithoutInteraction` falls back to on a native
 * module that predates `OxyIdentity.readKeychainItemWithoutInteraction`: it
 * answers nothing, so such a build reads nothing from the shared group rather
 * than going through expo-secure-store, whose read would prompt for an item
 * planted with `requireAuthentication`. Core never writes or deletes through it.
 */
const NO_PROMPTING_FALLBACK: KeychainStoreLike = {
  getItemAsync: async () => null,
  setItemAsync: async () => {
    throw new Error('The shared-group reader never writes.');
  },
  deleteItemAsync: async () => {
    throw new Error('The shared-group reader never deletes.');
  },
};

/**
 * {@link SharedGroupPolicy.readWithoutInteraction} over `@oxy.so/core`'s
 * `readSharedWithoutInteraction` (injected for tests): the native read that
 * never prompts and skips the `:auth` copy, and nothing at all on a build
 * without it. A thrown read (a locked keychain, services 14.14) propagates.
 */
export function nonPromptingSharedRead(
  readShared: typeof readSharedWithoutInteraction,
): (key: string, accessGroup: string) => Promise<string | null> {
  return (key, accessGroup) => readShared(NO_PROMPTING_FALLBACK, key, {}, { accessGroup });
}

interface Groups {
  /** Where the wallet's items live and are written. */
  own: string;
  /** Where the previous native build kept them (the default group), if not `own`. */
  earlier: string | null;
  /** `null` on a development build: it never touches the shared group (R5-5). */
  shared: string | null;
}

/** What a move or a fallback read needs: where to read, and how the shared group is judged. */
interface Context {
  store: KeychainStore;
  groups: Groups;
  /** The groups items may still come from, in order (never `own`). */
  sources: string[];
  policy: SharedGroupPolicy;
  evidence: InstallEvidence;
}

/**
 * The outcome of this process's one move: `null` groups → the pre-split calls.
 * `context.sources` are the groups a no-marker fallback may still read, in order.
 */
type Setup = { groups: null } | { groups: Groups; moved: boolean; context: Context };

const NO_EVIDENCE: InstallEvidence = { walletIds: new Set() };

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

/** The groups other than `own` this build may clear or delete in, in order. */
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
 * What `group` holds under `key` that may be taken: the shared group only
 * through the non-prompting reader and {@link adoptableFromShared}; any other
 * group as it is. Throws when the group cannot be read.
 */
async function readSource(ctx: Context, key: string, group: string): Promise<string | null> {
  if (group !== ctx.groups.shared) return ctx.store.getItemAsync(key, { accessGroup: group });
  const read = ctx.policy.readWithoutInteraction;
  if (!read) return null;
  const value = await read(key, group);
  return value === null ? null : adoptableFromShared(key, value, ctx.evidence);
}

/** Whether `group` still holds anything under `key` (the shared group read without prompting). */
async function stillHolds(ctx: Context, key: string, group: string): Promise<boolean> {
  if (group === ctx.groups.shared) {
    const read = ctx.policy.readWithoutInteraction;
    return read ? (await read(key, group)) !== null : false;
  }
  return (await ctx.store.getItemAsync(key, { accessGroup: group })) !== null;
}

/** The first source holding `key` that may be taken, with where it came from. */
async function firstSource(
  ctx: Context,
  key: string,
): Promise<{ group: string; value: string } | null> {
  for (const group of ctx.sources) {
    const value = await readSource(ctx, key, group);
    if (value !== null) return { group, value };
  }
  return null;
}

/** Add `walletId` to the adopted list in `own`, read back. Throws when it cannot be written. */
async function recordAdopted(ctx: Context, walletId: string): Promise<boolean> {
  const { store, groups } = ctx;
  const listed = parseAdoptedWallets(
    await store.getItemAsync(KEYCHAIN_ADOPTED_WALLETS, { accessGroup: groups.own }),
  );
  if (listed.includes(walletId)) return true;
  const value = JSON.stringify([...listed, walletId]);
  await store.setItemAsync(KEYCHAIN_ADOPTED_WALLETS, value, { accessGroup: groups.own });
  return (
    (await store.getItemAsync(KEYCHAIN_ADOPTED_WALLETS, { accessGroup: groups.own })) === value
  );
}

/**
 * Move one key into `own`: keep an own value (never overwrite), else copy the
 * first source's that may be taken and read it back — a phrase or xpub from
 * the shared group listed as adopted FIRST; then delete every source's copy
 * that was found and read back its absence. `true` once no source holds
 * anything under `key` that may be taken. Never throws.
 */
async function moveKey(ctx: Context, key: string): Promise<boolean> {
  const { store, groups } = ctx;
  try {
    const found: Array<{ group: string; value: string }> = [];
    for (const group of ctx.sources) {
      const value = await readSource(ctx, key, group);
      if (value !== null) found.push({ group, value });
    }
    const first = found[0];
    if (!first) return true;
    if ((await store.getItemAsync(key, { accessGroup: groups.own })) === null) {
      const adopted = first.group === groups.shared ? walletOfAdoptedSecret(key) : null;
      if (adopted !== null && !(await recordAdopted(ctx, adopted))) return false;
      await store.setItemAsync(key, first.value, { accessGroup: groups.own });
      if ((await store.getItemAsync(key, { accessGroup: groups.own })) !== first.value)
        return false;
    }
    for (const { group } of found) {
      await store.deleteItemAsync(key, { accessGroup: group });
      if (await stillHolds(ctx, key, group)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Every value of `key` that may be taken, own first then the sources. Throws when one cannot be read. */
async function valuesIn(ctx: Context, key: string): Promise<string[]> {
  const values: string[] = [];
  const own = await ctx.store.getItemAsync(key, { accessGroup: ctx.groups.own });
  if (own !== null) values.push(own);
  for (const group of ctx.sources) {
    const value = await readSource(ctx, key, group);
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
 * it already finished, this is a development build, this native build cannot
 * read it without prompting, or nothing proves this app ran here before
 * (R6-4). Throws when the earlier marker cannot be read.
 */
async function contextOf(
  store: KeychainStore,
  groups: Groups,
  policy: SharedGroupPolicy,
): Promise<Context> {
  const base: Context = { store, groups, sources: [], policy, evidence: NO_EVIDENCE };
  const earlier = groups.earlier ? [groups.earlier] : [];
  const sharedOpen =
    groups.shared !== null &&
    policy.readWithoutInteraction !== null &&
    !(groups.earlier && (await hasMarker(store, groups.earlier)));
  if (!sharedOpen || !groups.shared) return { ...base, sources: earlier };
  let evidence: InstallEvidence = NO_EVIDENCE;
  try {
    evidence = await policy.evidence();
  } catch {
    evidence = NO_EVIDENCE;
  }
  if (evidence.walletIds.size === 0) return { ...base, sources: earlier };
  return { ...base, sources: [...earlier, groups.shared], evidence };
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
  policy: SharedGroupPolicy,
): Promise<{ moved: boolean; context: Context }> {
  if (await hasMarker(store, groups.own)) {
    return {
      moved: true,
      context: { store, groups, sources: [], policy, evidence: NO_EVIDENCE },
    };
  }
  const context = await contextOf(store, groups, policy);
  try {
    // Which wallets' keys to move: every wallet any location's index names,
    // and any location's active wallet (an identity wallet is never indexed).
    const indexes = await valuesIn(context, SECRET_KEYS.walletsIndex);
    const active = await valuesIn(context, SECRET_KEYS.activeWallet);
    const ids = [...indexes.flatMap(walletIdsOfIndex), ...active];
    let complete = true;
    for (const key of keychainMoveKeys(ids)) {
      if (!(await moveKey(context, key))) complete = false;
    }
    if (!complete) return { moved: false, context };
    await store.setItemAsync(KEYCHAIN_MOVE_MARKER, '1', { accessGroup: groups.own });
    const moved =
      (await store.getItemAsync(KEYCHAIN_MOVE_MARKER, { accessGroup: groups.own })) === '1';
    return { moved, context };
  } catch {
    return { moved: false, context };
  }
}

/**
 * The SecureStore adapter Peable's `kv-store` uses on native. `resolveAccess`
 * is `@oxy.so/core`'s `resolveKeychainAccess` (injected for tests); off iOS it
 * answers `ungrouped`. `policy` says how the shared group may be read (R6-4).
 */
export function createGroupedKeychainAdapter(
  store: KeychainStore,
  resolveAccess: () => Promise<KeychainAccess>,
  policy: SharedGroupPolicy,
): KeyValueAdapter {
  let setup: Promise<Setup> | null = null;
  /** Keys this process wrote or deleted: the no-marker fallback never answers for them. */
  const touched = new Set<string>();
  /**
   * Wallets a no-marker fallback answered a phrase or xpub for from the
   * shared group this launch: adopted, unconfirmed, though nothing was copied.
   */
  const fallbackAdopted = new Set<string>();

  function ready(): Promise<Setup> {
    if (!setup) {
      const pending = (async (): Promise<Setup> => {
        const groups = await groupsOf(resolveAccess);
        return groups ? { groups, ...(await moveOnce(store, groups, policy)) } : { groups: null };
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
      if (key === KEYCHAIN_ADOPTED_WALLETS && fallbackAdopted.size > 0) {
        return JSON.stringify([...new Set([...parseAdoptedWallets(own), ...fallbackAdopted])]);
      }
      if (own !== null || s.moved || touched.has(key) || !isWalletKey(key)) return own;
      // No marker yet (this launch's move failed): read, never copy.
      const source = await firstSource(s.context, key);
      if (touched.has(key)) return store.getItemAsync(key, { accessGroup: s.groups.own });
      if (source && source.group === s.groups.shared) {
        const adopted = walletOfAdoptedSecret(key);
        if (adopted !== null) fallbackAdopted.add(adopted);
      }
      return source?.value ?? null;
    },
    setItem: async (key, value) => {
      const s = await ready();
      if (!s.groups) return store.setItemAsync(key, value);
      touched.add(key);
      await store.setItemAsync(key, value, { accessGroup: s.groups.own });
      if (key === KEYCHAIN_ADOPTED_WALLETS) {
        const kept = new Set(parseAdoptedWallets(value));
        for (const id of [...fallbackAdopted]) if (!kept.has(id)) fallbackAdopted.delete(id);
      }
      await removeCopies(store, key, otherGroups(s.groups));
    },
    deleteItem: async (key) => {
      const s = await ready();
      if (!s.groups) return store.deleteItemAsync(key);
      touched.add(key);
      if (key === KEYCHAIN_ADOPTED_WALLETS) fallbackAdopted.clear();
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
