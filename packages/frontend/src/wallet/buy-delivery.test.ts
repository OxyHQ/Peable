/**
 * Regression test for the Buy-FAIR delivery path (review finding C5).
 *
 * The buy flow used to deliver bought FAIR to a dedicated HD chain
 * (m/44'/119'/0'/2/{i}). KeyManager only ever watches chain 0 (receive) and
 * chain 1 (change), so a deposit to a chain-2 address was rejected by
 * `ownsAddress` and never matched the Bloom filter — the funds never appeared.
 *
 * The fix delivers to a normal chain-0 receive address. This test proves a
 * transaction paying such an address IS owned and credited, and that a chain-2
 * address is (correctly) NOT owned by the wallet's key manager.
 */

import { describe, test, expect } from "bun:test";
import {
  getNetwork,
  decodeAddress,
  createP2PKHScript,
  publicKeyToAddress,
  UNITS_PER_COIN,
} from "@fairco.in/core";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { KeyManager, UTXOSet } from "@peable.to/pay";
import { applyTransactionToWallet, type ConfirmationInfo } from "./apply-transaction";
import type { ParsedTransaction } from "../p2p/messages";

const MAINNET = getNetwork("mainnet");
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const FIVE_FAIR = 5n * UNITS_PER_COIN;

const CONFIRMED: ConfirmationInfo = {
  blockHeight: 200,
  blockHash: "11".repeat(32),
  confirmations: 3,
};

/** Build a one-output transaction that pays `value` to `address` (P2PKH). */
function txPaying(address: string, value: bigint): ParsedTransaction {
  const { hash } = decodeAddress(address);
  const script = createP2PKHScript(hash);
  return {
    version: 1,
    inputs: [],
    outputs: [{ value, script }],
    lockTime: 0,
    raw: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
  };
}

/** Derive a chain-2 ("buy") address the OLD broken flow would have used. */
function legacyBuyChainAddress(index: number): string {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = HDKey.fromMasterSeed(seed, {
    public: MAINNET.bip32.public,
    private: MAINNET.bip32.private,
  });
  const child = root.derive(`m/44'/${MAINNET.bip44CoinType}'/0'/2/${index}`);
  if (!child.publicKey) throw new Error("derivation failed");
  return publicKeyToAddress(child.publicKey, MAINNET);
}

describe("C5: buy delivery to a chain-0 address is credited", () => {
  test("a tx paying the wallet's receive address adds the UTXO", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    // The fix delivers buy proceeds to a normal chain-0 receive address.
    const deliveryAddress = km.getNextAddress().address;
    expect(km.ownsAddress(deliveryAddress)).toBe(true);

    const utxoSet = new UTXOSet();
    const tx = txPaying(deliveryAddress, FIVE_FAIR);
    const result = applyTransactionToWallet(
      utxoSet,
      tx,
      "buy-delivery-txid",
      (addr) => km.ownsAddress(addr),
      MAINNET,
      CONFIRMED,
    );

    // The deposit is recognised and credited.
    expect(result.changed).toBe(true);
    expect(result.credited.length).toBe(1);
    expect(result.receivedTotal).toBe(FIVE_FAIR);
    expect(result.receiveAddresses).toEqual([deliveryAddress]);
    expect(utxoSet.getBalance()).toBe(FIVE_FAIR);
  });

  test("the old chain-2 buy address is NOT owned (would have been rejected)", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    const buyChainAddr = legacyBuyChainAddress(0);

    // The key manager never watches chain 2 — this is exactly why deposits to
    // it never appeared. It must differ from every chain-0/1 address.
    expect(km.ownsAddress(buyChainAddr)).toBe(false);

    const utxoSet = new UTXOSet();
    const tx = txPaying(buyChainAddr, FIVE_FAIR);
    const result = applyTransactionToWallet(
      utxoSet,
      tx,
      "legacy-buy-txid",
      (addr) => km.ownsAddress(addr),
      MAINNET,
      CONFIRMED,
    );

    // Confirms the failure mode the fix avoids: a chain-2 deposit is dropped.
    expect(result.changed).toBe(false);
    expect(utxoSet.getBalance()).toBe(0n);
  });
});
