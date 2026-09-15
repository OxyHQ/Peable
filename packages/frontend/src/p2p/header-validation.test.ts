/**
 * Tests for block-header chain validation (SPV_AUDIT.md §4.3) and the
 * extend/reorg/ignore decision (§4.4).
 *
 * The previous SPV client stored any header a peer sent. These tests prove the
 * new validator enforces prev-hash linkage, rejects out-of-range difficulty
 * bits, honours checkpoints, and that the chain-update planner only switches to
 * a strictly-longer competing chain within the maximum reorg depth.
 *
 * A trivial injectable hash function (first 32 bytes derived from the header's
 * nonce) is used so the linkage/reorg logic is tested deterministically without
 * depending on the heavy Quark implementation.
 */

import { describe, test, expect } from "bun:test";
import {
  compactToTarget,
  isValidTargetBits,
  getNetwork,
} from "@fairco.in/core";
import {
  validateHeaderChain,
  planChainUpdate,
  HeaderValidationError,
  type HeaderChainAnchor,
} from "./header-validation";
import type { BlockHeaderMsg } from "./messages";

// ---------------------------------------------------------------------------
// Deterministic test hash: hash = nonce encoded into a 32-byte array.
// ---------------------------------------------------------------------------

function fakeHash(header: BlockHeaderMsg): Uint8Array {
  const h = new Uint8Array(32);
  h[0] = header.nonce & 0xff;
  h[1] = (header.nonce >>> 8) & 0xff;
  h[2] = (header.nonce >>> 16) & 0xff;
  h[3] = (header.nonce >>> 24) & 0xff;
  return h;
}

const VALID_BITS = 0x1e0ffff0; // FairCoin genesis bits — within the PoW limit.

/** Build a linked chain of `count` headers starting after `prevHashSeed`. */
function buildChain(
  count: number,
  startNonce: number,
  firstPrev: Uint8Array,
): BlockHeaderMsg[] {
  const headers: BlockHeaderMsg[] = [];
  let prev = firstPrev;
  for (let i = 0; i < count; i++) {
    const nonce = startNonce + i;
    const header: BlockHeaderMsg = {
      version: 1,
      prevBlock: prev,
      merkleRoot: new Uint8Array(32),
      timestamp: 1_744_156_800 + nonce,
      bits: VALID_BITS,
      nonce,
      txCount: 0,
    };
    headers.push(header);
    prev = fakeHash(header);
  }
  return headers;
}

const POW_LIMIT = getNetwork("mainnet").powLimit;

// ---------------------------------------------------------------------------
// Compact ("nBits") target decoding
// ---------------------------------------------------------------------------

describe("compactToTarget", () => {
  test("decodes the genesis bits to the expected target", () => {
    // 0x1e0ffff0 => mantissa 0x0ffff0 << 8*(0x1e-3).
    const { target, negative, overflow } = compactToTarget(0x1e0ffff0);
    expect(negative).toBe(false);
    expect(overflow).toBe(false);
    expect(target).toBe(0x0ffff0n << BigInt(8 * (0x1e - 3)));
  });

  test("flags negative when the sign bit is set (with a non-zero mantissa)", () => {
    // nWord = 0x000001 (non-zero) and the 0x00800000 sign bit is set.
    expect(compactToTarget(0x01800001).negative).toBe(true);
  });

  test("flags overflow for an oversized exponent", () => {
    expect(compactToTarget(0xff123456).overflow).toBe(true);
  });

  test("zero mantissa is neither negative nor overflowing", () => {
    const r = compactToTarget(0x00000000);
    expect(r.target).toBe(0n);
    expect(r.negative).toBe(false);
    expect(r.overflow).toBe(false);
  });
});

