import { describe, test, expect, mock } from "bun:test";
import { hexToBytes, getNetwork } from "@fairco.in/core";

// Mock @oxy.so/core BEFORE importing the module under test — mirrors
// identity-wallet.test.ts's established pattern for wrapping KeyManager,
// including its spread: `mock.module` is process-wide, so replacing the module
// with only `KeyManager` would delete every other Oxy export for the rest of
// the run and break unrelated test files that import them.
const realOxyCore = { ...(await import("@oxy.so/core")) };
let sharedPrivateKeyResult: string | null = "aa".repeat(32);
let primaryPrivateKeyResult: string | null = null;
const getSharedPrivateKey = mock(async () => sharedPrivateKeyResult);
const getPrivateKey = mock(async () => primaryPrivateKeyResult);
mock.module("@oxy.so/core", () => ({
  ...realOxyCore,
  KeyManager: { getSharedPrivateKey, getPrivateKey },
}));

const {
  SOCIAL_RECEIVE_GAP_LIMIT,
  getIdentityPrivateKeyBytes,
  deriveSocialReceiveWatchWindow,
  getSocialReceiveSpendingKey,
  computeWindowExtension,
} = await import("./social-receive");

const IDENTITY_PRIV_A = hexToBytes("aa".repeat(32));
const TESTNET = getNetwork("testnet");

describe("SOCIAL_RECEIVE_GAP_LIMIT", () => {
  test("is 20", () => {
    expect(SOCIAL_RECEIVE_GAP_LIMIT).toBe(20);
  });
});

describe("getIdentityPrivateKeyBytes", () => {
  test("prefers the shared identity over the primary one", async () => {
    sharedPrivateKeyResult = "aa".repeat(32);
    primaryPrivateKeyResult = "bb".repeat(32);
    const bytes = await getIdentityPrivateKeyBytes();
    expect(bytes).toEqual(IDENTITY_PRIV_A);
  });

  test("falls back to the primary identity when there is no shared one", async () => {
    sharedPrivateKeyResult = null;
    primaryPrivateKeyResult = "bb".repeat(32);
    const bytes = await getIdentityPrivateKeyBytes();
    expect(bytes).toEqual(hexToBytes("bb".repeat(32)));
  });

  test("returns null when neither identity is available (web / keyless)", async () => {
    sharedPrivateKeyResult = null;
    primaryPrivateKeyResult = null;
    expect(await getIdentityPrivateKeyBytes()).toBeNull();
  });

  test("CRITICAL: canonicalizes a short or uppercase hex key before decoding", async () => {
    // elliptic's getPrivate('hex') strips leading zero bytes ~1-in-256 times,
    // and legacy imports may be uppercase — both must decode to the exact
    // same 32 bytes as the fully-padded lowercase form, or the derived
    // social-receive branch would silently diverge from what the SAME
    // identity's public path (backend/payer) computes.
    sharedPrivateKeyResult = "AA".repeat(32); // uppercase, full length
    primaryPrivateKeyResult = null;
    const uppercaseBytes = await getIdentityPrivateKeyBytes();
    expect(uppercaseBytes).toEqual(IDENTITY_PRIV_A);

    sharedPrivateKeyResult = "1".repeat(63); // 63 chars -- needs left-padding to 64
    const shortBytes = await getIdentityPrivateKeyBytes();
    expect(shortBytes).toEqual(hexToBytes(`0${"1".repeat(63)}`));
  });
});

describe("deriveSocialReceiveWatchWindow", () => {
  test("derives the pinned addr(0..2) starting at 0", () => {
    const window = deriveSocialReceiveWatchWindow(IDENTITY_PRIV_A, 0, 3, TESTNET);
    expect(window).toEqual([
      { index: 0, address: "TGW3g56Q5PvpA8UangXnzX6va2MkfaRx5r" },
      { index: 1, address: "TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ" },
      { index: 2, address: "TVsFKn7zkDN1QnMNe1thrJUEXBGiqnu19g" },
    ]);
  });

  test("a window starting mid-range derives the correct offset", () => {
    const window = deriveSocialReceiveWatchWindow(IDENTITY_PRIV_A, 2, 1, TESTNET);
    expect(window).toEqual([{ index: 2, address: "TVsFKn7zkDN1QnMNe1thrJUEXBGiqnu19g" }]);
  });

  test("count 0 returns an empty window", () => {
    expect(deriveSocialReceiveWatchWindow(IDENTITY_PRIV_A, 0, 0, TESTNET)).toEqual([]);
  });
});

describe("getSocialReceiveSpendingKey", () => {
  test("the spending key at index 0 matches the pinned vector", () => {
    const key = getSocialReceiveSpendingKey(IDENTITY_PRIV_A, 0);
    expect(Buffer.from(key).toString("hex")).toBe(
      "42d089c0f361d67b6add7279d67718bc89ddd35d2218696991c24d3902d26c86".slice(0, 64),
    );
  });
});

describe("computeWindowExtension", () => {
  test("no extension needed when the watched window already covers the gap limit", () => {
    // Nothing used yet (highestUsedIndex -1), window already covers 0..19.
    expect(computeWindowExtension(19, -1, 20)).toBeNull();
  });

  test("extends when the highest used index approaches the edge of the watched window", () => {
    // Used up to index 5, watched only up to 19 -> target = 5 + 20 = 25, extend 20..25.
    const extension = computeWindowExtension(19, 5, 20);
    expect(extension).toEqual({ start: 20, count: 6 });
  });

  test("extends from an empty window (first boot)", () => {
    const extension = computeWindowExtension(-1, -1, 20);
    expect(extension).toEqual({ start: 0, count: 20 });
  });

  test("extends by exactly the amount needed to restore the full gap limit", () => {
    // Used index 0 immediately after a 20-wide initial window (0..19):
    // target = 0 + 20 = 20, watched already covers up to 19 -> extend by 1 (index 20).
    const extension = computeWindowExtension(19, 0, 20);
    expect(extension).toEqual({ start: 20, count: 1 });
  });
});
