/**
 * UTXO set management for FairCoin wallet.
 * Tracks unspent transaction outputs, computes balances,
 * and performs coin selection for transaction building.
 */

import { UNITS_PER_COIN, SMALLEST_UNIT_NAME } from "@fairco.in/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UTXO {
  readonly txid: string;
  readonly vout: number;
  readonly address: string;
  readonly value: bigint; // satoshis
  readonly scriptPubKey: Uint8Array;
  readonly blockHeight: number;
  readonly confirmed: boolean;
}

interface CoinSelectionResult {
  selected: UTXO[];
  fee: bigint;
  change: bigint;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Masternode collateral: exactly 5,000 FAIR in base units.
 * (5000 * UNITS_PER_COIN)
 */
const MASTERNODE_COLLATERAL_SATS = 5_000n * UNITS_PER_COIN;

/**
 * Estimated transaction overhead in bytes (version + locktime + input/output counts).
 */
const TX_OVERHEAD_BYTES = 10;

/**
 * Estimated bytes per input (outpoint + scriptSig + sequence).
 * Conservative estimate for P2PKH with compressed key.
 */
const BYTES_PER_INPUT = 148;

/**
 * Estimated bytes per output (value + scriptPubKey).
 */
const BYTES_PER_OUTPUT = 34;

// ---------------------------------------------------------------------------
// UTXO Set
// ---------------------------------------------------------------------------

export class UTXOSet {
  /** Map key: "txid:vout" */
  private readonly utxos: Map<string, UTXO> = new Map();

  /**
   * Add a UTXO to the set.
   */
  add(utxo: UTXO): void {
    const key = utxoKey(utxo.txid, utxo.vout);
    this.utxos.set(key, utxo);
  }

  /**
   * Whether a UTXO with the given outpoint is currently in the set (unspent).
   */
  has(txid: string, vout: number): boolean {
    return this.utxos.has(utxoKey(txid, vout));
  }

  /**
   * Get a single UTXO by outpoint, or undefined if it is not in the set.
   */
  get(txid: string, vout: number): UTXO | undefined {
    return this.utxos.get(utxoKey(txid, vout));
  }

  /**
   * Mark a UTXO as spent and remove it from the set.
   */
  spend(txid: string, vout: number): void {
    const key = utxoKey(txid, vout);
    this.utxos.delete(key);
  }

  /**
   * Get total balance (confirmed + unconfirmed).
   */
  getBalance(): bigint {
    let total = 0n;
    for (const utxo of this.utxos.values()) {
      total += utxo.value;
    }
    return total;
  }

  /**
   * Get only confirmed balance.
   */
  getConfirmedBalance(): bigint {
    let total = 0n;
    for (const utxo of this.utxos.values()) {
      if (utxo.confirmed) {
        total += utxo.value;
      }
    }
    return total;
  }

  /**
   * Get only unconfirmed balance.
   */
  getUnconfirmedBalance(): bigint {
    let total = 0n;
    for (const utxo of this.utxos.values()) {
      if (!utxo.confirmed) {
        total += utxo.value;
      }
    }
    return total;
  }

  /**
   * Select coins to cover the target value plus fees.
   * Uses a largest-first strategy for simplicity.
   *
   * @param targetValue - Amount to send in satoshis.
   * @param feePerByte - Fee rate in satoshis per byte.
   * @returns Selected UTXOs, total fee, and change amount.
   * @throws If insufficient funds.
   */
  selectCoins(
    targetValue: bigint,
    feePerByte: number,
  ): CoinSelectionResult {
    if (targetValue <= 0n) {
      throw new Error("Target value must be positive");
    }

    // Sort UTXOs by value descending (largest first)
    const available = Array.from(this.utxos.values())
      .filter((u) => u.confirmed)
      .sort((a, b) => {
        if (a.value > b.value) return -1;
        if (a.value < b.value) return 1;
        return 0;
      });

    const selected: UTXO[] = [];
    let selectedTotal = 0n;
    const feeRate = BigInt(feePerByte);

    for (const utxo of available) {
      selected.push(utxo);
      selectedTotal += utxo.value;

      // Estimate fee with current selection
      // Assume 1 output for recipient + 1 for change
      const estimatedSize = estimateTxSize(selected.length, 2);
      const estimatedFee = BigInt(estimatedSize) * feeRate;

      if (selectedTotal >= targetValue + estimatedFee) {
        const change = selectedTotal - targetValue - estimatedFee;

        // If change is dust (less than the cost to spend it), fold into fee
        const dustThreshold = BigInt(BYTES_PER_INPUT) * feeRate;
        if (change > 0n && change < dustThreshold) {
          // No change output; the excess becomes part of the miner fee
          return {
            selected,
            fee: selectedTotal - targetValue,
            change: 0n,
          };
        }

        return {
          selected,
          fee: estimatedFee,
          change,
        };
      }
    }

    throw new Error(
      `Insufficient funds: need ${targetValue.toString()} ${SMALLEST_UNIT_NAME} + fee, ` +
        `but only ${selectedTotal.toString()} ${SMALLEST_UNIT_NAME} available`,
    );
  }

  /**
   * Get all UTXOs for a specific address.
   */
  getUTXOsForAddress(address: string): UTXO[] {
    const result: UTXO[] = [];
    for (const utxo of this.utxos.values()) {
      if (utxo.address === address) {
        result.push(utxo);
      }
    }
    return result;
  }

  /**
   * Get all UTXOs in the set.
   */
  getAllUTXOs(): UTXO[] {
    return Array.from(this.utxos.values());
  }

  /**
   * Get UTXOs with exactly 5,000 FAIR (masternode collateral).
   */
  getMasternodeUTXOs(): UTXO[] {
    const result: UTXO[] = [];
    for (const utxo of this.utxos.values()) {
      if (utxo.value === MASTERNODE_COLLATERAL_SATS && utxo.confirmed) {
        result.push(utxo);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utxoKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function estimateTxSize(inputCount: number, outputCount: number): number {
  return (
    TX_OVERHEAD_BYTES +
    inputCount * BYTES_PER_INPUT +
    outputCount * BYTES_PER_OUTPUT
  );
}
