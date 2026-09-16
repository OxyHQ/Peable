/**
 * Coin selection for outgoing FairCoin transactions.
 *
 * This is the single, unit-tested decision point for *which* UTXOs an outgoing
 * transaction spends. It exists because the previous send path handed every
 * unspent row (including unconfirmed, height -1 mempool outputs) to
 * `buildTransaction`, which spends ALL provided inputs — silently sweeping the
 * whole wallet and spending unconfirmed change on every send.
 *
 * Two modes:
 *   - Automatic: largest-first selection over CONFIRMED UTXOs for the target
 *     amount + fee (delegates to {@link UTXOSet.selectCoins}).
 *   - Coin control: spend exactly the user-picked outpoints (set via the coin
 *     control screen), validated to be confirmed/available and to cover the
 *     amount + fee.
 *
 * Kept free of any I/O so the funds-correctness logic is directly testable.
 */

import { SMALLEST_UNIT_NAME } from "@fairco.in/core";
import { UTXOSet, type UTXO } from "./utxo-set";

export interface SelectInputsParams {
  /**
   * The wallet's confirmed, unspent UTXOs (in-memory shape). Unconfirmed
   * outputs MUST NOT be included by the caller; selection never spends them.
   */
  readonly candidates: readonly UTXO[];
  /** Amount to send, in base units. */
  readonly targetValue: bigint;
  /** Fee rate in base units per byte. */
  readonly feePerByte: number;
  /**
   * Coin-control selection: when non-empty, the transaction spends EXACTLY
   * these outpoints (and nothing else). When empty/undefined, automatic
   * largest-first selection runs instead.
   */
  readonly coinControl?: readonly { txid: string; vout: number }[];
  /**
   * Dust threshold (network `minRelayFee`). When provided, the returned
   * fee/change are computed with the EXACT rule `buildTransaction` uses (drop
   * the change output and absorb it into the fee when it would be <= this
   * threshold), so the displayed fee equals the built fee to the base unit.
   * When omitted, the selector's own dust rule is used.
   */
  readonly dustThreshold?: bigint;
}

