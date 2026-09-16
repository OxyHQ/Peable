/**
 * Regression tests for the SPV receive path.
 *
 * These cover the bug documented in SPV_AUDIT.md §4.2: received funds never
 * appeared in the wallet because `wallet-store.onTransaction` was an empty
 * placeholder and nothing added incoming outputs to the UTXO set.
 *
 * The fixture is a REAL FairCoin mainnet transaction:
 *
 *   txid b7953d1d04a5909fe73e939fe3150054b4237f0d9f21dc118cd8df823019f4fc
 *   output #1 pays 10 FAIR to FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek
 *   output #0 pays 4.9999601 FAIR to FRxmgpEqeAEHVRh1YEiNf61cXzvGatCgtB
 *   input #0 spends ac7b900bee96297c1fe2d1fd3ba524c907ee3702a71b309f69fd21bd12c1c59b:1
 *
 * (Raw hex fetched from https://explorer.fairco.in/api/transaction/<txid>.)
 */

import { describe, test, expect } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import {
  getNetwork,
  hexToBytes,
  extractAddressFromScript,
  UNITS_PER_COIN,
} from "@fairco.in/core";
import { parseTx, type ParsedTransaction } from "../p2p/messages";
import { UTXOSet } from "@peable.to/pay";
import {
  applyTransactionToWallet,
  reverseBytesToHex,
  type ConfirmationInfo,
} from "./apply-transaction";

// ---------------------------------------------------------------------------
// Fixtures (real mainnet data)
// ---------------------------------------------------------------------------

const MAINNET = getNetwork("mainnet");

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
const RECEIVE_VOUT = 1;
const TEN_FAIR = 10n * UNITS_PER_COIN; // 1_000_000_000 base units

const CONFIRMED_AT_HEIGHT: ConfirmationInfo = {
  blockHeight: 100,
  blockHash: "00".repeat(32),
  confirmations: 1,
};

/** Compute the display (reversed) txid the SPV client hands to listeners. */
function displayTxid(raw: Uint8Array): string {
  return reverseBytesToHex(sha256(sha256(raw)));
}

// ---------------------------------------------------------------------------
// Sanity: the fixture parses to the expected real-world values
// ---------------------------------------------------------------------------

