/**
 * Block-header chain validation for the FairCoin SPV client.
 *
 * SPV_AUDIT.md §4.3: previously `processHeadersResponse` stored every header a
 * peer sent verbatim — no prev-hash linkage, no `nBits` sanity, no checkpoint
 * enforcement. A single malicious peer could therefore graft an arbitrary fake
 * chain onto the wallet and, combined with a Bloom query, display fabricated
 * "confirmed" payments.
 *
 * What this module enforces, and why it matches FairCoin's own rules:
 *
 *  1. **Prev-hash linkage.** Each header must reference the hash of the header
 *     before it (within the batch) and the batch's first header must connect to
 *     a known anchor (the current tip). This is exactly the "non-continuous
 *     headers sequence" check FairCoin's `ProcessMessage("headers")` performs.
 *
 *  2. **`nBits` compact-target sanity.** The encoded difficulty target must be
 *     positive, non-zero, non-overflowing, and `<= ProofOfWorkLimit` — the
 *     range half of FairCoin's `CheckProofOfWork`.
 *
 *  3. **Proof of work, up to `nLastPOWBlock` only.** FairCoin is hybrid
 *     PoW/PoS: `CheckBlock` calls `CheckBlockHeader(block, state,
 *     block.IsProofOfWork())`, so `quarkHash <= target` is enforced for PoW
 *     blocks and skipped for PoS ones. `IsProofOfStake()` reads `vtx[1]`, which
 *     a header-only client does not have — but `main.cpp` rejects a PoS block
 *     at or below `Params().LAST_POW_BLOCK()` (10000 on mainnet), so every
 *     header in that range is provably PoW and can be checked. Above it the
 *     comparison must NOT be applied: verified against 67,768 real mainnet
 *     headers, all 10,001 headers at height <= 10000 satisfy `hash <= target`
 *     and none of the 57,767 above it do. (`AcceptBlockHeader` itself passes
 *     `fCheckPOW = false`, so this is strictly stronger than core's own
 *     header path, never weaker.)
 *
 *  4. **Checkpoint lock-in.** If a header's height matches a hard-coded
 *     checkpoint, its hash must match — mirroring `Checkpoints::CheckBlock`.
 *
 * Full DarkGravityWave difficulty-retarget verification is intentionally out of
 * scope: it requires a contiguous, correctly-hashed block index from genesis,
 * which an SPV header stream (which can start from a checkpoint and is hashed
 * with the not-yet-vector-verified Quark implementation) cannot reliably
 * reproduce. The linkage + checkpoint + target-sanity checks are the subset
 * that is sound to enforce header-only.
 */

import type { BlockHeader } from "@fairco.in/core";
import {
  bytesEqual,
  hashBlockHeader,
  isValidTargetBits,
  meetsProofOfWork,
} from "@fairco.in/core";
import type { BlockHeaderMsg } from "./messages";

// ---------------------------------------------------------------------------
// Compact ("nBits") target encoding — Bitcoin/FairCoin `uint256::SetCompact`.
// ---------------------------------------------------------------------------
// Header chain validation
// ---------------------------------------------------------------------------

function toCoreHeader(header: BlockHeaderMsg): BlockHeader {
  return {
    version: header.version,
    prevHash: header.prevBlock,
    merkleRoot: header.merkleRoot,
    timestamp: header.timestamp,
    bits: header.bits,
    nonce: header.nonce,
  };
}

export interface ValidatedHeader {
  /** Quark hash of the header (internal byte order). */
  readonly hash: Uint8Array;
  /** Absolute chain height of this header. */
  readonly height: number;
  readonly header: BlockHeaderMsg;
}

export interface HeaderChainAnchor {
  /** Hash of the header the batch must connect to (the current tip). */
  readonly hash: Uint8Array;
  /** Height of that anchor header. */
  readonly height: number;
}

export interface ValidateHeaderChainParams {
  /** Headers as received from the peer, in order. */
  readonly headers: BlockHeaderMsg[];
  /**
   * The header the first item must build on. `undefined` only when the store is
   * empty and the first header is expected to be genesis (height 0).
   */
  readonly anchor: HeaderChainAnchor | undefined;
  /** Easiest allowed target for this network. */
  readonly powLimit: bigint;
  /** Lookup of a hard-coded checkpoint hash (hex) for a height, if any. */
  readonly checkpointHashHex?: (height: number) => string | null;
  /** Expected genesis hash (hex), used when there is no anchor. */
  readonly genesisHashHex?: string;
  /**
   * `Params().LAST_POW_BLOCK()`. Headers at or below this height are provably
   * proof-of-work and must satisfy `quarkHash <= target`; above it the chain is
   * proof-of-stake and the comparison is skipped. Omit to disable the check.
   */
  readonly lastPowBlockHeight?: number;
}

export class HeaderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderValidationError";
  }
}

/**
 * Render a hash the way humans, explorers, `NetworkConfig.genesisHash` and the
 * checkpoint tables write it: reversed relative to the internal `uint256`
 * byte order the header store and `hashBlockHeader` use.
 *
 * Comparing an internal-order hash against a display-order constant silently
 * never matches, which would make every checkpoint (and the genesis guard)
 * either dead or spuriously fatal depending on which side is wrong.
 */
function toDisplayHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Validate a batch of headers and assign each an absolute height.
 *
 * Throws {@link HeaderValidationError} on the first invalid header. On success
 * returns every header with its computed hash and height, ready to be stored.
 *
 * @param hashFn Header-hashing function. Defaults to FairCoin's Quark header
 *   hash; injectable so tests can exercise the linkage/target/checkpoint logic
 *   deterministically without depending on the (heavy) Quark implementation.
 */
