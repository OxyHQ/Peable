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
 * Preferences (Pockets, the active Pocket, notification subscription) follow
 * the proving account; it keeps its own where it already has them. Contacts
 * and recent recipients name nobody's keys and move with the file.
 *
 * Pure decisions here; the moves themselves are `wallet-store.ts`'s.
 */
import { canonicalKey, canonicalKeySet } from './previous-keys';

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
