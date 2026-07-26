/**
 * Proof-of-work verification against REAL FairCoin mainnet headers.
 *
 * FairCoin is hybrid PoW/PoS. `CheckBlock` calls
 * `CheckBlockHeader(block, state, block.IsProofOfWork())`, so `quarkHash <=
 * target` is consensus for PoW blocks and must NOT be applied to PoS ones.
 * `IsProofOfStake()` reads `vtx[1]`, which a header-only client never sees —
 * but `main.cpp` rejects a PoS block at or below `Params().LAST_POW_BLOCK()`
 * (10000 on mainnet), so every header in that range is provably PoW.
 *
 * The vectors below are real mainnet headers, taken from a synced wallet and
 * cross-checked against a live `faircoin Core:3.0.0` node (which confirmed the
 * chain at heights 20000/40000/60000) and against explorer.fairco.in (height
 * 10000). Because these tests run the real Quark hash rather than an injected
 * stub, they simultaneously pin:
 *
 *   - the Quark block-header hash (a wrong hash cannot satisfy the target),
 *   - the little-endian `uint256` reading of that hash,
 *   - the `LAST_POW_BLOCK` boundary in both directions.
 */

import { describe, test, expect } from "bun:test";
import { hashBlockHeader } from "@fairco.in/core";
import {
  meetsProofOfWork,
  lastPowBlock,
  validateHeaderChain,
  proofOfWorkLimit,
  HeaderValidationError,
  type HeaderChainAnchor,
} from "./header-validation";
import type { BlockHeaderMsg } from "./messages";

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

interface Vector {
  readonly height: number;
  /** Quark hash in internal byte order, as stored. */
  readonly hash: string;
  readonly header: BlockHeaderMsg;
}

function vector(
  height: number,
  hash: string,
  prev: string,
  merkle: string,
  timestamp: number,
  bits: number,
  nonce: number,
): Vector {
  return {
    height,
    hash,
    header: {
      version: 3,
      prevBlock: hexToBytes(prev),
      merkleRoot: hexToBytes(merkle),
      timestamp,
      bits,
      nonce,
      // Not hashed; present only on the `headers` wire message.
      txCount: 0,
    },
  };
}

// Heights 4999 → 5000: mid-PoW era.
const POW_4999 = vector(
  4999,
  "7a4bcc2ab2010c6abda1046f38c2d58702798b1850dfd70b8d73fb6300000000",
  "6f28a253f9d420abebe9ec5c31d2a2f9df0a2cd371fec591cc089aef00000000",
  "0edf20d7a1279d53bcdd4fd94bdb5fef269f7ce829545cb982eb488eb2b7a86e",
  1776386570,
  486602493,
  2452187169,
);
const POW_5000 = vector(
  5000,
  "6f12847cf400cd558b19936c9bced0ef06e15efa715c8583c3955f1c00000000",
  "7a4bcc2ab2010c6abda1046f38c2d58702798b1850dfd70b8d73fb6300000000",
  "5d836168c80c2390bd6abe826c6280e95ab0ddbd2ff751f3df8e0214bfbe9162",
  1776386749,
  486611763,
  3560544522,
);

// Height 10000 is the last PoW block; 10001 is the first PoS block (nonce 0).
const POW_10000 = vector(
  10000,
  "c0081391603d1d5bc660ba910abf69d7ee6ba22f540f18caa7c140a800000000",
  "981927ce14fdcbb1765bde9bb4ab8db8062b9759ce09481212a59e9000000000",
  "846131c3b3e6a783cd319244124b53555df29f1896a2cda5912a1ec52c719d29",
  1777017373,
  486602133,
  702131462,
);
const POS_10001 = vector(
  10001,
  "74f40550d67f099c58368b89961829dc00995b90db03ae7e8b2b293bf246195d",
  "c0081391603d1d5bc660ba910abf69d7ee6ba22f540f18caa7c140a800000000",
  "21030367347090ea38c8bf09f0190de461a4f97967362ee13f4780bb63265716",
  1780828992,
  486605583,
  0,
);
const POS_50000 = vector(
  50000,
  "72f91411f14a1212f900d99b120fe59886ad401a0eaecd39efa6ed41a22d55d6",
  "78b6fd5eafbb6abec16c0df207523e07688cf8ce616c88723d8c6c6284c8de0d",
  "8b4d643208d441db65e154de4f168bf614b05fb71a1b5003b4f8c048648da32b",
  1783239013,
  454952363,
  0,
);

