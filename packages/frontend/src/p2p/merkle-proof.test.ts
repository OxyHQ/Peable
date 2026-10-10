/**
 * Tests for BIP37 partial-Merkle-tree proof validation.
 *
 * Covers SPV_AUDIT.md §4.6: the validator must reject proofs that carry trailing
 * flag bits or unused hashes (a misbehaving peer padding the proof), in addition
 * to the obvious root-mismatch rejection.
 *
 * A correct partial Merkle tree is built here (the inverse of the validator) so
 * the positive cases use genuinely well-formed proofs rather than hand-rolled
 * byte blobs.
 */

import { describe, test, expect } from 'bun:test';
import { sha256 } from '@noble/hashes/sha256';
import { validateMerkleProof, calcTreeWidth } from './merkle-proof';
import type { MerkleBlockMsg } from './messages';

// ---------------------------------------------------------------------------
// Partial-Merkle-tree builder (BIP37) — the inverse of the validator, using
// Bitcoin Core's exact convention (height 0 = leaves, `CalcTreeWidth`).
// ---------------------------------------------------------------------------

function doubleSha(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(64);
  c.set(a, 0);
  c.set(b, 32);
  return sha256(sha256(c));
}

function fullTreeHeight(total: number): number {
  let h = 0;
  while (calcTreeWidth(total, h) > 1) {
    h++;
  }
  return h;
}

/** Hash of the node at (height, pos), with Core's odd-node duplication rule. */
function nodeHash(height: number, pos: number, txids: Uint8Array[]): Uint8Array {
  if (height === 0) {
    return txids[pos];
  }
  const left = nodeHash(height - 1, pos * 2, txids);
  const right =
    pos * 2 + 1 < calcTreeWidth(txids.length, height - 1)
      ? nodeHash(height - 1, pos * 2 + 1, txids)
      : left;
  return doubleSha(left, right);
}

interface BuiltProof {
  root: Uint8Array;
  hashes: Uint8Array[];
  flagBits: boolean[];
}

/**
 * Build a partial Merkle tree proving the inclusion of the txids at the given
 * matched indices. Mirrors Bitcoin Core's `CPartialMerkleTree::TraverseAndBuild`.
 */
function buildPartialMerkleTree(txids: Uint8Array[], matched: Set<number>): BuiltProof {
  const total = txids.length;
  const top = fullTreeHeight(total);
  const hashes: Uint8Array[] = [];
  const flagBits: boolean[] = [];

  // Whether the subtree rooted at (height, pos) contains a matched leaf.
  function subtreeMatches(height: number, pos: number): boolean {
    if (height === 0) {
      return matched.has(pos);
    }
    if (subtreeMatches(height - 1, pos * 2)) return true;
    if (pos * 2 + 1 < calcTreeWidth(total, height - 1) && subtreeMatches(height - 1, pos * 2 + 1)) {
      return true;
    }
    return false;
  }

  function traverse(height: number, pos: number): void {
    const isParentOfMatch = subtreeMatches(height, pos);
    flagBits.push(isParentOfMatch);
    if (height === 0 || !isParentOfMatch) {
      // Leaf, or an internal node off the match path: emit its hash directly.
      hashes.push(nodeHash(height, pos, txids));
      return;
    }
    // Internal node on the match path: recurse, emit no hash here.
    traverse(height - 1, pos * 2);
    if (pos * 2 + 1 < calcTreeWidth(total, height - 1)) {
      traverse(height - 1, pos * 2 + 1);
    }
  }

  traverse(top, 0);
  return { root: nodeHash(top, 0, txids), hashes, flagBits };
}

function flagsToBytes(bits: boolean[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      bytes[i >>> 3] |= 1 << (i & 7);
    }
  }
  return bytes;
}

function makeTxids(n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Uint8Array(32);
    t[0] = i + 1;
    t[31] = 0xaa;
    out.push(sha256(t));
  }
  return out;
}

