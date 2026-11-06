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
 * Pure decisions here; the moves themselves are `wallet-store.ts`'s.
 */
import { canonicalKey } from './previous-keys';

/**
 * The kv-store item recording the move: `{ "boundTo": id }`, `{ "empty": true }`
 * (nothing to move), or `{ "checked": [ids] }`.
 */
export interface LegacyNamespaceMarker {
  /** The legacy namespace held no wallet: nothing to move, for anyone. */
  readonly empty?: true;
  /** The account the legacy namespace moved to; absent while it has not moved. */
  readonly boundTo?: string;
  /** Accounts that tried and could not prove it theirs. */
  readonly checked?: readonly string[];
}

export function parseLegacyNamespaceMarker(raw: string | null): LegacyNamespaceMarker {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { boundTo, checked, empty } = parsed as {
      boundTo?: unknown;
      checked?: unknown;
      empty?: unknown;
    };
    return {
      ...(empty === true ? { empty: true as const } : {}),
      ...(typeof boundTo === 'string' && boundTo.length > 0 ? { boundTo } : {}),
      ...(Array.isArray(checked)
        ? { checked: checked.filter((id): id is string => typeof id === 'string') }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * What to do with the legacy namespace for `accountId`: `skip` when it has
 * moved (to anyone) or this account already failed to prove it; `prove`
 * otherwise.
 */
export function legacyNamespaceStep(
  marker: LegacyNamespaceMarker,
  accountId: string,
): 'skip' | 'prove' {
  if (marker.boundTo !== undefined || marker.empty === true) return 'skip';
  if (marker.checked?.includes(accountId)) return 'skip';
  return 'prove';
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
 * proving account has had. A row without a key stays (it is watched only when
 * a vouched key derives its address); a key that does not parse goes.
 */
export function keepsLegacyKey(
  storedKey: string | null,
  accountHistory: ReadonlySet<string>,
): boolean {
  if (storedKey === null) return true;
  const canonical = canonicalKey(storedKey);
  return canonical !== null && accountHistory.has(canonical);
}