describe("isValidTargetBits", () => {
  test("accepts the genesis bits", () => {
    expect(isValidTargetBits(VALID_BITS, POW_LIMIT)).toBe(true);
  });

  test("rejects zero target", () => {
    expect(isValidTargetBits(0x00000000, POW_LIMIT)).toBe(false);
  });

  test("rejects a negative target", () => {
    expect(isValidTargetBits(0x01800000, POW_LIMIT)).toBe(false);
  });

  test("rejects a target above the proof-of-work limit", () => {
    // Exponent large enough to exceed `~uint256(0) >> 20`.
    expect(isValidTargetBits(0x2100ffff, POW_LIMIT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Header chain validation (linkage / bits / checkpoint)
// ---------------------------------------------------------------------------

describe("validateHeaderChain — linkage", () => {
  const anchor: HeaderChainAnchor = {
    hash: new Uint8Array(32).fill(7),
    height: 100,
  };

  test("accepts a correctly linked batch and assigns heights", () => {
    const headers = buildChain(3, 1000, anchor.hash);
    const result = validateHeaderChain(
      { headers, anchor, powLimit: POW_LIMIT },
      fakeHash,
    );
    expect(result.length).toBe(3);
    expect(result[0].height).toBe(101);
    expect(result[1].height).toBe(102);
    expect(result[2].height).toBe(103);
  });

  test("rejects a batch whose first header does not build on the anchor", () => {
    const headers = buildChain(2, 2000, new Uint8Array(32).fill(9));
    expect(() =>
      validateHeaderChain({ headers, anchor, powLimit: POW_LIMIT }, fakeHash),
    ).toThrow(HeaderValidationError);
  });

  test("rejects a non-continuous header in the middle of the batch", () => {
    const headers = buildChain(4, 3000, anchor.hash);
    // Break the link between header[2] and header[3].
    headers[3] = { ...headers[3], prevBlock: new Uint8Array(32).fill(0xab) };
    expect(() =>
      validateHeaderChain({ headers, anchor, powLimit: POW_LIMIT }, fakeHash),
    ).toThrow(/non-continuous/i);
  });

  test("rejects a header with out-of-range difficulty bits", () => {
    const headers = buildChain(2, 4000, anchor.hash);
    headers[1] = { ...headers[1], bits: 0x00000000 }; // zero target
    expect(() =>
      validateHeaderChain({ headers, anchor, powLimit: POW_LIMIT }, fakeHash),
    ).toThrow(/difficulty bits/i);
  });
});

/**
 * Render a hash the way checkpoint tables and `NetworkConfig.genesisHash` do:
 * reversed relative to the internal `uint256` byte order the validator works
 * in. Comparing the two conventions directly never matches, which is what made
 * the checkpoint machinery silently inert before.
 */
function displayHex(hash: Uint8Array): string {
  return Buffer.from(hash).reverse().toString("hex");
}

describe("validateHeaderChain — genesis & checkpoints", () => {
  test("first batch with no anchor must start at the known genesis", () => {
    const genesis = buildChain(1, 42, new Uint8Array(32))[0];
    // Display order — the convention `NetworkConfig.genesisHash` and every
    // explorer use, i.e. the reverse of the internal `uint256` bytes.
    const genesisHashHex = displayHex(fakeHash(genesis));
    const headers = [genesis, ...buildChain(2, 43, fakeHash(genesis))];
    const result = validateHeaderChain(
      { headers, anchor: undefined, powLimit: POW_LIMIT, genesisHashHex },
      fakeHash,
    );
    expect(result[0].height).toBe(0);
    expect(result[2].height).toBe(2);
  });

  test("rejects a first batch whose genesis hash is wrong", () => {
    const headers = buildChain(2, 99, new Uint8Array(32));
    expect(() =>
      validateHeaderChain(
        {
          headers,
          anchor: undefined,
          powLimit: POW_LIMIT,
          genesisHashHex: "00".repeat(32),
        },
        fakeHash,
      ),
    ).toThrow(/genesis/i);
  });

  test("rejects a header that violates a checkpoint at its height", () => {
    const anchor: HeaderChainAnchor = {
      hash: new Uint8Array(32).fill(1),
      height: 4,
    };
    const headers = buildChain(2, 500, anchor.hash); // heights 5 and 6
    const checkpointHashHex = (height: number): string | null =>
      height === 6 ? "00".repeat(32) : null; // wrong hash for height 6
    expect(() =>
      validateHeaderChain(
        { headers, anchor, powLimit: POW_LIMIT, checkpointHashHex },
        fakeHash,
      ),
    ).toThrow(/checkpoint/i);
  });

  test("accepts a header that matches its checkpoint", () => {
    const anchor: HeaderChainAnchor = {
      hash: new Uint8Array(32).fill(1),
      height: 4,
    };
    const headers = buildChain(2, 500, anchor.hash); // heights 5 and 6
    const correct = displayHex(fakeHash(headers[1]));
    const checkpointHashHex = (height: number): string | null =>
      height === 6 ? correct : null;
    const result = validateHeaderChain(
      { headers, anchor, powLimit: POW_LIMIT, checkpointHashHex },
      fakeHash,
    );
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Chain-update decision: extend / reorg / ignore
// ---------------------------------------------------------------------------

describe("planChainUpdate", () => {
  const MAX_DEPTH = 100;

  test("extends when the batch builds directly on the tip", () => {
    const plan = planChainUpdate({
      anchorHeight: 50,
      batchTipHeight: 55,
      currentTipHeight: 50,
      maxReorgDepth: MAX_DEPTH,
    });
    expect(plan.action).toBe("extend");
    expect(plan.newTipHeight).toBe(55);
  });

  test("extends from an empty store", () => {
    const plan = planChainUpdate({
      anchorHeight: -1,
      batchTipHeight: 10,
      currentTipHeight: -1,
      maxReorgDepth: MAX_DEPTH,
    });
    expect(plan.action).toBe("extend");
  });

  test("reorgs to a strictly longer competing chain within max depth", () => {
    const plan = planChainUpdate({
      anchorHeight: 40, // fork 10 below the tip
      batchTipHeight: 60, // new chain longer than the current tip (50)
      currentTipHeight: 50,
      maxReorgDepth: MAX_DEPTH,
    });
    expect(plan.action).toBe("reorg");
    expect(plan.forkHeight).toBe(40);
    expect(plan.newTipHeight).toBe(60);
  });

  test("ignores a competing chain that is not longer (ties keep active chain)", () => {
    const plan = planChainUpdate({
      anchorHeight: 40,
      batchTipHeight: 50, // same length as current tip
      currentTipHeight: 50,
      maxReorgDepth: MAX_DEPTH,
    });
    expect(plan.action).toBe("ignore");
  });

  test("ignores a fork deeper than the maximum reorg depth", () => {
    const plan = planChainUpdate({
      anchorHeight: 49, // 101 below the tip of 150
      batchTipHeight: 200,
      currentTipHeight: 150,
      maxReorgDepth: MAX_DEPTH,
    });
    expect(plan.action).toBe("ignore");
  });

  test("reorgs at exactly the maximum reorg depth", () => {
    const plan = planChainUpdate({
      anchorHeight: 50, // exactly 100 below the tip of 150
      batchTipHeight: 200,
      currentTipHeight: 150,
      maxReorgDepth: MAX_DEPTH,
    });
    expect(plan.action).toBe("reorg");
  });
});