export interface SelectedInputs {
  /** The UTXOs the transaction will spend. */
  readonly selected: UTXO[];
  /** The real fee implied by these inputs (matches what the builder produces). */
  readonly fee: bigint;
  /** Change returned to the wallet, in base units (0 when folded into fee). */
  readonly change: bigint;
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/**
 * Compute the fee and change for a fixed set of inputs paying a single
 * recipient, mirroring `buildTransaction`'s exact logic: the base fee assumes a
 * change output (recipient + change), and if the resulting change would be at
 * or below `dustThreshold` the change output is dropped and the dust is
 * absorbed into the fee. This is what keeps "fee shown == fee built" exact.
 */
function computeFeeAndChange(
  totalIn: bigint,
  targetValue: bigint,
  inputCount: number,
  feePerByte: number,
  dustThreshold: bigint,
): { fee: bigint; change: bigint } {
  const feeWithChange = estimateFeeForInputs(inputCount, feePerByte);
  const change = totalIn - targetValue - feeWithChange;
  if (change > dustThreshold) {
    return { fee: feeWithChange, change };
  }
  // No change output: the remainder (which may be negative-proof by the
  // caller's coverage check) is absorbed into the miner fee.
  return { fee: totalIn - targetValue, change: 0n };
}

/**
 * Select the inputs for an outgoing transaction.
 *
 * @throws If the target is non-positive, a coin-control outpoint is missing /
 *         unconfirmed, or the selection cannot cover the amount + fee.
 */
export function selectInputsForSend(
  params: SelectInputsParams,
): SelectedInputs {
  const { candidates, targetValue, feePerByte, coinControl, dustThreshold } =
    params;

  if (targetValue <= 0n) {
    throw new Error("Target value must be positive");
  }

  // Build a confirmed-only working set. Even if a caller accidentally passes an
  // unconfirmed UTXO, this guarantees selection never spends it.
  const confirmed = new UTXOSet();
  for (const utxo of candidates) {
    if (utxo.confirmed) {
      confirmed.add(utxo);
    }
  }

  // Pick the inputs (coin control vs automatic), then derive the final
  // fee/change. When dustThreshold is supplied, fee/change are computed with
  // buildTransaction's exact rule so the displayed and built fees match.
  let selected: UTXO[];
  if (coinControl && coinControl.length > 0) {
    selected = [];
    for (const { txid, vout } of coinControl) {
      const utxo = confirmed.get(txid, vout);
      if (!utxo) {
        throw new Error(
          `Selected coin ${outpointKey(txid, vout)} is unavailable or unconfirmed`,
        );
      }
      selected.push(utxo);
    }
  } else {
    // Automatic largest-first selection over confirmed coins.
    selected = confirmed.selectCoins(targetValue, feePerByte).selected;
  }

  const total = selected.reduce((sum, u) => sum + u.value, 0n);
  const baseFee = estimateFeeForInputs(selected.length, feePerByte);
  if (total < targetValue + baseFee) {
    throw new Error(
      `Insufficient funds in selected coins: need ${(targetValue + baseFee).toString()} ${SMALLEST_UNIT_NAME}, ` +
        `selected ${total.toString()} ${SMALLEST_UNIT_NAME}`,
    );
  }

  if (dustThreshold !== undefined) {
    const { fee, change } = computeFeeAndChange(
      total,
      targetValue,
      selected.length,
      feePerByte,
      dustThreshold,
    );
    return { selected, fee, change };
  }

  return { selected, fee: baseFee, change: total - targetValue - baseFee };
}

/**
 * Estimate the fee for a transaction spending `inputCount` inputs and paying a
 * recipient plus a change output. Mirrors {@link UTXOSet.selectCoins}'s sizing
 * (recipient + change = 2 outputs) so the displayed and built fees agree.
 */
export function estimateFeeForInputs(
  inputCount: number,
  feePerByte: number,
): bigint {
  // P2PKH sizing, identical to utxo-set.ts: overhead + inputs*148 + outputs*34.
  const TX_OVERHEAD_BYTES = 10;
  const BYTES_PER_INPUT = 148;
  const BYTES_PER_OUTPUT = 34;
  const OUTPUT_COUNT = 2; // recipient + change
  const size =
    TX_OVERHEAD_BYTES + inputCount * BYTES_PER_INPUT + OUTPUT_COUNT * BYTES_PER_OUTPUT;
  return BigInt(size) * BigInt(feePerByte);
}

export interface SendEstimate {
  /** Real fee in base units for the selected inputs, or null if unspendable. */
  readonly fee: bigint | null;
  /** amount + fee, or null when the amount cannot be covered. */
  readonly total: bigint | null;
  /** True when the candidate coins cannot cover amount + fee. */
  readonly insufficientFunds: boolean;
  /** Largest amount sendable from the candidate coins (sum minus its fee), >= 0. */
  readonly maxSendable: bigint;
}

/**
 * Compute the real, pre-broadcast cost of sending `targetValue` from a set of
 * confirmed candidate coins (optionally constrained to a coin-control subset).
 *
 * Returns the exact fee the builder would charge for the inputs that selection
 * picks — the value the send confirmation must display so "fee shown == fee
 * built" — plus the maximum amount currently sendable. Never throws: an
 * uncoverable amount surfaces as `insufficientFunds`, not an exception.
 */
export function estimateSend(params: SelectInputsParams): SendEstimate {
  const { candidates, targetValue, feePerByte, coinControl } = params;

  // The pool that "Max" and the insufficient-funds check reason about: the
  // coin-control subset when active, otherwise all confirmed candidates.
  const confirmed = candidates.filter((u) => u.confirmed);
  const pool =
    coinControl && coinControl.length > 0
      ? confirmed.filter((u) =>
          coinControl.some((c) => c.txid === u.txid && c.vout === u.vout),
        )
      : confirmed;

  const poolTotal = pool.reduce((sum, u) => sum + u.value, 0n);
  const feeForFullPool =
    pool.length > 0 ? estimateFeeForInputs(pool.length, feePerByte) : 0n;
  const maxSendable =
    poolTotal > feeForFullPool ? poolTotal - feeForFullPool : 0n;

  if (targetValue <= 0n) {
    return { fee: null, total: null, insufficientFunds: false, maxSendable };
  }

  try {
    const selection = selectInputsForSend(params);
    return {
      fee: selection.fee,
      total: targetValue + selection.fee,
      insufficientFunds: false,
      maxSendable,
    };
  } catch {
    // selectInputsForSend throws only when the coins cannot cover amount + fee
    // (or a coin-control outpoint is missing). Either way the amount is not
    // sendable as configured.
    return { fee: null, total: null, insufficientFunds: true, maxSendable };
  }
}
