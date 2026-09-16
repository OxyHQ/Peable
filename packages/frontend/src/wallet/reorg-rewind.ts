/**
 * Pure specification of the UTXO rewind performed on a chain reorg
 * (SPV_AUDIT.md §4.4).
 *
 * When a longer chain orphans every block above `forkHeight`, the wallet must
 * undo their effects without corrupting the balance:
 *
 *   - An output **created** in an orphaned block (`block_height > forkHeight`)
 *     no longer exists and is removed.
 *   - An output **spent** by a transaction in an orphaned block
 *     (`spent_height > forkHeight`) is restored to unspent — the spend did not
 *     happen on the winning chain.
 *
 * `Database.rewindToHeight` implements exactly these two rules in SQL; this pure
 * function is the canonical, unit-tested specification of that behaviour and is
 * used to compute the post-rewind balance in tests (the SQLite layer is a
 * native module that cannot run under `bun test`).
 */

import { UTXOSet, type UTXO } from "@peable.to/pay";

/** A persisted UTXO row, including reorg-tracking columns. */
export interface RewindableUTXO {
  readonly txid: string;
  readonly vout: number;
  readonly address: string;
  readonly value: bigint;
  readonly scriptPubKey: Uint8Array;
  readonly blockHeight: number;
  /** True if currently marked spent. */
  readonly spent: boolean;
  /** Height the spend was confirmed at (-1 unconfirmed, 0 unknown/legacy). */
  readonly spentHeight: number;
}

export interface RewindResult {
  /** Outputs deleted because they were created in an orphaned block. */
  readonly deleted: RewindableUTXO[];
  /** Outputs restored to unspent because their spend was orphaned. */
  readonly restored: RewindableUTXO[];
  /** The full set of UTXOs that are unspent after the rewind. */
  readonly unspentAfter: RewindableUTXO[];
}

/**
 * Compute the effect of rewinding to `forkHeight` over a set of UTXO rows.
 *
 * @param rows       All UTXO rows (spent and unspent) currently persisted.
 * @param forkHeight Height of the last block common to both chains.
 */
export function computeReorgRewind(
  rows: readonly RewindableUTXO[],
  forkHeight: number,
): RewindResult {
  const deleted: RewindableUTXO[] = [];
  const restored: RewindableUTXO[] = [];
  const unspentAfter: RewindableUTXO[] = [];

  for (const row of rows) {
    // 1. Remove outputs created in an orphaned block.
    if (row.blockHeight > forkHeight) {
      deleted.push(row);
      continue;
    }

    // 2. Restore outputs whose spending tx was orphaned.
    if (row.spent && row.spentHeight > forkHeight) {
      const restoredRow: RewindableUTXO = {
        ...row,
        spent: false,
        spentHeight: 0,
      };
      restored.push(restoredRow);
      unspentAfter.push(restoredRow);
      continue;
    }

    if (!row.spent) {
      unspentAfter.push(row);
    }
  }

  return { deleted, restored, unspentAfter };
}

/**
 * Build a {@link UTXOSet} from the unspent rows that survive a rewind, so a test
 * (or caller) can read the post-rewind balance directly.
 */
export function utxoSetFromRows(rows: readonly RewindableUTXO[]): UTXOSet {
  const set = new UTXOSet();
  for (const row of rows) {
    const utxo: UTXO = {
      txid: row.txid,
      vout: row.vout,
      address: row.address,
      value: row.value,
      scriptPubKey: row.scriptPubKey,
      blockHeight: row.blockHeight,
      confirmed: row.blockHeight >= 0,
    };
    set.add(utxo);
  }
  return set;
}
