/**
 * Tests for outgoing coin selection (the funds-correctness core).
 *
 * These prove the fixes for the three coin-selection bugs found in review:
 *   - C3: a send no longer sweeps the WHOLE wallet — only the coins needed for
 *         amount + fee are spent.
 *   - C4: unconfirmed (mempool, height -1) outputs are NEVER spent.
 *   - H1: a coin-control selection is honoured exactly (it was previously a
 *         no-op because `buildTransaction` received every unspent row).
 * Plus H2: `estimateSend` returns the REAL fee the builder will charge, so the
 * confirmation screen shows the fee that actually gets built.
 */

import { describe, test, expect } from "bun:test";
import {
  UNITS_PER_COIN,
  getNetwork,
  buildTransaction,
  type UTXO as TxUTXO,
} from "@fairco.in/core";
import type { UTXO } from "./utxo-set";
import {
  selectInputsForSend,
  estimateSend,
  estimateFeeForInputs,
} from "./coin-selection";

const MAINNET = getNetwork("mainnet");
// A real, valid FairCoin mainnet P2PKH address (recipient + change reuse it;
// only the script size matters for fee parity, which is identical for P2PKH).
const ADDR = "FQVANvQqVsLwkwBnAJ5oPDYrqcfXLak7Bf";

/** The actual fee buildTransaction charges for the given inputs + amount. */
function builtFee(selected: UTXO[], amount: bigint, feePerByte: number): bigint {
  const inputs: TxUTXO[] = selected.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    scriptPubKey: u.scriptPubKey,
  }));
  const tx = buildTransaction({
    utxos: inputs,
    recipients: [{ address: ADDR, value: amount }],
    changeAddress: ADDR,
    feePerByte: BigInt(feePerByte),
    network: MAINNET,
  });
  const totalIn = selected.reduce((s, u) => s + u.value, 0n);
  const totalOut = tx.outputs.reduce((s, o) => s + o.value, 0n);
  return totalIn - totalOut;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ONE_FAIR = UNITS_PER_COIN;

function utxo(
  txid: string,
  value: bigint,
  confirmed = true,
): UTXO {
  return {
    txid,
    vout: 0,
    address: `addr_${txid}`,
    value,
    scriptPubKey: new Uint8Array([0x76, 0xa9]),
    blockHeight: confirmed ? 100 : -1,
    confirmed,
  };
}

const FEE_PER_BYTE = 5;

// A wallet with many confirmed coins of varying size.
const MANY: UTXO[] = [
  utxo("a", 1n * ONE_FAIR),
  utxo("b", 2n * ONE_FAIR),
  utxo("c", 5n * ONE_FAIR),
  utxo("d", 10n * ONE_FAIR),
  utxo("e", 50n * ONE_FAIR),
];

// ---------------------------------------------------------------------------
// C3: a send spends only what is needed, not the whole wallet
// ---------------------------------------------------------------------------

describe("C3: selection spends only what is needed", () => {
  test("sending a small amount from many coins picks ONE large input", () => {
    // Need 3 FAIR. Largest-first should grab the 50-FAIR coin alone.
    const result = selectInputsForSend({
      candidates: MANY,
      targetValue: 3n * ONE_FAIR,
      feePerByte: FEE_PER_BYTE,
    });

    expect(result.selected.length).toBe(1);
    expect(result.selected[0].txid).toBe("e");
    // It did NOT sweep all five coins.
    expect(result.selected.length).toBeLessThan(MANY.length);
    // Change is returned to the wallet (not swept into the recipient/fee).
    expect(result.change).toBeGreaterThan(0n);
    // Total in == amount + fee + change (value is conserved).
    expect(result.selected[0].value).toBe(
      3n * ONE_FAIR + result.fee + result.change,
    );
  });

  test("a larger amount pulls in additional inputs largest-first", () => {
    // Need 58 FAIR; 50 alone is not enough, so 50 + 10 are taken.
    const result = selectInputsForSend({
      candidates: MANY,
      targetValue: 58n * ONE_FAIR,
      feePerByte: FEE_PER_BYTE,
    });
    const ids = result.selected.map((u) => u.txid).sort();
    expect(ids).toEqual(["d", "e"]);
  });
});

