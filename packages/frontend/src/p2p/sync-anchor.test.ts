/**
 * Tests for the header-sync start anchor.
 *
 * The anchor is hand-transcribed chain data, and a wrong field here is not a
 * loud failure: the wallet would seed a header nobody else has, every incoming
 * batch would fail its `prevBlock` linkage, and sync would stall forever with
 * no error. These tests make transcription errors impossible to miss by
 * re-deriving the id from the stored fields with the real Quark hash, and by
 * pinning the anchor to the published checkpoint table so the two cannot drift.
 */

import { describe, test, expect } from "bun:test";
import {
  hashBlockHeader,
  getCheckpointHash,
  bytesToHex,
  getNetwork,
  meetsProofOfWork,
} from "@fairco.in/core";
import { getSyncAnchor } from "./sync-anchor";


/** Display order — the convention the checkpoint table uses. */
function toDisplayHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("mainnet sync anchor", () => {
  const anchor = getSyncAnchor("mainnet");

  test("exists", () => {
    expect(anchor).toBeDefined();
  });

  test("re-hashes to its own recorded id", () => {
    if (!anchor) throw new Error("no mainnet anchor");
    const computed = hashBlockHeader({
      version: anchor.version,
      prevHash: anchor.prevBlock,
      merkleRoot: anchor.merkleRoot,
      timestamp: anchor.timestamp,
      bits: anchor.bits,
      nonce: anchor.nonce,
    });
    expect(bytesToHex(computed)).toBe(bytesToHex(anchor.hash));
  });

  test("matches the published checkpoint at the same height", () => {
    if (!anchor) throw new Error("no mainnet anchor");
    expect(getCheckpointHash(anchor.height, "mainnet")).toBe(
      toDisplayHex(anchor.hash),
    );
  });

  test("sits above the proof-of-work era, so it is a PoS header", () => {
    if (!anchor) throw new Error("no mainnet anchor");
    expect(anchor.height).toBeGreaterThan(getNetwork("mainnet").lastPowBlock);
    // PoS headers carry no work and must never be PoW-checked.
    expect(anchor.nonce).toBe(0);
    expect(meetsProofOfWork(anchor.hash, anchor.bits)).toBe(false);
  });

  test("hashes are 32 bytes", () => {
    if (!anchor) throw new Error("no mainnet anchor");
    expect(anchor.hash).toHaveLength(32);
    expect(anchor.prevBlock).toHaveLength(32);
    expect(anchor.merkleRoot).toHaveLength(32);
  });
});

describe("testnet sync anchor", () => {
  test("is absent — no verified testnet chain data", () => {
    // An unverified anchor is worse than none: it would strand the wallet on a
    // chain that never links.
    expect(getSyncAnchor("testnet")).toBeUndefined();
  });
});
