/**
 * Tests for BIP44 key derivation and, in particular, cursor persistence
 * (SPV_AUDIT.md §4.5).
 *
 * `KeyManager.fromMnemonic` always resets the receive/change cursors to 0, so
 * without `restoreCursors` a wallet re-issues the same "next receive address"
 * on every launch and can miss funds beyond the initial gap window. These tests
 * prove the cursor survives a simulated restart and that used addresses are not
 * re-issued.
 */

import { describe, test, expect } from "bun:test";
import { deriveAddress, getNetwork } from "@fairco.in/core";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { KeyManager } from "./key-manager";

const MAINNET = getNetwork("mainnet");

// Canonical BIP39 trial mnemonic — deterministic derivation.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("KeyManager cursor persistence", () => {
  test("a fresh manager starts both cursors at 0", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    expect(km.getNextExternalIndex()).toBe(0);
    expect(km.getNextChangeIndex()).toBe(0);
  });

  test("restoreCursors advances the cursors and the next address skips used ones", () => {
    // First run: hand out 3 receive addresses (indices 0,1,2 become used).
    const first = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const issued = [
      first.getNextAddress(),
      first.getNextAddress(),
      first.getNextAddress(),
    ];
    expect(issued.map((a) => a.index)).toEqual([0, 1, 2]);
    expect(first.getNextExternalIndex()).toBe(3);

    // Simulated restart: a brand-new manager from the same mnemonic. The DB
    // recorded that index 2 was the highest used, so the next unused is 3.
    const restarted = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    expect(restarted.getNextExternalIndex()).toBe(0); // reset on construct
    restarted.restoreCursors(3, 0);
    expect(restarted.getNextExternalIndex()).toBe(3);

    // The next receive address is index 3, NOT 0 — used addresses survived.
    const next = restarted.getNextAddress();
    expect(next.index).toBe(3);
    // And it is the SAME deterministic address the first manager would issue.
    const firstFourth = first.getNextAddress();
    expect(next.address).toBe(firstFourth.address);
  });

  test("restoreCursors only ever moves a cursor forward", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.getNextAddress(); // cursor -> 1
    km.getNextAddress(); // cursor -> 2
    km.restoreCursors(1, 0); // lower than current: ignored
    expect(km.getNextExternalIndex()).toBe(2);
  });

  test("restoreCursors pre-derives the lookahead window so addresses are watched", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    // Advance the external cursor far ahead, as if many addresses were used.
    km.restoreCursors(50, 0);
    const external = km.getExternalAddresses();
    // At least cursor + gap-limit (20) addresses must be derived and watchable.
    expect(external.length).toBeGreaterThanOrEqual(70);

    // The address at the restored cursor must be present (so the Bloom filter
    // built from getAllAddresses() watches it).
    const next = km.getNextAddress();
    expect(next.index).toBe(50);
    expect(km.ownsAddress(next.address)).toBe(true);
  });

  test("change cursor restores independently of the external cursor", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.restoreCursors(0, 5);
    expect(km.getNextChangeIndex()).toBe(5);
    expect(km.getNextExternalIndex()).toBe(0);
    const change = km.getNextChangeAddress();
    expect(change.index).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Watch-only (xpub) key manager — review finding C2.
//
// The old importWatchOnly stored `xpub:<key>` as the "mnemonic" and on cold
// boot fed it into mnemonicToSeedSync, which (because BIP39 does not validate
// its input) silently derived a RANDOM spendable keypair — a dangerous fake
// wallet. These tests prove the real public-only path: it watches the correct
// addresses and never produces private keys.
// ---------------------------------------------------------------------------

/** The account-level (m/44'/119'/0') extended PUBLIC key for the trial mnemonic. */
function accountXpub(): string {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = HDKey.fromMasterSeed(seed, {
    public: MAINNET.bip32.public,
    private: MAINNET.bip32.private,
  });
  const account = root.derive(`m/44'/${MAINNET.bip44CoinType}'/0'`);
  return account.publicExtendedKey;
}

/** The account-level extended PRIVATE key (xprv) — must be rejected by fromXpub. */
function accountXprv(): string {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = HDKey.fromMasterSeed(seed, {
    public: MAINNET.bip32.public,
    private: MAINNET.bip32.private,
  });
  return root.derive(`m/44'/${MAINNET.bip44CoinType}'/0'`).privateExtendedKey;
}

describe("KeyManager.accountXpub", () => {
  test("returns the account-level extended public key (m/44'/119'/0')", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    // Must equal the independently-derived account xpub for this mnemonic, so
    // the watch-only registration payload carries the SAME key the server needs
    // to derive our receive/change addresses.
    expect(km.accountXpub()).toBe(accountXpub());
  });

  test("round-trips: fromXpub(accountXpub()) derives the same addresses", () => {
    const full = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const xpub = full.accountXpub();
    expect(typeof xpub).toBe("string");
    expect(xpub.length).toBeGreaterThan(0);

    const watch = KeyManager.fromXpub(xpub, MAINNET);
    expect(watch.getExternalAddresses()[0]).toBe(full.getExternalAddresses()[0]);
    expect(watch.getExternalAddresses()).toEqual(full.getExternalAddresses());
  });

  test("a watch-only manager re-exports the SAME xpub it was built from", () => {
    const xpub = accountXpub();
    const watch = KeyManager.fromXpub(xpub, MAINNET);
    expect(watch.accountXpub()).toBe(xpub);
  });
});

