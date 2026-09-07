import { test, expect, afterEach } from "bun:test";
import { parseFairToUnits } from "@fairco.in/core";
import {
  getTip,
  getTransaction,
  verifyPayment,
  type ExplorerTx,
} from "../explorer";

// The Explorer response shapes below are pinned against the LIVE endpoints
// (probed 2026-07-18):
//   GET https://explorer.fairco.in/api/stats?network=mainnet
//   GET https://explorer.fairco.in/api/transaction/:txid?network=mainnet
// See ../explorer.ts for the recorded JSON paths.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replace the global fetch with one that always answers `body`/`status`,
// mimicking a real Response (ok/status/json()) via the platform Response.
// `preconnect` is carried over from the real fetch so the mock structurally
// satisfies `typeof fetch` without a cast.
function respondWith(body: unknown, status = 200): void {
  const handler = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = Object.assign(handler, {
    preconnect: realFetch.preconnect,
  });
}

const STATS_BODY = {
  stats: {
    blockHeight: 67763,
    difficulty: 124.3,
    avgBlockTime: 120,
    phase: "PoS",
  },
};

const TX_BODY = {
  transaction: {
    txid: "41bc0000000000000000000000000000000000000000000000000000000041bc",
    confirmations: 1,
    blockheight: 67763,
    vout: [
      // nonstandard output — no scriptPubKey.addresses, must be skipped.
      { value: 0, n: 0, scriptPubKey: { type: "nonstandard" } },
      {
        value: 3769.9894497,
        n: 1,
        scriptPubKey: {
          type: "pubkey",
          addresses: ["FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4"],
        },
      },
    ],
  },
  network: "mainnet",
};

test("getTip parses stats.blockHeight", async () => {
  respondWith(STATS_BODY);
  expect(await getTip("mainnet")).toBe(67763);
});

test("getTransaction maps the standard output and skips the addressless vout", async () => {
  respondWith(TX_BODY);
  const tx = await getTransaction("41bc...", "mainnet");
  if (tx === null) throw new Error("expected a transaction, got null");
  const expectedSat = parseFairToUnits("3769.9894497");
  if (expectedSat === null) throw new Error("fixture amount must parse");
  expect(tx.confirmations).toBe(1);
  expect(tx.outputs).toEqual([
    { address: "FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4", valueSat: expectedSat },
  ]);
});

test("getTransaction returns null when the body carries no transaction", async () => {
  respondWith({ network: "mainnet" });
  expect(await getTransaction("deadbeef", "mainnet")).toBeNull();
});

test("getTransaction returns null on a non-200 response", async () => {
  respondWith({ error: "not found" }, 404);
  expect(await getTransaction("deadbeef", "mainnet")).toBeNull();
});

const PAID_TX: ExplorerTx = {
  txid: "abc",
  confirmations: 3,
  outputs: [{ address: "FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4", valueSat: 100n }],
};

test("verifyPayment: paid when an output matches the address and value >= expected", () => {
  expect(
    verifyPayment(PAID_TX, "FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4", 100n),
  ).toEqual({ paid: true, confirmations: 3 });
});

test("verifyPayment: not paid when the matching output underpays", () => {
  const result = verifyPayment(
    PAID_TX,
    "FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4",
    101n,
  );
  expect(result.paid).toBe(false);
  expect(result.confirmations).toBe(3);
});

test("verifyPayment: not paid when no output pays the address", () => {
  expect(
    verifyPayment(PAID_TX, "FSomeOtherAddress00000000000000000000", 1n).paid,
  ).toBe(false);
});

// One real-network assertion: mainnet has a live, advancing tip (testnet is
// currently empty). Kept last so the mocked tests' fetch restore runs first.
test("getTip returns a positive tip from the live mainnet explorer", async () => {
  const tip = await getTip("mainnet");
  expect(tip).toBeGreaterThan(0);
}, 20000);

