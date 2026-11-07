/**
 * The move of the legacy shared identity wallet to the account it belongs to
 * (security review round 5, R5-2; Peable ADR 0002, amended for round 5).
 *
 * Before round 5 every person's identity wallet on a phone was ONE SQLite
 * namespace, `oxy-identity`, whoever was signed in. After A rotated and B
 * signed in on the same phone, B's wallet opened A's stored previous-key trees
 * and social-receive rows, and could move A's old-key coins. Each person's
 * wallet is now `oxy-user-<accountId>` (`identity-wallet.ts`), and the legacy
 * namespace is moved ONCE to the account it is PROVEN to belong to:
 *
 * - the proof is the HD tree: the legacy database stores the receive and
 *   change addresses it derived, and only a key whose seed derives one of
 *   them made it. The candidate keys are the signing-in account's current
 *   key and its key history, as Oxy answers them now, that this device holds
 *   (`deriveScopedSeed` selecting each) — never a key another app planted;
 * - a namespace no candidate proves stays CLOSED for this account (another
 *   account on this phone may still prove it), and nothing in it is read;
 * - what the namespace inherited that another account could have put there
 *   is dropped on the way: social-receive rows and previous-key trees under a
 *   key the proving account never had, and the pull's cursor (the full set is
 *   read again from the gateway, which answers for the session's account).
 *
 * Round 6 (R6-2, R6-6, R6-7):
 *
 * - the moved namespace keeps only what the proving account's keys derive
 *   (`Database.keepOnlyOwnerData`): HD addresses of its current and vouched
 *   previous keys this device holds, the coins at them and their history —
 *   another account's rows, coins and transactions are dropped (the coins
 *   stay on chain; a rescan finds what was the owner's);
 * - an account is recorded as `checked` only after a DEFINITE answer for
 *   every candidate key (a derivation that throws is no answer), and with the
 *   key history and retired ring it was checked against: when either
 *   changes — a rotation, a previous phrase added in Commons — it is asked
 *   again. Settings offers the same check on demand ("Recover an earlier
 *   wallet"), and removing the legacy data from the phone once the person
 *   confirms it is not theirs;
 * - a check made after the account's own wallet was already in use MERGES
 *   into it (`Database.mergeFrom`, nothing it holds is replaced) instead of
 *   copying over it;
 * - every move runs in the wallet's init queue, one at a time.
 *
 * Round 7 (R7-6): each candidate tree is derived generously before judging
 * what stays — past the highest stored index of EITHER chain and every
 * previous-key tree's cursor by {@link LEGACY_WINDOW_MARGIN}, then walked over
 * every stored row and coin address with the gap (as
 * `advanceTreeOverKnownAddresses` does) — so a change address past index 9,
 * or a previous key's coin beyond its first window, is the owner's and stays.
 * Multisig watch rows whose redeem script names one of the owner's keys stay
 * too.
 *
 * Preferences (Pockets, the active Pocket, notification subscription) follow
 * the proving account; it keeps its own where it already has them. Contacts
 * and recent recipients name nobody's keys and move with the file.
 *
 * Pure decisions here; the moves themselves are `wallet-store.ts`'s.
 */
import { advanceTreeOverKnownAddresses, canonicalKey, canonicalKeySet } from './previous-keys';

/**
 * The kv-store item recording the move: `{ "boundTo": id }`, `{ "empty": true }`
 * (nothing to move), `{ "removed": true }` (the person removed it), or
 * `{ "checked": { [id]: fingerprint } }`.
 */
export interface LegacyNamespaceMarker {
  /** The legacy namespace held no wallet: nothing to move, for anyone. */
  readonly empty?: true;
  /** The person removed the legacy data from this phone (R6, info). */
  readonly removed?: true;
  /** The account the legacy namespace moved to; absent while it has not moved. */
  readonly boundTo?: string;
  /**
   * Accounts that DEFINITELY could not prove it theirs, each with the
   * fingerprint ({@link legacyCheckFingerprint}) of the keys it was checked
   * against (R6-6). The round-5 list form recorded checks that may not have
   * been definite, and is read as no check at all.
   */
  readonly checked?: Readonly<Record<string, string>>;
}

export function parseLegacyNamespaceMarker(raw: string | null): LegacyNamespaceMarker {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { boundTo, checked, empty, removed } = parsed as {
      boundTo?: unknown;
      checked?: unknown;
      empty?: unknown;
      removed?: unknown;
    };
    const checks: Record<string, string> = {};
    if (typeof checked === 'object' && checked !== null && !Array.isArray(checked)) {
      for (const [id, fingerprint] of Object.entries(checked)) {
        if (typeof fingerprint === 'string') checks[id] = fingerprint;
      }
    }
    return {
      ...(empty === true ? { empty: true as const } : {}),
      ...(removed === true ? { removed: true as const } : {}),
      ...(typeof boundTo === 'string' && boundTo.length > 0 ? { boundTo } : {}),
      ...(Object.keys(checks).length > 0 ? { checked: checks } : {}),
    };
  } catch {
    return {};
  }
}

/** Whether the legacy namespace is gone for everyone: moved, empty or removed. */
export function legacyNamespaceClosed(marker: LegacyNamespaceMarker): boolean {
  return marker.boundTo !== undefined || marker.empty === true || marker.removed === true;
}

