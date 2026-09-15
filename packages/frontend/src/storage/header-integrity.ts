/**
 * One-time repair of a header store written by a broken hash implementation.
 *
 * `@fairco.in/core` 0.2.0–0.3.1 computed the wrong Quark id for every block. A
 * wallet that synced against one of those builds holds headers keyed by bogus
 * hashes, and once the correct hash is restored no incoming header's
 * `prevBlock` can ever match the stored tip — so sync stalls silently and
 * permanently.
 *
 * The check is versioned and lives beside the schema migrations rather than in
 * the SPV client, for two reasons. It is a property of what is *on disk*, so
 * the client should be able to assume it starts against a coherent store. And
 * a persisted version means it runs once per algorithm change instead of
 * re-hashing the tip on every launch forever, with no way to ever retire it.
 */

import { hashBlockHeader, bytesEqual } from "@fairco.in/core";
import type { BlockHeaderRow } from "./database";

/**
 * Bump when the header hash function changes. Stores written under an older
 * version are re-verified once; a mismatch wipes them for a clean re-sync.
 */
export const HEADER_HASH_VERSION = 1;

/** Whether a stored header still hashes to the id recorded alongside it. */
export function headerMatchesItsHash(row: BlockHeaderRow): boolean {
  const recomputed = hashBlockHeader({
    version: row.version,
    prevHash: row.prev_hash,
    merkleRoot: row.merkle_root,
    timestamp: row.timestamp,
    bits: row.bits,
    nonce: row.nonce,
  });
  return bytesEqual(recomputed, row.hash);
}

/**
 * Decide what to do with a store at `storedVersion`, given its tip.
 *
 * Genesis is seeded from network config rather than hashed, so a store holding
 * only genesis proves nothing either way and is left alone.
 */
export function planHeaderRepair(
  storedVersion: number,
  tip: BlockHeaderRow | null,
): "up-to-date" | "verified" | "wipe" {
  if (storedVersion >= HEADER_HASH_VERSION) return "up-to-date";
  if (!tip || tip.height === 0) return "verified";
  return headerMatchesItsHash(tip) ? "verified" : "wipe";
}