export function validateHeaderChain(
  params: ValidateHeaderChainParams,
  hashFn: (header: BlockHeaderMsg) => Uint8Array = (h) =>
    hashBlockHeader(toCoreHeader(h)),
): ValidatedHeader[] {
  const {
    headers,
    anchor,
    powLimit,
    checkpointHashHex,
    genesisHashHex,
    lastPowBlockHeight,
  } = params;

  const result: ValidatedHeader[] = [];
  let prevHash = anchor?.hash;
  let height = anchor ? anchor.height : -1;

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];

    // 1. nBits compact-target sanity (the live part of CheckProofOfWork).
    if (!isValidTargetBits(header.bits, powLimit)) {
      throw new HeaderValidationError(
        `header ${i}: invalid difficulty bits 0x${header.bits.toString(16)}`,
      );
    }

    // 2. Prev-hash linkage.
    if (prevHash === undefined) {
      // No anchor: the first header must be genesis and must self-identify by
      // matching the known genesis hash. (Genesis has no predecessor.)
      const hash = hashFn(header);
      if (genesisHashHex && toDisplayHex(hash) !== genesisHashHex) {
        throw new HeaderValidationError(
          "first header does not match genesis and no anchor was provided",
        );
      }
      height = 0;
      assertProofOfWork(height, hash, header.bits, lastPowBlockHeight);
      assertCheckpoint(height, hash, checkpointHashHex);
      result.push({ hash, height, header });
      prevHash = hash;
      continue;
    }

    if (!bytesEqual(header.prevBlock, prevHash)) {
      throw new HeaderValidationError(
        `header ${i}: prevBlock does not link to the previous header (non-continuous chain)`,
      );
    }

    const hash = hashFn(header);
    height += 1;

    // 3. Proof of work — PoW-era heights only.
    assertProofOfWork(height, hash, header.bits, lastPowBlockHeight);

    // 4. Checkpoint lock-in.
    assertCheckpoint(height, hash, checkpointHashHex);

    result.push({ hash, height, header });
    prevHash = hash;
  }

  return result;
}

function assertProofOfWork(
  height: number,
  hash: Uint8Array,
  bits: number,
  lastPowBlockHeight?: number,
): void {
  if (lastPowBlockHeight === undefined) return;
  if (height > lastPowBlockHeight) return;
  if (!meetsProofOfWork(hash, bits)) {
    throw new HeaderValidationError(
      `header at height ${height} does not meet its proof-of-work target`,
    );
  }
}

function assertCheckpoint(
  height: number,
  hash: Uint8Array,
  checkpointHashHex?: (height: number) => string | null,
): void {
  if (!checkpointHashHex) return;
  const expected = checkpointHashHex(height);
  if (expected && toDisplayHex(hash) !== expected) {
    throw new HeaderValidationError(
      `header at height ${height} does not match checkpoint`,
    );
  }
}

// ---------------------------------------------------------------------------
// Chain-update decision (extension vs reorg vs reject)
// ---------------------------------------------------------------------------

export type ChainUpdateAction = "extend" | "reorg" | "ignore";

export interface ChainUpdatePlan {
  readonly action: ChainUpdateAction;
  /** For a reorg: the height to roll the wallet back to (the fork point). */
  readonly forkHeight: number;
  /** The new tip height after applying this batch. */
  readonly newTipHeight: number;
}

export interface PlanChainUpdateParams {
  /** Height the validated batch builds on (the anchor), -1 when from genesis. */
  readonly anchorHeight: number;
  /** Height of the last header in the validated batch. */
  readonly batchTipHeight: number;
  /** Current stored tip height, -1 when the store is empty. */
  readonly currentTipHeight: number;
  /** Maximum allowed reorg depth (FairCoin: network.maxReorgDepth). */
  readonly maxReorgDepth: number;
}

/**
 * Decide what to do with a validated header batch, separated from all I/O so it
 * is directly unit-testable (SPV_AUDIT.md §4.3/§4.4).
 *
 *  - `extend`: the batch builds directly on the current tip (or is the first
 *    chain in an empty store).
 *  - `reorg`: the batch forks below the current tip and is strictly longer, and
 *    the fork is within `maxReorgDepth`. The caller must rewind to `forkHeight`
 *    before storing the batch.
 *  - `ignore`: the batch forks below the tip but is not longer, or the fork is
 *    deeper than `maxReorgDepth` (a stale or abusive branch). The active chain
 *    is kept.
 */
export function planChainUpdate(params: PlanChainUpdateParams): ChainUpdatePlan {
  const { anchorHeight, batchTipHeight, currentTipHeight, maxReorgDepth } =
    params;

  // Empty store, or the batch builds right on the tip → simple extension.
  if (currentTipHeight < 0 || anchorHeight >= currentTipHeight) {
    return {
      action: "extend",
      forkHeight: anchorHeight,
      newTipHeight: batchTipHeight,
    };
  }

  // Forks below the tip: only accept a strictly longer competing chain.
  if (batchTipHeight <= currentTipHeight) {
    return { action: "ignore", forkHeight: anchorHeight, newTipHeight: currentTipHeight };
  }

  // Reject forks deeper than the maximum reorg depth.
  if (currentTipHeight - anchorHeight > maxReorgDepth) {
    return { action: "ignore", forkHeight: anchorHeight, newTipHeight: currentTipHeight };
  }

  return {
    action: "reorg",
    forkHeight: anchorHeight,
    newTipHeight: batchTipHeight,
  };
}