describe("KeyManager.fromXpub (watch-only)", () => {
  test("derives the SAME addresses a full wallet would (watches the right keys)", () => {
    const full = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const watch = KeyManager.fromXpub(accountXpub(), MAINNET);

    // External and change address sets must match exactly — otherwise the
    // Bloom filter would watch the wrong addresses and miss incoming funds.
    expect(watch.getExternalAddresses()).toEqual(full.getExternalAddresses());
    expect(watch.getChangeAddresses()).toEqual(full.getChangeAddresses());

    // It recognises its own addresses.
    const first = full.getExternalAddresses()[0];
    expect(watch.ownsAddress(first)).toBe(true);
  });

  test("is flagged watch-only and exposes NO private keys", () => {
    const watch = KeyManager.fromXpub(accountXpub(), MAINNET);
    expect(watch.isWatchOnly()).toBe(true);

    const addr = watch.getExternalAddresses()[0];
    // The core guarantee: a watch-only wallet can never hand out a private key.
    expect(() => watch.getPrivateKeyForAddress(addr)).toThrow(/Watch-only/);
  });

  test("the watch-only addresses are real (match full-wallet derivation), not random", () => {
    // Regression guard for C2: the bug produced random, unrelated keys. Here the
    // very first watch-only address MUST equal the full wallet's first address.
    const full = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const watch = KeyManager.fromXpub(accountXpub(), MAINNET);
    expect(watch.getNextAddress().address).toBe(full.getNextAddress().address);
  });

  test("rejects a private extended key (xprv) instead of retaining spend power", () => {
    expect(() => KeyManager.fromXpub(accountXprv(), MAINNET)).toThrow();
  });

  test("rejects a malformed extended key", () => {
    expect(() => KeyManager.fromXpub("not-an-xpub", MAINNET)).toThrow(
      /Invalid extended public key/,
    );
  });

  test("rejects an empty string", () => {
    expect(() => KeyManager.fromXpub("", MAINNET)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Key zeroization on lock / reset (review finding M1).
//
// The manager caches every derived private key in memory for the session. On
// lock / wallet reset those keys must not linger in the heap. `wipe()` overwrites
// each private-key buffer with zeros IN PLACE and clears the maps.
// ---------------------------------------------------------------------------

describe("KeyManager.wipe (M1 zeroization)", () => {
  test("overwrites the cached private-key bytes with zeros in place", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const addr = km.getExternalAddresses()[0];

    // Grab the live reference the manager hands out for signing. After wipe the
    // SAME buffer must be all-zero — proving the secret bytes are destroyed, not
    // merely de-referenced (a GC'd-but-not-cleared buffer is recoverable).
    const priv = km.getPrivateKeyForAddress(addr);
    expect(priv.length).toBe(32);
    expect(priv.some((b) => b !== 0)).toBe(true); // real key material before wipe

    km.wipe();

    expect(priv.every((b) => b === 0)).toBe(true); // zeroized in place
  });

  test("drops all derived addresses so none are owned after wipe", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const addr = km.getExternalAddresses()[0];
    expect(km.ownsAddress(addr)).toBe(true);

    km.wipe();

    expect(km.getAllAddresses()).toHaveLength(0);
    expect(km.getExternalAddresses()).toHaveLength(0);
    expect(km.getChangeAddresses()).toHaveLength(0);
    expect(km.ownsAddress(addr)).toBe(false);
  });

  test("zeroizes change-chain private keys too", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const changeAddr = km.getChangeAddresses()[0];
    const priv = km.getPrivateKeyForAddress(changeAddr);
    expect(priv.some((b) => b !== 0)).toBe(true);

    km.wipe();

    expect(priv.every((b) => b === 0)).toBe(true);
  });

  test("a wiped manager can no longer produce a private key", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const addr = km.getExternalAddresses()[0];
    km.wipe();
    // The address is gone from the maps, so a lookup fails rather than returning
    // a zeroed (and now useless) key.
    expect(() => km.getPrivateKeyForAddress(addr)).toThrow(/not found/);
  });

  test("wipe() on a watch-only manager is safe (no private keys to zero)", () => {
    const watch = KeyManager.fromXpub(accountXpub(), MAINNET);
    expect(() => watch.wipe()).not.toThrow();
    expect(watch.getAllAddresses()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BIP44 account index (Pockets). Each account is an isolated subtree; account 0
// must remain byte-for-byte identical to the pre-Pockets single-account wallet.
// ---------------------------------------------------------------------------

describe("KeyManager account index (Pockets)", () => {
  test("defaults to account 0 and reports it via getAccount()", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    expect(km.getAccount()).toBe(0);
  });

  test("account 0 addresses are unchanged (backward compatible)", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const withDefault = KeyManager.fromSeed(seed, MAINNET);
    const withExplicitZero = KeyManager.fromSeed(seed, MAINNET, 0);
    expect(withExplicitZero.getExternalAddresses()).toEqual(
      withDefault.getExternalAddresses(),
    );
  });

  test("account 1 derives a DIFFERENT external chain than account 0", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const acct0 = KeyManager.fromSeed(seed, MAINNET, 0);
    const acct1 = KeyManager.fromSeed(seed, MAINNET, 1);
    expect(acct1.getAccount()).toBe(1);
    expect(acct1.getExternalAddresses()[0]).not.toBe(
      acct0.getExternalAddresses()[0],
    );
  });

  test("account 1 addresses match @fairco.in/core deriveAddress(seed, 1, ...)", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const acct1 = KeyManager.fromSeed(seed, MAINNET, 1);
    const external = acct1.getExternalAddresses();
    for (let i = 0; i < 5; i++) {
      expect(external[i]).toBe(deriveAddress(seed, 1, 0, i, MAINNET).address);
    }
  });

  test("the per-address path string carries the account index", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const acct2 = KeyManager.fromSeed(seed, MAINNET, 2);
    const first = acct2.getNextAddress();
    expect(first.path).toBe(`m/44'/${MAINNET.bip44CoinType}'/2'/0/0`);
  });

  test("accountXpub differs per account and round-trips through fromXpub", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const acct0 = KeyManager.fromSeed(seed, MAINNET, 0);
    const acct1 = KeyManager.fromSeed(seed, MAINNET, 1);
    expect(acct1.accountXpub()).not.toBe(acct0.accountXpub());

    const watch1 = KeyManager.fromXpub(acct1.accountXpub(), MAINNET, 1);
    expect(watch1.getAccount()).toBe(1);
    expect(watch1.getExternalAddresses()).toEqual(acct1.getExternalAddresses());
    expect(watch1.getExternalAddresses()[0]).not.toBe(
      acct0.getExternalAddresses()[0],
    );
  });
});

