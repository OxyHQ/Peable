/**
 * Tests for the chain-reorg UTXO rewind (SPV_AUDIT.md §4.4).
 *
 * Proves the rewind restores the correct balance: outputs created in orphaned
 * blocks are removed, and outputs whose spending transaction was orphaned are
 * restored to unspent — never corrupting the balance. These are the exact
 * semantics `Database.rewindToHeight` implements in SQL.
 */

import { describe, test, expect } from 'bun:test';
import { UNITS_PER_COIN } from '@fairco.in/core';
import { computeReorgRewind, utxoSetFromRows, type RewindableUTXO } from './reorg-rewind';

const FAIR = UNITS_PER_COIN;

function utxo(
  txid: string,
  vout: number,
  value: bigint,
  blockHeight: number,
  opts: { spent?: boolean; spentHeight?: number } = {},
): RewindableUTXO {
  return {
    txid,
    vout,
    address: `addr_${txid}_${vout}`,
    value,
    scriptPubKey: new Uint8Array([0x76, 0xa9]),
    blockHeight,
    spent: opts.spent ?? false,
    spentHeight: opts.spentHeight ?? (opts.spent ? blockHeight : 0),
  };
}

describe('computeReorgRewind', () => {
  test('removes outputs created in orphaned blocks', () => {
    const rows = [
      utxo('a', 0, 10n * FAIR, 100), // survives (at fork)
      utxo('b', 0, 5n * FAIR, 105), // orphaned (above fork)
      utxo('c', 0, 7n * FAIR, 110), // orphaned
    ];
    const result = computeReorgRewind(rows, 100);

    expect(result.deleted.map((r) => r.txid).sort()).toEqual(['b', 'c']);
    expect(result.restored.length).toBe(0);

    const balance = utxoSetFromRows(result.unspentAfter).getBalance();
    expect(balance).toBe(10n * FAIR); // only "a" remains
  });

  test('restores outputs whose spending tx was orphaned', () => {
    const rows = [
      // Received at height 90, spent at height 108 (which gets orphaned).
      utxo('recv', 0, 20n * FAIR, 90, { spent: true, spentHeight: 108 }),
    ];
    const result = computeReorgRewind(rows, 100);

    expect(result.deleted.length).toBe(0);
    expect(result.restored.length).toBe(1);
    expect(result.restored[0].spent).toBe(false);

    // The spend is undone, so the 20 FAIR is spendable again.
    const balance = utxoSetFromRows(result.unspentAfter).getBalance();
    expect(balance).toBe(20n * FAIR);
  });

  test('does NOT restore a spend that is still in the active chain', () => {
    const rows = [
      // Spent at height 95, which is at/below the fork — the spend stands.
      utxo('recv', 0, 20n * FAIR, 90, { spent: true, spentHeight: 95 }),
    ];
    const result = computeReorgRewind(rows, 100);

    expect(result.restored.length).toBe(0);
    expect(utxoSetFromRows(result.unspentAfter).getBalance()).toBe(0n);
  });

  test('a confirmed unspent output below the fork is untouched', () => {
    const rows = [utxo('a', 0, 3n * FAIR, 50)];
    const result = computeReorgRewind(rows, 100);
    expect(result.deleted.length).toBe(0);
    expect(result.restored.length).toBe(0);
    expect(utxoSetFromRows(result.unspentAfter).getBalance()).toBe(3n * FAIR);
  });

  test('combined scenario keeps the balance correct end-to-end', () => {
    // Pre-fork holdings: a (10) + b (4) = 14 FAIR, both unspent and confirmed.
    // In an orphaned block: receive c (6) and spend b. After rewind the chain
    // above height 100 vanishes, so: c is gone, b's spend is undone.
    // Correct balance = a (10) + b (4) = 14 FAIR.
    const rows = [
      utxo('a', 0, 10n * FAIR, 80),
      utxo('b', 0, 4n * FAIR, 80, { spent: true, spentHeight: 106 }),
      utxo('c', 0, 6n * FAIR, 106),
    ];
    const result = computeReorgRewind(rows, 100);

    expect(result.deleted.map((r) => r.txid)).toEqual(['c']);
    expect(result.restored.map((r) => r.txid)).toEqual(['b']);

    const balance = utxoSetFromRows(result.unspentAfter).getBalance();
    expect(balance).toBe(14n * FAIR);
  });

  test('an output created AND spent above the fork nets to nothing', () => {
    // Created at 105 and spent at 107, both orphaned. It must simply disappear:
    // deleted (created above fork) and NOT double-restored.
    const rows = [utxo('ephemeral', 0, 9n * FAIR, 105, { spent: true, spentHeight: 107 })];
    const result = computeReorgRewind(rows, 100);

    expect(result.deleted.map((r) => r.txid)).toEqual(['ephemeral']);
    expect(result.restored.length).toBe(0);
    expect(utxoSetFromRows(result.unspentAfter).getBalance()).toBe(0n);
  });
});