function buildMerkleBlock(
  txids: Uint8Array[],
  matched: Set<number>,
): { mb: MerkleBlockMsg; built: BuiltProof } {
  const built = buildPartialMerkleTree(txids, matched);
  const mb: MerkleBlockMsg = {
    version: 1,
    prevBlock: new Uint8Array(32),
    merkleRoot: built.root,
    timestamp: 1_744_156_800,
    bits: 0x1e0ffff0,
    nonce: 0,
    totalTransactions: txids.length,
    hashes: built.hashes,
    flags: flagsToBytes(built.flagBits),
  };
  return { mb, built };
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('validateMerkleProof — valid proofs', () => {
  test('single transaction block', () => {
    const txids = makeTxids(1);
    const { mb } = buildMerkleBlock(txids, new Set([0]));
    const matched = validateMerkleProof(mb);
    expect(matched.length).toBe(1);
    expect(matched[0]).toEqual(txids[0]);
  });

  test('matches one tx out of seven (unbalanced tree)', () => {
    const txids = makeTxids(7);
    const { mb } = buildMerkleBlock(txids, new Set([4]));
    const matched = validateMerkleProof(mb);
    expect(matched.length).toBe(1);
    expect(matched[0]).toEqual(txids[4]);
  });

  test('matches several txs', () => {
    const txids = makeTxids(8);
    const { mb } = buildMerkleBlock(txids, new Set([1, 5, 6]));
    const matched = validateMerkleProof(mb);
    expect(matched.length).toBe(3);
    // Matches are returned in tree (ascending leaf) order: indices 1, 5, 6.
    expect(matched[0]).toEqual(txids[1]);
    expect(matched[1]).toEqual(txids[5]);
    expect(matched[2]).toEqual(txids[6]);
  });

  test('empty tree (0 transactions) returns no matches', () => {
    const mb: MerkleBlockMsg = {
      version: 1,
      prevBlock: new Uint8Array(32),
      merkleRoot: new Uint8Array(32),
      timestamp: 0,
      bits: 0x1e0ffff0,
      nonce: 0,
      totalTransactions: 0,
      hashes: [],
      flags: new Uint8Array(0),
    };
    expect(validateMerkleProof(mb)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE BUG: trailing flag bits / unused hashes must be rejected
// ---------------------------------------------------------------------------

describe('validateMerkleProof — rejects malformed proofs', () => {
  test('rejects a proof padded with an extra trailing flag byte', () => {
    const txids = makeTxids(4);
    const { mb } = buildMerkleBlock(txids, new Set([2]));
    // Append a whole extra flag byte beyond what the traversal consumes.
    const padded = new Uint8Array(mb.flags.length + 1);
    padded.set(mb.flags, 0);
    padded[padded.length - 1] = 0x01;
    const tampered: MerkleBlockMsg = { ...mb, flags: padded };
    expect(() => validateMerkleProof(tampered)).toThrow(/trailing flag/i);
  });

  test('rejects a proof with a set padding bit in the final flag byte', () => {
    const txids = makeTxids(3);
    const { mb, built } = buildMerkleBlock(txids, new Set([1]));
    // Set the first unused bit above the consumed count within the last byte.
    const usedBits = built.flagBits.length;
    if (usedBits % 8 === 0) {
      // Construction-dependent; pick a tree where the last byte has spare bits.
      throw new Error('test fixture has no spare padding bits');
    }
    const flags = mb.flags.slice();
    flags[usedBits >>> 3] |= 1 << (usedBits & 7);
    const tampered: MerkleBlockMsg = { ...mb, flags };
    expect(() => validateMerkleProof(tampered)).toThrow(/trailing flag bits/i);
  });

  test('rejects a proof carrying an unused extra hash', () => {
    const txids = makeTxids(4);
    const { mb } = buildMerkleBlock(txids, new Set([0]));
    const extra = sha256(new Uint8Array([0xff]));
    const tampered: MerkleBlockMsg = { ...mb, hashes: [...mb.hashes, extra] };
    expect(() => validateMerkleProof(tampered)).toThrow(/unused hashes/i);
  });

  test('rejects a proof whose root does not match the header merkleRoot', () => {
    const txids = makeTxids(4);
    const { mb } = buildMerkleBlock(txids, new Set([2]));
    const badRoot = mb.merkleRoot.slice();
    badRoot[0] ^= 0xff;
    const tampered: MerkleBlockMsg = { ...mb, merkleRoot: badRoot };
    expect(() => validateMerkleProof(tampered)).toThrow(/root mismatch/i);
  });

  test('rejects a proof that references more hashes than it provides', () => {
    const txids = makeTxids(4);
    const { mb } = buildMerkleBlock(txids, new Set([1]));
    const tampered: MerkleBlockMsg = { ...mb, hashes: mb.hashes.slice(0, -1) };
    expect(() => validateMerkleProof(tampered)).toThrow(/ran out of hashes/i);
  });
});
