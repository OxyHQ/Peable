/**
 * Tests for the versioned header-store repair.
 *
 * The repair exists because `@fairco.in/core` 0.2.0–0.3.1 computed the wrong
 * Quark id for every block, leaving affected wallets with a header chain that
 * can never link to anything the network sends. Getting the decision wrong is
 * expensive in both directions: wiping a healthy store costs a full re-sync,
 * and failing to wipe a corrupt one leaves the wallet permanently unable to
 * confirm a payment, with no error.
 */

import { describe, test, expect } from "bun:test";
import { hashBlockHeader } from "@fairco.in/core";
import {
  HEADER_HASH_VERSION,
  headerMatchesItsHash,
  planHeaderRepair,
} from "./header-integrity";
import type { BlockHeaderRow } from "./database";

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Real mainnet header at height 5000, verified against a live node. */
const REAL_HEADER: Omit<BlockHeaderRow, "hash"> = {
  height: 5000,
  prev_hash: hexToBytes(
    "7a4bcc2ab2010c6abda1046f38c2d58702798b1850dfd70b8d73fb6300000000",
  ),
  merkle_root: hexToBytes(
    "5d836168c80c2390bd6abe826c6280e95ab0ddbd2ff751f3df8e0214bfbe9162",
  ),
  timestamp: 1776386749,
  bits: 486611763,
  nonce: 3560544522,
  version: 3,
};

const GOOD_ROW: BlockHeaderRow = {
  ...REAL_HEADER,
  hash: hashBlockHeader({
    version: REAL_HEADER.version,
    prevHash: REAL_HEADER.prev_hash,
    merkleRoot: REAL_HEADER.merkle_root,
    timestamp: REAL_HEADER.timestamp,
    bits: REAL_HEADER.bits,
    nonce: REAL_HEADER.nonce,
  }),
};

/** What a store written by the regressed hash looks like: a plausible id that
 * simply is not this header's. */
const CORRUPT_ROW: BlockHeaderRow = {
  ...REAL_HEADER,
  hash: hexToBytes(
    "00d09e7fe2d4e3f1dde089a847934d1853c0cba768d903e844682645315c65ee",
  ),
};

const GENESIS_ROW: BlockHeaderRow = { ...CORRUPT_ROW, height: 0 };

describe("headerMatchesItsHash", () => {
  test("accepts a header that hashes to its recorded id", () => {
    expect(headerMatchesItsHash(GOOD_ROW)).toBe(true);
  });

  test("rejects one written by the regressed implementation", () => {
    expect(headerMatchesItsHash(CORRUPT_ROW)).toBe(false);
  });
});

describe("planHeaderRepair", () => {
  test("does nothing once the store is at the current version", () => {
    // Cheap path: no hashing on a wallet that has already been checked.
    expect(planHeaderRepair(HEADER_HASH_VERSION, CORRUPT_ROW)).toBe(
      "up-to-date",
    );
  });

  test("wipes an out-of-date store whose tip does not verify", () => {
    expect(planHeaderRepair(0, CORRUPT_ROW)).toBe("wipe");
  });

  test("keeps an out-of-date store whose tip verifies", () => {
    expect(planHeaderRepair(0, GOOD_ROW)).toBe("verified");
  });

  test("keeps an empty store — there is nothing to judge", () => {
    expect(planHeaderRepair(0, null)).toBe("verified");
  });

  test("keeps a genesis-only store: genesis is seeded, never hashed", () => {
    // Its id comes from network config, so it says nothing about the hash
    // implementation and must not trigger a wipe.
    expect(planHeaderRepair(0, GENESIS_ROW)).toBe("verified");
  });
});
