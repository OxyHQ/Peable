/**
 * Tests for in-flight UTXO reservation (review finding M4).
 *
 * The funds-safety invariant: two overlapping send flows must never both reserve
 * the same outpoint, otherwise they could select the same coins and double-spend
 * (the second tx is rejected by the network). These tests prove the reservation
 * primitive enforces that, and that coins return to the pool on release.
 */

import { describe, test, expect } from 'bun:test';
import { UtxoReservation } from './utxo-reservation';

const A = { txid: 'aa'.repeat(32), vout: 0 };
const B = { txid: 'bb'.repeat(32), vout: 1 };
const C = { txid: 'cc'.repeat(32), vout: 0 };

describe('UtxoReservation', () => {
  test('a fresh reservation holds nothing', () => {
    const r = new UtxoReservation();
    expect(r.size).toBe(0);
    expect(r.has(A.txid, A.vout)).toBe(false);
  });

  test('reserve() locks the outpoints and reports them held', () => {
    const r = new UtxoReservation();
    expect(r.reserve([A, B])).toBeNull();
    expect(r.has(A.txid, A.vout)).toBe(true);
    expect(r.has(B.txid, B.vout)).toBe(true);
    expect(r.size).toBe(2);
  });

  test('a second send cannot reserve a coin the first holds (no double-spend)', () => {
    const r = new UtxoReservation();
    // First send reserves A and B.
    expect(r.reserve([A, B])).toBeNull();
    // Second send tries to spend B (overlap) plus C. It must be refused, and
    // the conflicting outpoint reported.
    const conflict = r.reserve([B, C]);
    expect(conflict).toBe(`${B.txid}:${B.vout}`);
  });

  test('a refused reserve() is atomic — it locks NONE of its outpoints', () => {
    const r = new UtxoReservation();
    r.reserve([B]);
    // [C, B] conflicts on B; C must NOT end up reserved as a side effect, so a
    // later send can still take C.
    expect(r.reserve([C, B])).toBe(`${B.txid}:${B.vout}`);
    expect(r.has(C.txid, C.vout)).toBe(false);
    expect(r.reserve([C])).toBeNull();
  });

  test('disjoint sends reserve independently', () => {
    const r = new UtxoReservation();
    expect(r.reserve([A])).toBeNull();
    expect(r.reserve([B, C])).toBeNull();
    expect(r.size).toBe(3);
  });

  test('release() returns coins to the pool so a later send can reuse them', () => {
    const r = new UtxoReservation();
    r.reserve([A, B]);
    r.release([A]);
    expect(r.has(A.txid, A.vout)).toBe(false);
    expect(r.has(B.txid, B.vout)).toBe(true);
    // The released coin is now reservable again (e.g. after a failed send).
    expect(r.reserve([A])).toBeNull();
  });

  test('release() of an unheld outpoint is a no-op', () => {
    const r = new UtxoReservation();
    r.reserve([A]);
    r.release([B]); // B was never reserved
    expect(r.size).toBe(1);
    expect(r.has(A.txid, A.vout)).toBe(true);
  });

  test('the same txid with different vouts are distinct outpoints', () => {
    const r = new UtxoReservation();
    const v0 = { txid: A.txid, vout: 0 };
    const v1 = { txid: A.txid, vout: 1 };
    expect(r.reserve([v0])).toBeNull();
    // vout 1 of the same tx is a different coin and must still be reservable.
    expect(r.reserve([v1])).toBeNull();
    expect(r.size).toBe(2);
  });

  test('clear() drops every reservation (wallet reset/lock/switch)', () => {
    const r = new UtxoReservation();
    r.reserve([A, B, C]);
    r.clear();
    expect(r.size).toBe(0);
    expect(r.reserve([A, B, C])).toBeNull();
  });
});
