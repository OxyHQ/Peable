/**
 * Which identity key an identity wallet opens with (security review round 5,
 * R5-1; Peable ADR 0002, amended for round 5).
 *
 * A Peable identity wallet is a function of ONE public key: its HD tree
 * derives from `deriveScopedSeed(PEABLE_SEED_INFO, { publicKey })` and its
 * social-receive addresses from the key itself. Which key that is must never
 * be read from a store another app can write. The unselected key read
 * (`KeyManager.getSharedPublicKey`) takes the iOS keychain group every Oxy app
 * shares, so a malicious or OTA-compromised Oxy app could plant its own key
 * there and the Receive sheet would show the attacker's address.
 *
 * So the key is DECIDED here, from what the account says, and possession is
 * proven by the selector: `derive(key)` is `deriveScopedSeed` with `publicKey`
 * set, which reaches only the key it names and answers `null` for any other —
 * a seed for a key the account names is proof this device holds that key's
 * private half. The candidates, in order:
 *
 *   1. the account's current key (`#key-1`) as Oxy answers it now: `current`
 *   2. the key this wallet last opened with, stored in its OWN database (an
 *      app-private file, never a keychain group), and only while the account's
 *      history still names it: `held`
 *   3. the key this device says it holds (`deviceHint`, the untrusted read),
 *      only when the account's history names it: `held`
 *
 * Offline (`accountKeys` `null`), only the stored key opens: it was vouched by
 * the account when it was stored. Nothing else ever does — a wallet with no
 * vouched key does not open, rather than open on a key nobody vouched for.
 *
 * Only a `null` derivation means "not held here" (core 7.40.0, R7-4). A
 * derivation that THROWS — `IdentityUnavailableError` while the keychain is
 * locked or Commons is busy, or anything else — is no answer: the decision
 * stops at once as `unavailable` and is asked again later. It never moves on
 * to the next candidate, which would open a held previous key as `replaced`
 * (social receive off) while the current key is merely locked, and it never
 * reads as `not-held` (the "set up your Oxy ID" screen).
 *
 * Receiving is a SEPARATE, later gate (`wallet-store.ts`'s
 * `syncSocialReceiveSet`): nothing receivable is shown until the gateway's
 * fresh answer for `#key-1` equals the open key.
 */
import { canonicalKey, canonicalKeySet } from './previous-keys';

/** The account's keys, as Oxy answers them now. */
export interface AccountKeys {
  /** `#key-1`, any encoding; `null` for an account that publishes none. */
  readonly current: string | null;
  /** Every key the account has had, the current one included, canonical. */
  readonly history: ReadonlySet<string>;
}

export type IdentityKeyDecision =
  /** The account's current key, held here. */
  | { readonly kind: 'current'; readonly key: string; readonly seed: Uint8Array }
  /**
   * A key the account vouches for (its history, or the wallet's own stored key
   * while offline) that is not — or not known to be — its current one.
   * Spendable; never receivable until the gateway says it is `#key-1`.
   */
  | {
      readonly kind: 'held';
      readonly key: string;
      readonly seed: Uint8Array;
      readonly reason: 'replaced' | 'offline';
    }
  /**
   * No key opens: `unverified` — Oxy could not be asked and this wallet has no
   * stored key; `not-held` — no key the account vouches for is on this device;
   * `unavailable` — a key could not be read NOW (locked keychain, busy
   * Commons): try again later, nothing about the wallet changed.
   */
  | {
      readonly kind: 'none';
      readonly reason: 'unverified' | 'not-held' | 'unavailable';
    };

export interface IdentityKeyDeps {
  /** The account's keys now, or `null` when they cannot be read. */
  readonly accountKeys: AccountKeys | null;
  /** The key this wallet last opened with, from its own database, or `null`. */
  readonly storedKey: string | null;
  /**
   * The key this device says it holds (untrusted), or `null`. Read lazily. A
   * throw is "cannot tell now", like a derivation's.
   */
  readonly deviceHint: () => Promise<string | null>;
  /**
   * `deriveScopedSeed` selecting `key`: `null` when this device DEFINITIVELY
   * does not hold it; throws (`IdentityUnavailableError`) when it cannot tell now.
   */
  readonly derive: (key: string) => Promise<Uint8Array | null>;
}

const UNAVAILABLE: IdentityKeyDecision = { kind: 'none', reason: 'unavailable' };

/** A read that threw: the decision stops here, and is asked again later. */
class Unavailable {
  constructor(readonly error: unknown) {}
}

async function attempt<T>(read: () => Promise<T>): Promise<T | Unavailable> {
  try {
    return await read();
  } catch (error) {
    return new Unavailable(error);
  }
}

function logUnavailable(error: unknown): IdentityKeyDecision {
  console.warn('[identity-key] a key could not be read now; asking again later:', error);
  return UNAVAILABLE;
}

export async function decideIdentityKey(deps: IdentityKeyDeps): Promise<IdentityKeyDecision> {
  const stored = canonicalKey(deps.storedKey);
  const accountKeys = deps.accountKeys;
  if (accountKeys === null) {
    if (stored === null) return { kind: 'none', reason: 'unverified' };
    const seed = await attempt(() => deps.derive(stored));
    if (seed instanceof Unavailable) return logUnavailable(seed.error);
    return seed
      ? { kind: 'held', key: stored, seed, reason: 'offline' }
      : { kind: 'none', reason: 'not-held' };
  }

  const current = canonicalKey(accountKeys.current);
  if (current !== null) {
    const seed = await attempt(() => deps.derive(current));
    // The current key may be here, only locked: never try a previous key in its place.
    if (seed instanceof Unavailable) return logUnavailable(seed.error);
    if (seed) return { kind: 'current', key: current, seed };
  }
  const history = canonicalKeySet([...accountKeys.history]);
  const tried = new Set<string>(current === null ? [] : [current]);
  const consider = async (key: string | null): Promise<IdentityKeyDecision | null> => {
    if (key === null || tried.has(key) || !history.has(key)) return null;
    tried.add(key);
    const seed = await attempt(() => deps.derive(key));
    if (seed instanceof Unavailable) return logUnavailable(seed.error);
    return seed ? { kind: 'held', key, seed, reason: 'replaced' } : null;
  };
  const fromStored = await consider(stored);
  if (fromStored) return fromStored;
  const hint = await attempt(deps.deviceHint);
  if (hint instanceof Unavailable) return logUnavailable(hint.error);
  const fromHint = await consider(canonicalKey(hint));
  if (fromHint) return fromHint;
  return { kind: 'none', reason: 'not-held' };
}