/**
 * What the account's check is judged against (R6-6): its key history as Oxy
 * answers it and the retired ring Commons lists for it, canonical and sorted.
 * A new key in either can make a check that failed succeed.
 */
export function legacyCheckFingerprint(
  history: Iterable<string | null>,
  ring: Iterable<string | null>,
): string {
  const sorted = (keys: Iterable<string | null>) => [...canonicalKeySet([...keys])].sort();
  return `h:${sorted(history).join(',')}|r:${sorted(ring).join(',')}`;
}

/**
 * What to do with the legacy namespace for `accountId`: `skip` when it has
 * moved (to anyone), is empty or removed, or this account definitely failed
 * to prove it against the same keys; `prove` otherwise.
 */
export function legacyNamespaceStep(
  marker: LegacyNamespaceMarker,
  accountId: string,
  fingerprint: string,
): 'skip' | 'prove' {
  if (legacyNamespaceClosed(marker)) return 'skip';
  if (marker.checked?.[accountId] === fingerprint) return 'skip';
  return 'prove';
}

/** The marker after a definite failed check of `accountId` against `fingerprint`. */
export function markLegacyChecked(
  marker: LegacyNamespaceMarker,
  accountId: string,
  fingerprint: string,
): LegacyNamespaceMarker {
  return { ...marker, checked: { ...(marker.checked ?? {}), [accountId]: fingerprint } };
}

/** A candidate key and the HD addresses its seed derives (receive and change windows). */
export interface CandidateTree {
  readonly key: string;
  readonly addresses: readonly string[];
}

/**
 * The candidate key whose HD tree derived an address the legacy database
 * stores, or `null` when none did. A candidate is a key the signing-in account
 * vouches for AND this device holds; the legacy addresses are the database's
 * own `addresses` rows (derived from a seed, so only that seed's key matches).
 */
export function proveLegacyOwnership(
  legacyAddresses: ReadonlySet<string>,
  candidates: readonly CandidateTree[],
): string | null {
  for (const candidate of candidates) {
    if (candidate.addresses.some((address) => legacyAddresses.has(address))) {
      return canonicalKey(candidate.key);
    }
  }
  return null;
}

/**
 * Whether a stored row's key may stay in the moved namespace: a key the
 * proving account has had. A key that does not parse goes. (A keyless row is
 * judged by whether one of those keys derives it.)
 */
export function keepsLegacyKey(storedKey: string, accountHistory: ReadonlySet<string>): boolean {
  const canonical = canonicalKey(storedKey);
  return canonical !== null && accountHistory.has(canonical);
}

/** The highest stored index of each chain, for a tree that must derive every stored row. */
export function highestStoredIndices(rows: readonly { index_num: number; is_change: number }[]): {
  external: number;
  change: number;
} {
  let external = -1;
  let change = -1;
  for (const row of rows) {
    if (row.is_change) change = Math.max(change, row.index_num);
    else external = Math.max(external, row.index_num);
  }
  return { external, change };
}

/** How far past everything a legacy Pocket stores each candidate tree is derived (R7-6). */
export const LEGACY_WINDOW_MARGIN = 50;

/**
 * The cursors a candidate tree of `key` is restored to before judging a
 * legacy Pocket (R7-6): past the highest stored index of either chain (the
 * rows of every key are mixed, so either chain's highest bounds both) and
 * `key`'s own previous-key tree cursors on any network, plus
 * {@link LEGACY_WINDOW_MARGIN}. The caller then walks the gap over every
 * stored row and coin address.
 */
export function legacyTreeReach(
  facts: {
    readonly rows: readonly { index_num: number; is_change: number }[];
    readonly trees: readonly { public_key: string; external_next: number; change_next: number }[];
  },
  key: string,
): { externalNext: number; changeNext: number } {
  const { external, change } = highestStoredIndices(facts.rows);
  let highest = Math.max(external, change);
  const canonical = canonicalKey(key);
  for (const tree of facts.trees) {
    if (canonical === null || canonicalKey(tree.public_key) !== canonical) continue;
    highest = Math.max(highest, tree.external_next - 1, tree.change_next - 1);
  }
  const reach = highest + 1 + LEGACY_WINDOW_MARGIN;
  return { externalNext: reach, changeNext: reach };
}

/**
 * Derive a candidate tree of `key` over a legacy Pocket (R7-6): to
 * {@link legacyTreeReach}, then over every stored row and coin address with
 * the gap, so whatever of the Pocket that tree made is in its window.
 */
export function reachLegacyPocket(
  tree: {
    restoreCursors(externalNext: number, changeNext: number): void;
    ownsAddress(address: string): boolean;
    markAddressUsed(address: string): boolean;
  },
  facts: {
    readonly rows: readonly { address: string; index_num: number; is_change: number }[];
    readonly coinAddresses: readonly string[];
    readonly trees: readonly { public_key: string; external_next: number; change_next: number }[];
  },
  key: string,
): void {
  const reach = legacyTreeReach(facts, key);
  tree.restoreCursors(reach.externalNext, reach.changeNext);
  advanceTreeOverKnownAddresses(tree, [
    ...facts.rows.map((row) => row.address),
    ...facts.coinAddresses,
  ]);
}