describe("KeyManager watch addresses", () => {
  // Real 2-of-3 mainnet multisig P2SH address (same fixture used across the
  // @fairco.in/core multisig test suite).
  const MULTISIG_ADDRESS = "7iKBxUNbBbTa8n1Q32oLucmvmKL7c572P2";

  test("a fresh manager does not own an unregistered watch address", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    expect(km.ownsAddress(MULTISIG_ADDRESS)).toBe(false);
    expect(km.getAllAddresses()).not.toContain(MULTISIG_ADDRESS);
  });

  test("registerWatchAddress makes ownsAddress true and includes it in getAllAddresses", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.registerWatchAddress(MULTISIG_ADDRESS);
    expect(km.ownsAddress(MULTISIG_ADDRESS)).toBe(true);
    expect(km.getAllAddresses()).toContain(MULTISIG_ADDRESS);
    expect(km.getWatchAddresses()).toEqual([MULTISIG_ADDRESS]);
  });

  test("wipe() clears registered watch addresses (cross-wallet isolation)", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.registerWatchAddress(MULTISIG_ADDRESS);
    km.wipe();
    expect(km.ownsAddress(MULTISIG_ADDRESS)).toBe(false);
    expect(km.getWatchAddresses()).toEqual([]);
  });

  test("getPrivateKeyForAddress still throws for a watch address (no key material, by design)", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.registerWatchAddress(MULTISIG_ADDRESS);
    expect(() => km.getPrivateKeyForAddress(MULTISIG_ADDRESS)).toThrow();
  });
});
