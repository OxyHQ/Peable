/**
 * Header-sync start anchors.
 *
 * A cold wallet used to build its header chain from genesis, which on mainnet
 * is already tens of thousands of headers and grows by ~200 a day. A wallet
 * that provably has no history — one whose mnemonic this app generated — does
 * not need any of them: it can start from a hard-coded, verified checkpoint
 * and only sync forward.
 *
 * This is deliberately NOT applied to restored or imported wallets. A phrase
 * the user typed in may have received coins at any height, and starting above
 * that height would silently under-report the balance.
 *
 * The anchor is a full header rather than just a hash because the SPV client
 * needs to re-derive its id (`discardCorruptHeaderStore` re-hashes the tip) and
 * because `prevBlock` linkage validates the next batch against it.
 *
 * Kept in the wallet rather than `@fairco.in/core`: the checkpoint *hashes* are
 * shared consensus data, but where a header sync begins is an SPV-client
 * concern, and this wallet is the only SPV consumer. It sits beside
 * `proofOfWorkLimit` / `lastPowBlock` for the same reason.
 *
 * PROVENANCE: read from a synced header store and confirmed against a live
 * `faircoin Core:3.0.0` node (80.240.127.240), which accepted this block as a
 * locator and returned the successor we hold. Its id also matches
 * `MAINNET_CHECKPOINTS[height 60000]` in `@fairco.in/core`, and the test suite
 * asserts that agreement so the two can never drift.
 */

import { hexToBytes, type NetworkType } from "@fairco.in/core";
import type { StoredBlockHeader } from "./spv-client";

/**
 * Mainnet anchor: block 60000. All hashes are in internal (`uint256`) byte
 * order, the order the header store and `prevBlock` linkage use.
 */
const MAINNET_ANCHOR: StoredBlockHeader = {
  height: 60_000,
  hash: hexToBytes(
    "20711ef417c640875ad9c3a4ca8cc2b177bc61efef6c07a7c522a2756531b9b4",
  ),
  version: 3,
  prevBlock: hexToBytes(
    "3051e3f9084407e48f116991b36f022ba778f1f8b796a1039687863de88ba169",
  ),
  merkleRoot: hexToBytes(
    "ec808dc98d66a36184e5d577e684efe47d831483810c7b4ba7b0e2aa4702b63f",
  ),
  timestamp: 1783843225,
  bits: 454092943,
  // Proof-of-stake block: FairCoin leaves the nonce at 0 above nLastPOWBlock.
  nonce: 0,
};

/**
 * The header a freshly-created wallet may start syncing from, or `undefined`
 * when the network has no verified anchor (testnet: no chain data has been
 * verified, and a wrong anchor would strand the wallet on a chain that never
 * links).
 */
export function getSyncAnchor(
  network: NetworkType,
): StoredBlockHeader | undefined {
  return network === "mainnet" ? MAINNET_ANCHOR : undefined;
}
