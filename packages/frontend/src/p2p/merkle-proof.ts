/**
 * Partial Merkle tree (BIP37) proof validation for `merkleblock` messages.
 *
 * Given a {@link MerkleBlockMsg} (the block header plus a depth-first list of
 * flag bits and a list of node hashes), this reconstructs the partial Merkle
 * tree, recomputes the Merkle root, and returns the transaction hashes whose
 * inclusion the proof attests to. The computed root MUST equal the header's
 * `merkleRoot` or the proof is rejected.
 *
 * Extracted from the SPV client into its own pure module so the security
 * checks (root match, full consumption of flag bits and hashes) are directly
 * unit-testable without a running peer connection.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesEqual } from "@fairco.in/core";
import type { MerkleBlockMsg } from "./messages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(64);
  combined.set(left, 0);
  combined.set(right, 32);
  return sha256(sha256(combined));
}

/**
 * Number of nodes at a given height of the Merkle tree (height 0 = the leaves).
 * Identical to Bitcoin Core's `CPartialMerkleTree::CalcTreeWidth`.
 */
export function calcTreeWidth(totalTransactions: number, height: number): number {
  return (totalTransactions + (1 << height) - 1) >> height;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a Merkle proof from a `merkleblock` message and return the matched
 * transaction hashes (in internal/wire byte order, as they appear in the tree).
 *
 * Throws if:
 *  - the recomputed Merkle root does not match the header's `merkleRoot`;
 *  - the proof references more hashes than the tree can use, or leaves some
 *    provided hashes unused;
 *  - the proof contains trailing flag bits beyond what the traversal consumed
 *    (more than the byte-alignment padding), or a padding bit is set.
 *
 * The trailing-bit / leftover-hash checks mirror Bitcoin Core's
 * `CPartialMerkleTree::ExtractMatches`: a well-formed proof consumes every
 * hash and every flag bit (modulo the zero padding in the final flag byte).
 * A malicious peer that pads extra bits or hashes is rejected rather than
 * silently tolerated (SPV_AUDIT.md §4.6).
 */
export function validateMerkleProof(merkleBlock: MerkleBlockMsg): Uint8Array[] {
  const { totalTransactions, hashes, flags } = merkleBlock;
  const matchedTxHashes: Uint8Array[] = [];

  if (totalTransactions === 0) {
    // An empty tree carries no hashes and no meaningful flag bits.
    if (hashes.length !== 0) {
      throw new Error("Merkle proof invalid: hashes present for empty tree");
    }
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] !== 0) {
        throw new Error("Merkle proof invalid: flag bits set for empty tree");
      }
    }
    return matchedTxHashes;
  }

  // Tree height measured from the bottom: leaves are at height 0, the root at
  // `height`. This matches Bitcoin Core's `CPartialMerkleTree`.
  let height = 0;
  while (calcTreeWidth(totalTransactions, height) > 1) {
    height++;
  }

  let bitsUsed = 0;
  let hashIndex = 0;

  function getBit(): boolean {
    const byteIdx = bitsUsed >>> 3;
    const bitIdx = bitsUsed & 7;
    bitsUsed++;
    if (byteIdx >= flags.length) {
      // Running off the end of the flag bytes is itself a malformed proof.
      throw new Error("Merkle proof invalid: ran out of flag bits");
    }
    return (flags[byteIdx] & (1 << bitIdx)) !== 0;
  }

  function getHash(): Uint8Array {
    if (hashIndex >= hashes.length) {
      throw new Error("Merkle proof invalid: ran out of hashes");
    }
    const h = hashes[hashIndex];
    hashIndex++;
    return h;
  }

  // `nodeHeight` is the height of the node from the bottom; `pos` its index
  // within that level. Mirrors Core's `TraverseAndExtract`.
  function traverse(nodeHeight: number, pos: number): Uint8Array {
    const isParentOfMatch = getBit();

    if (nodeHeight === 0 || !isParentOfMatch) {
      // Leaf, or an internal node whose subtree contains no match: its hash is
      // provided directly in the proof.
      const h = getHash();
      if (nodeHeight === 0 && isParentOfMatch) {
        // A matched leaf: record the txid (in tree/internal byte order).
        matchedTxHashes.push(h);
      }
      return h;
    }

    // Internal node on the match path — recurse to obtain child hashes.
    const left = traverse(nodeHeight - 1, pos * 2);
    let right: Uint8Array;
    if (pos * 2 + 1 < calcTreeWidth(totalTransactions, nodeHeight - 1)) {
      right = traverse(nodeHeight - 1, pos * 2 + 1);
      if (bytesEqual(left, right)) {
        // Bitcoin disallows a node whose two children are identical: it is the
        // signature of the CVE-2012-2459 duplicate-txid Merkle malleability.
        throw new Error("Merkle proof invalid: duplicate child hashes");
      }
    } else {
      // Odd number of nodes at this level: the last node is duplicated.
      right = left;
    }

    return hashPair(left, right);
  }

  const computedRoot = traverse(height, 0);

  // All provided hashes must be consumed (no dangling extra hashes).
  if (hashIndex !== hashes.length) {
    throw new Error("Merkle proof invalid: unused hashes remain");
  }

  // All flag bits must be consumed except the zero padding that rounds the bit
  // stream up to a whole number of bytes. Any extra trailing byte, or a set
  // padding bit, indicates a malformed/padded proof.
  const usedFlagBytes = (bitsUsed + 7) >>> 3;
  if (usedFlagBytes !== flags.length) {
    throw new Error("Merkle proof invalid: trailing flag bytes");
  }
  for (let bit = bitsUsed; bit < usedFlagBytes * 8; bit++) {
    const byteIdx = bit >>> 3;
    const bitIdx = bit & 7;
    if ((flags[byteIdx] & (1 << bitIdx)) !== 0) {
      throw new Error("Merkle proof invalid: trailing flag bits set");
    }
  }

  if (!bytesEqual(computedRoot, merkleBlock.merkleRoot)) {
    throw new Error("Merkle proof validation failed: root mismatch");
  }

  return matchedTxHashes;
}
