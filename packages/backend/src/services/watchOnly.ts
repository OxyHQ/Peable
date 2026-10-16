import { getNetwork, type NetworkType } from '@fairco.in/core';
import { deriveIntentAddress } from './derivation';

/**
 * Raised when the extended key handed in is not a spend-incapable watch-only
 * key. Callers translate it into the `watch-only violation` refusal.
 */
export class WatchOnlyViolationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'invalid watch-only xpub');
    this.name = 'WatchOnlyViolationError';
  }
}

/**
 * The non-custody firewall — ONE implementation for every key this gateway
 * stores: a merchant's own (`insertMerchant`) and a seller's
 * (`registerFaircoinKey`, ADR 0012 D4).
 *
 * ## Read this before touching either writer
 *
 * The repository AGENTS.md calls this "the legal firewall": if anyone ever
 * hands over an `xprv`, the gateway refuses it rather than silently gaining the
 * ability to spend their funds.
 *
 * A schema has no hooks. There is no CHECK constraint that can express it
 * either — deciding it requires deriving a child key, which is a secp256k1
 * operation and not something SQL can perform. So the guarantee is "true of
 * every write that goes through the single writer of each `xpub` column", and
 * both writers call this before they write.
 *
 * Deriving index 0 with `network`'s version bytes also proves the key belongs
 * to that chain: a testnet key on a mainnet account fails with `Version
 * mismatch`, which is the correct refusal.
 *
 * Nothing fails if a call is removed — every other test hands in a valid xpub —
 * which is why each writer has a test that hands in a real PRIVATE extended key.
 */
export function assertWatchOnly(xpub: string, network: NetworkType): void {
  try {
    // Deriving index 0 proves the key is usable AND public-only:
    // `deriveIntentAddress` throws on an extended key carrying a private key.
    deriveIntentAddress(xpub, 0, 0, getNetwork(network));
  } catch (error) {
    throw new WatchOnlyViolationError(error);
  }
}
