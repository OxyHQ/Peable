import { test, expect } from "bun:test";
import { TESTNET, mnemonicToSeed, deriveKeyFromSeed } from "@fairco.in/core";
import { HDKey } from "@scure/bip32";
import { assertWatchOnly, deriveIntentAddress } from "../derivation";

// Watch-only account xpub for the canonical all-"abandon" + "art" testnet
// mnemonic, produced by `scripts/gen-xpub-vector.ts` (m/44'/1'/0' neutered).
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";

// Same 24-word mnemonic the vector generator uses.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

test("derives deterministic external receive addresses from the xpub", () => {
  expect(deriveIntentAddress(XPUB, 0, 0, TESTNET)).toBe(
    "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3",
  );
  expect(deriveIntentAddress(XPUB, 0, 1, TESTNET)).toBe(
    "TVdQEadb9Yurh3QCBf1vwjZxNySQvHxFmk",
  );
  expect(deriveIntentAddress(XPUB, 0, 2, TESTNET)).toBe(
    "TRhbVij2oTwETnzpVNDixacseS48FZgsUZ",
  );
});

test("distinct indexes yield distinct addresses", () => {
  const a0 = deriveIntentAddress(XPUB, 0, 0, TESTNET);
  const a1 = deriveIntentAddress(XPUB, 0, 1, TESTNET);
  expect(a1).not.toBe(a0);
});

test("rejects a private xprv (non-custody guard)", () => {
  const seed = mnemonicToSeed(MNEMONIC);
  const root = deriveKeyFromSeed(seed, TESTNET);
  const accountNode = root.derive(`m/44'/${TESTNET.bip44CoinType}'/0'`);
  const xprv = accountNode.hdKey.privateExtendedKey;

  // Sanity: the extended key we built really is private (carries a key).
  const parsed = HDKey.fromExtendedKey(xprv, {
    public: TESTNET.bip32.public,
    private: TESTNET.bip32.private,
  });
  expect(parsed.privateKey).not.toBeNull();

  expect(() => deriveIntentAddress(xprv, 0, 0, TESTNET)).toThrow(
    "watch-only violation",
  );
});

/**
 * The same firewall, reachable without deriving anything.
 *
 * `PUT /v1/wallet/me/xpub` accepts a key to STORE, and stores it before any
 * address is derived from it — so a guard that only runs inside
 * `deriveIntentAddress` would let an `xprv` land in the database and be caught
 * later, or never. The gateway must refuse to hold spend capability at the
 * boundary, not at first use.
 */
test("assertWatchOnly refuses a private xprv on its own", () => {
  const seed = mnemonicToSeed(MNEMONIC);
  const root = deriveKeyFromSeed(seed, TESTNET);
  const xprv = root.derive(`m/44'/${TESTNET.bip44CoinType}'/0'`).hdKey.privateExtendedKey;

  expect(() => assertWatchOnly(xprv, TESTNET)).toThrow("watch-only violation");
});

test("assertWatchOnly accepts a neutered xpub", () => {
  expect(() => assertWatchOnly(XPUB, TESTNET)).not.toThrow();
});

/**
 * A string that is not an extended key at all must not pass for one. Without
 * this, a typo'd or truncated key would be stored and only fail much later,
 * when a surface tried to derive a receive address from it.
 */
test("assertWatchOnly rejects a string that is not an extended key", () => {
  expect(() => assertWatchOnly("not-an-xpub", TESTNET)).toThrow();
});