// ---------------------------------------------------------------------------
// C4: unconfirmed outputs are never spent
// ---------------------------------------------------------------------------

describe("C4: unconfirmed UTXOs are excluded from selection", () => {
  test("a huge unconfirmed coin is ignored; selection uses confirmed coins", () => {
    const candidates: UTXO[] = [
      utxo("confirmed-small", 5n * ONE_FAIR, true),
      utxo("unconfirmed-huge", 1000n * ONE_FAIR, false),
    ];

    const result = selectInputsForSend({
      candidates,
      targetValue: 3n * ONE_FAIR,
      feePerByte: FEE_PER_BYTE,
    });

    expect(result.selected.length).toBe(1);
    expect(result.selected[0].txid).toBe("confirmed-small");
    expect(result.selected.every((u) => u.confirmed)).toBe(true);
  });

  test("only an unconfirmed coin available => insufficient funds (never spent)", () => {
    const candidates: UTXO[] = [utxo("unconfirmed", 100n * ONE_FAIR, false)];
    expect(() =>
      selectInputsForSend({
        candidates,
        targetValue: 1n * ONE_FAIR,
        feePerByte: FEE_PER_BYTE,
      }),
    ).toThrow(/Insufficient funds/);
  });
});

// ---------------------------------------------------------------------------
// H1: coin control is honoured exactly
// ---------------------------------------------------------------------------

describe("H1: coin control spends exactly the chosen outpoints", () => {
  test("only the selected outpoints are used, even if larger coins exist", () => {
    // Pick coins 'a' (1) and 'b' (2) explicitly; 'e' (50) must NOT be touched.
    const result = selectInputsForSend({
      candidates: MANY,
      targetValue: 2n * ONE_FAIR,
      feePerByte: FEE_PER_BYTE,
      coinControl: [
        { txid: "a", vout: 0 },
        { txid: "b", vout: 0 },
      ],
    });

    const ids = result.selected.map((u) => u.txid).sort();
    expect(ids).toEqual(["a", "b"]);
    // The big coin was never selected.
    expect(result.selected.some((u) => u.txid === "e")).toBe(false);
  });

  test("coin control that cannot cover amount + fee throws insufficient", () => {
    expect(() =>
      selectInputsForSend({
        candidates: MANY,
        targetValue: 2n * ONE_FAIR,
        feePerByte: FEE_PER_BYTE,
        // Only the 1-FAIR coin selected, but we need 2 FAIR + fee.
        coinControl: [{ txid: "a", vout: 0 }],
      }),
    ).toThrow(/Insufficient funds in selected coins/);
  });

  test("coin control referencing an unconfirmed/unknown outpoint throws", () => {
    const candidates: UTXO[] = [
      utxo("confirmed", 10n * ONE_FAIR, true),
      utxo("pending", 10n * ONE_FAIR, false),
    ];
    expect(() =>
      selectInputsForSend({
        candidates,
        targetValue: 1n * ONE_FAIR,
        feePerByte: FEE_PER_BYTE,
        coinControl: [{ txid: "pending", vout: 0 }],
      }),
    ).toThrow(/unavailable or unconfirmed/);
  });
});

// ---------------------------------------------------------------------------
// H2: estimateSend returns the real fee (fee shown == fee built)
// ---------------------------------------------------------------------------