describe("real mainnet tx fixture", () => {
  const raw = hexToBytes(RAW_TX_HEX);
  const tx = parseTx(raw);

  test("computes the canonical display txid", () => {
    expect(displayTxid(raw)).toBe(EXPECTED_TXID);
  });

  test("output #1 pays 10 FAIR to the receive address", () => {
    expect(tx.outputs.length).toBe(2);
    const out = tx.outputs[RECEIVE_VOUT];
    expect(out.value).toBe(TEN_FAIR);
    expect(extractAddressFromScript(out.script, MAINNET)).toBe(RECEIVE_ADDRESS);
  });

  test("input #0 spends the expected previous outpoint", () => {
    expect(tx.inputs.length).toBe(1);
    // prevTxHash is wire (internal) order; reversing gives the display txid.
    expect(reverseBytesToHex(tx.inputs[0].prevTxHash)).toBe(
      "ac7b900bee96297c1fe2d1fd3ba524c907ee3702a71b309f69fd21bd12c1c59b",
    );
    expect(tx.inputs[0].prevTxIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE BUG: received funds must now appear in the wallet
// ---------------------------------------------------------------------------

describe("receive: incoming output is credited to the UTXO set", () => {
  test("balance increases by exactly 10 FAIR and the UTXO is added", () => {
    const raw = hexToBytes(RAW_TX_HEX);
    const tx = parseTx(raw);
    const txid = displayTxid(raw);

    const utxoSet = new UTXOSet();
    expect(utxoSet.getBalance()).toBe(0n);

    // This wallet watches the receive address (and nothing else).
    const owns = (addr: string): boolean => addr === RECEIVE_ADDRESS;

    const result = applyTransactionToWallet(
      utxoSet,
      tx,
      txid,
      owns,
      MAINNET,
      CONFIRMED_AT_HEIGHT,
    );

    // Balance went up by 10 FAIR — the core of the fix.
    expect(utxoSet.getBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getConfirmedBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getUnconfirmedBalance()).toBe(0n);

    // The right UTXO landed in the set.
    expect(utxoSet.has(txid, RECEIVE_VOUT)).toBe(true);
    const utxo = utxoSet.get(txid, RECEIVE_VOUT);
    expect(utxo).toBeDefined();
    expect(utxo?.txid).toBe(EXPECTED_TXID);
    expect(utxo?.vout).toBe(RECEIVE_VOUT);
    expect(utxo?.value).toBe(TEN_FAIR);
    expect(utxo?.address).toBe(RECEIVE_ADDRESS);
    expect(utxo?.confirmed).toBe(true);
    expect(utxo?.blockHeight).toBe(100);

    // Result describes a single +10 FAIR receive, no debits.
    expect(result.changed).toBe(true);
    expect(result.credited.length).toBe(1);
    expect(result.debited.length).toBe(0);
    expect(result.receivedTotal).toBe(TEN_FAIR);
    expect(result.spentTotal).toBe(0n);
    expect(result.receiveAddresses).toEqual([RECEIVE_ADDRESS]);

    // The unrelated output (#0) was NOT credited — we don't own it.
    expect(utxoSet.has(txid, 0)).toBe(false);
  });

  test("a wallet that owns no outputs is untouched (filter false positive)", () => {
    const raw = hexToBytes(RAW_TX_HEX);
    const tx = parseTx(raw);
    const txid = displayTxid(raw);

    const utxoSet = new UTXOSet();
    const result = applyTransactionToWallet(
      utxoSet,
      tx,
      txid,
      () => false,
      MAINNET,
      CONFIRMED_AT_HEIGHT,
    );

    expect(result.changed).toBe(false);
    expect(utxoSet.getBalance()).toBe(0n);
  });

  test("unconfirmed (mempool) receive lands in the unconfirmed balance", () => {
    const raw = hexToBytes(RAW_TX_HEX);
    const tx = parseTx(raw);
    const txid = displayTxid(raw);

    const utxoSet = new UTXOSet();
    const unconfirmed: ConfirmationInfo = {
      blockHeight: -1,
      blockHash: "",
      confirmations: 0,
    };

    applyTransactionToWallet(
      utxoSet,
      tx,
      txid,
      (addr) => addr === RECEIVE_ADDRESS,
      MAINNET,
      unconfirmed,
    );

    expect(utxoSet.getBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getConfirmedBalance()).toBe(0n);
    expect(utxoSet.getUnconfirmedBalance()).toBe(TEN_FAIR);
  });

  test("replaying the same confirmed tx does not double-count", () => {
    const raw = hexToBytes(RAW_TX_HEX);
    const tx = parseTx(raw);
    const txid = displayTxid(raw);
    const owns = (addr: string): boolean => addr === RECEIVE_ADDRESS;

    const utxoSet = new UTXOSet();
    applyTransactionToWallet(utxoSet, tx, txid, owns, MAINNET, CONFIRMED_AT_HEIGHT);
    applyTransactionToWallet(utxoSet, tx, txid, owns, MAINNET, CONFIRMED_AT_HEIGHT);

    expect(utxoSet.getBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getAllUTXOs().length).toBe(1);
  });

  test("a later mempool copy never downgrades a confirmed UTXO", () => {
    const raw = hexToBytes(RAW_TX_HEX);
    const tx = parseTx(raw);
    const txid = displayTxid(raw);
    const owns = (addr: string): boolean => addr === RECEIVE_ADDRESS;

    const utxoSet = new UTXOSet();
    applyTransactionToWallet(utxoSet, tx, txid, owns, MAINNET, CONFIRMED_AT_HEIGHT);
    // Now the same output arrives again as "unconfirmed" — must stay confirmed.
    applyTransactionToWallet(utxoSet, tx, txid, owns, MAINNET, {
      blockHeight: -1,
      blockHash: "",
      confirmations: 0,
    });

    expect(utxoSet.getConfirmedBalance()).toBe(TEN_FAIR);
    expect(utxoSet.getUnconfirmedBalance()).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Spend: an input that consumes one of our UTXOs marks it spent
// ---------------------------------------------------------------------------

describe("spend: an input consuming our UTXO debits the balance", () => {
  /**
   * Build a minimal transaction whose single input spends `prevTxid:prevVout`.
   * `prevTxid` is supplied in display order and stored reversed (wire order),
   * exactly as a real transaction encodes its previous-output reference.
   */
  function spendingTx(prevTxid: string, prevVout: number): ParsedTransaction {
    const prevHashWire = hexToBytes(prevTxid).reverse();
    return {
      version: 1,
      inputs: [
        {
          prevTxHash: prevHashWire,
          prevTxIndex: prevVout,
          script: new Uint8Array(0),
          sequence: 0xffffffff,
        },
      ],
      outputs: [],
      lockTime: 0,
      raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    };
  }

  test("spending the received 10 FAIR UTXO returns the balance to zero", () => {
    const raw = hexToBytes(RAW_TX_HEX);
    const receiveTx = parseTx(raw);
    const txid = displayTxid(raw);
    const owns = (addr: string): boolean => addr === RECEIVE_ADDRESS;

    // First receive the 10 FAIR.
    const utxoSet = new UTXOSet();
    applyTransactionToWallet(
      utxoSet,
      receiveTx,
      txid,
      owns,
      MAINNET,
      CONFIRMED_AT_HEIGHT,
    );
    expect(utxoSet.getBalance()).toBe(TEN_FAIR);
    expect(utxoSet.has(EXPECTED_TXID, RECEIVE_VOUT)).toBe(true);

    // Now spend it.
    const spend = spendingTx(EXPECTED_TXID, RECEIVE_VOUT);
    const spendTxid = displayTxid(spend.raw);
    const result = applyTransactionToWallet(
      utxoSet,
      spend,
      spendTxid,
      owns,
      MAINNET,
      CONFIRMED_AT_HEIGHT,
    );

    expect(result.changed).toBe(true);
    expect(result.debited.length).toBe(1);
    expect(result.debited[0].txid).toBe(EXPECTED_TXID);
    expect(result.debited[0].vout).toBe(RECEIVE_VOUT);
    expect(result.debited[0].value).toBe(TEN_FAIR);
    expect(result.debited[0].address).toBe(RECEIVE_ADDRESS);
    expect(result.spentTotal).toBe(TEN_FAIR);

    // UTXO gone, balance back to zero.
    expect(utxoSet.has(EXPECTED_TXID, RECEIVE_VOUT)).toBe(false);
    expect(utxoSet.getBalance()).toBe(0n);
  });

  test("an input that spends an outpoint we don't hold is ignored", () => {
    const utxoSet = new UTXOSet();
    const spend = spendingTx(EXPECTED_TXID, RECEIVE_VOUT);
    const spendTxid = displayTxid(spend.raw);

    const result = applyTransactionToWallet(
      utxoSet,
      spend,
      spendTxid,
      () => true,
      MAINNET,
      CONFIRMED_AT_HEIGHT,
    );

    expect(result.changed).toBe(false);
    expect(result.debited.length).toBe(0);
    expect(utxoSet.getBalance()).toBe(0n);
  });
});