function realHash(v: Vector): Uint8Array {
  return hashBlockHeader({
    version: v.header.version,
    prevHash: v.header.prevBlock,
    merkleRoot: v.header.merkleRoot,
    timestamp: v.header.timestamp,
    bits: v.header.bits,
    nonce: v.header.nonce,
  });
}

const toHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

describe("Quark header hash matches mainnet", () => {
  for (const v of [POW_4999, POW_5000, POW_10000, POS_10001, POS_50000]) {
    test(`height ${v.height}`, () => {
      expect(toHex(realHash(v))).toBe(v.hash);
    });
  }
});

describe("meetsProofOfWork", () => {
  test("PoW-era headers satisfy their target", () => {
    for (const v of [POW_4999, POW_5000, POW_10000]) {
      expect(meetsProofOfWork(realHash(v), v.header.bits)).toBe(true);
    }
  });

  test("PoS headers do NOT satisfy the target (so the check must be bounded)", () => {
    for (const v of [POS_10001, POS_50000]) {
      expect(meetsProofOfWork(realHash(v), v.header.bits)).toBe(false);
    }
  });

  test("mutating the nonce breaks the work", () => {
    const tampered = { ...POW_5000.header, nonce: POW_5000.header.nonce + 1 };
    const hash = hashBlockHeader({
      version: tampered.version,
      prevHash: tampered.prevBlock,
      merkleRoot: tampered.merkleRoot,
      timestamp: tampered.timestamp,
      bits: tampered.bits,
      nonce: tampered.nonce,
    });
    expect(meetsProofOfWork(hash, tampered.bits)).toBe(false);
  });
});

describe("lastPowBlock", () => {
  test("mirrors chainparams.cpp nLastPOWBlock", () => {
    expect(lastPowBlock("mainnet")).toBe(10_000);
    expect(lastPowBlock("testnet")).toBe(200);
  });
});

describe("validateHeaderChain enforces PoW only in the PoW range", () => {
  const powLimit = proofOfWorkLimit();

  test("accepts a real PoW header at height 5000", () => {
    const anchor: HeaderChainAnchor = {
      hash: hexToBytes(POW_4999.hash),
      height: 4999,
    };
    const result = validateHeaderChain({
      headers: [POW_5000.header],
      anchor,
      powLimit,
      lastPowBlockHeight: lastPowBlock("mainnet"),
    });
    expect(result[0].height).toBe(5000);
  });

  test("rejects a tampered header inside the PoW range", () => {
    const anchor: HeaderChainAnchor = {
      hash: hexToBytes(POW_4999.hash),
      height: 4999,
    };
    const tampered: BlockHeaderMsg = {
      ...POW_5000.header,
      nonce: POW_5000.header.nonce + 1,
    };
    expect(() =>
      validateHeaderChain({
        headers: [tampered],
        anchor,
        powLimit,
        lastPowBlockHeight: lastPowBlock("mainnet"),
      }),
    ).toThrow(/proof-of-work/i);
  });

  test("accepts the first PoS header, which cannot meet a PoW target", () => {
    const anchor: HeaderChainAnchor = {
      hash: hexToBytes(POW_10000.hash),
      height: 10_000,
    };
    const result = validateHeaderChain({
      headers: [POS_10001.header],
      anchor,
      powLimit,
      lastPowBlockHeight: lastPowBlock("mainnet"),
    });
    expect(result[0].height).toBe(10_001);
  });

  test("would reject the whole PoS chain if the bound were removed", () => {
    const anchor: HeaderChainAnchor = {
      hash: hexToBytes(POW_10000.hash),
      height: 10_000,
    };
    expect(() =>
      validateHeaderChain({
        headers: [POS_10001.header],
        anchor,
        powLimit,
        // Deliberately wrong bound: pretend the whole chain is PoW.
        lastPowBlockHeight: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(HeaderValidationError);
  });
});