describe("H2: estimateSend reports the real fee and balance", () => {
  test("the estimated fee equals the fee selectInputsForSend charges", () => {
    const amount = 3n * ONE_FAIR;
    const est = estimateSend({
      candidates: MANY,
      targetValue: amount,
      feePerByte: FEE_PER_BYTE,
    });
    const built = selectInputsForSend({
      candidates: MANY,
      targetValue: amount,
      feePerByte: FEE_PER_BYTE,
    });

    expect(est.insufficientFunds).toBe(false);
    expect(est.fee).toBe(built.fee);
    expect(est.total).toBe(amount + built.fee);
    // And the fee matches the single-input sizing (1 input, 2 outputs).
    expect(est.fee).toBe(estimateFeeForInputs(built.selected.length, FEE_PER_BYTE));
  });

  test("maxSendable excludes unconfirmed coins and nets out the fee", () => {
    const candidates: UTXO[] = [
      utxo("c1", 10n * ONE_FAIR, true),
      utxo("c2", 20n * ONE_FAIR, true),
      utxo("u1", 999n * ONE_FAIR, false), // must be ignored
    ];
    const est = estimateSend({
      candidates,
      targetValue: 0n,
      feePerByte: FEE_PER_BYTE,
    });

    const confirmedTotal = 30n * ONE_FAIR;
    const feeForAll = estimateFeeForInputs(2, FEE_PER_BYTE);
    expect(est.maxSendable).toBe(confirmedTotal - feeForAll);

    // Sending exactly maxSendable must be coverable by selection.
    const built = selectInputsForSend({
      candidates,
      targetValue: est.maxSendable,
      feePerByte: FEE_PER_BYTE,
    });
    expect(built.selected.length).toBe(2);
  });

  test("an uncoverable amount surfaces as insufficientFunds, not a throw", () => {
    const est = estimateSend({
      candidates: MANY, // 68 FAIR confirmed total
      targetValue: 1000n * ONE_FAIR,
      feePerByte: FEE_PER_BYTE,
    });
    expect(est.insufficientFunds).toBe(true);
    expect(est.fee).toBeNull();
    expect(est.total).toBeNull();
  });

  test("coin control narrows maxSendable to the selected coins only", () => {
    const est = estimateSend({
      candidates: MANY,
      targetValue: 0n,
      feePerByte: FEE_PER_BYTE,
      coinControl: [{ txid: "a", vout: 0 }], // 1 FAIR coin only
    });
    const feeForOne = estimateFeeForInputs(1, FEE_PER_BYTE);
    expect(est.maxSendable).toBe(1n * ONE_FAIR - feeForOne);
  });
});

// ---------------------------------------------------------------------------
// H2 exactness: the reported fee equals buildTransaction's fee to the base
// unit, including the dust-change edge case where the change output is dropped.
// ---------------------------------------------------------------------------

describe("H2: fee parity with buildTransaction (dustThreshold)", () => {
  const DUST = MAINNET.minRelayFee; // 10_000

  test("normal change: reported fee == built fee", () => {
    const amount = 3n * ONE_FAIR;
    const sel = selectInputsForSend({
      candidates: MANY,
      targetValue: amount,
      feePerByte: FEE_PER_BYTE,
      dustThreshold: DUST,
    });
    expect(sel.change).toBeGreaterThan(DUST);
    expect(sel.fee).toBe(builtFee(sel.selected, amount, FEE_PER_BYTE));
  });

  test("dust change is absorbed into the fee, matching buildTransaction", () => {
    // One coin sized so change would land just inside the dust band (<= DUST):
    // baseFee(1 input) = 226*5 = 1130; pick change target = 5000 (< 10000).
    const amount = 1n * ONE_FAIR;
    const baseFee = estimateFeeForInputs(1, FEE_PER_BYTE);
    const coinValue = amount + baseFee + 5000n; // change would be 5000 (dust)
    const candidates: UTXO[] = [utxo("dustcoin", coinValue)];

    const sel = selectInputsForSend({
      candidates,
      targetValue: amount,
      feePerByte: FEE_PER_BYTE,
      dustThreshold: DUST,
    });

    // Change output dropped; the dust folds into the fee.
    expect(sel.change).toBe(0n);
    expect(sel.fee).toBe(coinValue - amount); // == baseFee + 5000
    // And that is exactly what buildTransaction charges.
    expect(sel.fee).toBe(builtFee(sel.selected, amount, FEE_PER_BYTE));
  });

  test("estimateSend reports the same dust-absorbed fee the build will charge", () => {
    const amount = 1n * ONE_FAIR;
    const baseFee = estimateFeeForInputs(1, FEE_PER_BYTE);
    const coinValue = amount + baseFee + 5000n;
    const candidates: UTXO[] = [utxo("dustcoin", coinValue)];

    const est = estimateSend({
      candidates,
      targetValue: amount,
      feePerByte: FEE_PER_BYTE,
      dustThreshold: DUST,
    });
    expect(est.fee).toBe(coinValue - amount);
    expect(est.total).toBe(amount + (coinValue - amount));
  });
});
