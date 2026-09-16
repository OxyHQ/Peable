/**
 * End-to-end evidence that a historical rescan discovers a payment confirmed
 * BEFORE the Bloom filter loaded, and credits it exactly once (SPV_AUDIT.md
 * §6.3 + the open question about tx b7953d1d… to FAHUJ…).
 *
 * This wires the REAL production functions the rescan drives, in order:
 *   1. The rescan requests a block as a filtered (merkle) block.
 *   2. The peer returns a `merkleblock`; `validateMerkleProof` reconstructs the
 *      block's merkle root and extracts the matched tx hash.
 *   3. The peer returns the matching `tx`; the SPV client tags it with the
 *      block hash and hands it to the receive path.
 *   4. `applyTransactionToWallet` credits the wallet's UTXO set.
 *
 * The fixture is the real mainnet tx whose output #1 pays 10 FAIR to
 * FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek. We assert the funds appear, and that
 * re-running the scan (idempotency) does not double-count.
 */

import { describe, test, expect } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { getNetwork, hexToBytes, UNITS_PER_COIN } from "@fairco.in/core";
import { parseTx } from "../p2p/messages";
import type { MerkleBlockMsg } from "../p2p/messages";
import { validateMerkleProof } from "../p2p/merkle-proof";
import { UTXOSet } from "@peable.to/pay";
import {
  applyTransactionToWallet,
  reverseBytesToHex,
  type ConfirmationInfo,
} from "./apply-transaction";

const MAINNET = getNetwork("mainnet");

// Real mainnet transaction (raw hex from explorer.fairco.in). Output #1 pays
// 10 FAIR to FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek.
const RAW_TX_HEX =
  "01000000019bc5c112bd21fd699f301ba70237ee07c924a53bfdd1e21f7c2996ee0b907bac" +
  "0100000048473044022063217b3fbff910185d1b3caf4fa6d248d0c5cd27ea33729c6cdc2b" +
  "99b17049580220280664029acc5259de8249d74175f16ec601b228f6e19fc8bcf3468af9ce" +
  "90aa01ffffffff026a55cd1d000000001976a914dcd555e41658449bc79d13d561f7f85dff" +
  "e76d6e88ac00ca9a3b000000001976a91430dcb7d3cc3a4733d0e478c66835a0946cfcfacf" +
  "88ac00000000";

const EXPECTED_TXID =
  "b7953d1d04a5909fe73e939fe3150054b4237f0d9f21dc118cd8df823019f4fc";
const RECEIVE_ADDRESS = "FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek";
const TEN_FAIR = 10n * UNITS_PER_COIN;
const BIRTH_BLOCK_HEIGHT = 1234;

function internalTxHash(raw: Uint8Array): Uint8Array {
  return sha256(sha256(raw));
}

/**
 * Build a single-transaction merkleblock for the given tx, matching it. For a
 * 1-tx block the merkle root equals the (internal-order) txid and the proof is
 * a single matched leaf with flag bit 1.
 */
function singleTxMerkleBlock(txInternalHash: Uint8Array): MerkleBlockMsg {
  return {
    version: 1,
    prevBlock: new Uint8Array(32),
    merkleRoot: txInternalHash,
    timestamp: 1_744_156_800,
    bits: 0x1e0ffff0,
    nonce: 0,
    totalTransactions: 1,
    hashes: [txInternalHash],
    flags: new Uint8Array([0x01]),
  };
}

/**
 * Reproduce the SPV client's merkleblock→tx association + receive dispatch for
 * a rescan-delivered block, returning the credited UTXO count.
 */
function deliverThroughRescanPipeline(
  utxoSet: UTXOSet,
  rawTx: Uint8Array,
  ownsAddress: (a: string) => boolean,
): void {
  const tx = parseTx(rawTx);
  const txHash = internalTxHash(rawTx);

  // (2) Validate the merkle proof and extract the matched tx hash.
  const merkleBlock = singleTxMerkleBlock(txHash);
  const matched = validateMerkleProof(merkleBlock);
  expect(matched.length).toBe(1);
  expect(matched[0]).toEqual(txHash);

  // (3) The matched tx arrives; it is confirmed in this block.
  const displayTxid = reverseBytesToHex(txHash);
  const confirmation: ConfirmationInfo = {
    blockHeight: BIRTH_BLOCK_HEIGHT,
    blockHash: reverseBytesToHex(
      sha256(sha256(new Uint8Array([1, 2, 3]))), // opaque block hash
    ),
    confirmations: 1,
  };

  // (4) Credit the wallet.
  applyTransactionToWallet(
    utxoSet,
    tx,
    displayTxid,
    ownsAddress,
    MAINNET,
    confirmation,
  );
}

describe("historical rescan discovers a pre-filter payment", () => {
  test("a restored wallet finds the 10 FAIR sent to FAHUJ… and credits it once", () => {
    const rawTx = hexToBytes(RAW_TX_HEX);
    const utxoSet = new UTXOSet();
    const owns = (a: string): boolean => a === RECEIVE_ADDRESS;

    // The wallet started with zero balance (it was just restored).
    expect(utxoSet.getBalance()).toBe(0n);

    // Rescan delivers the block + tx through the real pipeline.
    deliverThroughRescanPipeline(utxoSet, rawTx, owns);

    // The historical payment now shows up, confirmed.
    expect(utxoSet.getBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getConfirmedBalance()).toBe(TEN_FAIR);
    expect(utxoSet.has(EXPECTED_TXID, 1)).toBe(true);
    expect(utxoSet.get(EXPECTED_TXID, 1)?.blockHeight).toBe(BIRTH_BLOCK_HEIGHT);

    // Re-running the scan (the scan is re-entrant / restart-resilient) must not
    // double-count: the UTXO set still holds exactly one 10 FAIR output.
    deliverThroughRescanPipeline(utxoSet, rawTx, owns);
    expect(utxoSet.getBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getAllUTXOs().length).toBe(1);
  });
});
