/**
 * Derive the next receive address of a destination Pocket (BIP44 account) so a
 * Pocket-to-Pocket move can send to it. Pure: builds a KeyManager for the
 * destination account from the shared seed, advances it to the destination's
 * next-unused external index, and returns that address. The move itself is an
 * ordinary on-chain self-transfer handled by `wallet-store.sendTransaction`.
 */

import type { NetworkConfig } from "@fairco.in/core";
import { KeyManager, type DerivedAddress } from "@peable.to/pay";

export function resolveMoveDestinationAddress(
  seed: Uint8Array,
  network: NetworkConfig,
  account: number,
  nextUnusedIndex: number,
): DerivedAddress {
  const manager = KeyManager.fromSeed(seed, network, account);
  // Advance the external cursor to the destination Pocket's next unused index so
  // getNextAddress() returns exactly that address (and pre-derives the lookahead
  // window for the destination's Bloom filter after it syncs).
  manager.restoreCursors(nextUnusedIndex, 0);
  return manager.getNextAddress();
}
