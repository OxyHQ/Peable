/**
 * Tests for the broadcast peer-count contract (H-1).
 *
 * The wallet's `sendTransaction` relies on the SPV client telling it how many
 * peers actually received the raw `tx` bytes. If we ever silently report
 * `peerCount > 0` when no peer actually got the message, UTXOs would be
 * marked spent for a transaction that never reached the network — the user
 * sees "sent" while the funds remain spendable to anyone else, leading to
 * a desync between the local wallet state and the chain.
 *
 * These tests pin the contract:
 *
 *   - With zero ready peers, peerCount === 0 and no peer is touched.
 *   - With N healthy peers, peerCount === N and every peer was sent "tx".
 *   - A peer that throws mid-send is NOT counted, even if other peers
 *     succeeded — the count reflects actual deliveries, not attempts.
 *   - The returned txid is the canonical reversed double-SHA256 (display
 *     byte order) so it matches what explorer URLs and the history list use.
 */

import { describe, test, expect } from 'bun:test';
import { sha256 } from '@noble/hashes/sha256';
import { broadcastTransactionToPeers, type BroadcastTarget } from './spv-client';

interface RecordingPeer extends BroadcastTarget {
  readonly received: { command: string; payload: Uint8Array }[];
}

function makePeer(opts: { fail?: boolean } = {}): RecordingPeer {
  const received: { command: string; payload: Uint8Array }[] = [];
  return {
    received,
    sendMessage(command, payload) {
      if (opts.fail) {
        throw new Error('simulated peer error');
      }
      received.push({ command, payload });
    },
  };
}

function bytesToHexReversed(bytes: Uint8Array): string {
  let hex = '';
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

describe('H-1: broadcastTransactionToPeers reports real delivery count', () => {
  const rawTx = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
  const expectedTxid = bytesToHexReversed(sha256(sha256(rawTx)));

  test('zero peers → peerCount = 0 (do NOT mark UTXOs spent)', () => {
    const result = broadcastTransactionToPeers(rawTx, []);
    expect(result.peerCount).toBe(0);
    expect(result.txid).toBe(expectedTxid);
  });

  test("N healthy peers → peerCount = N and every peer received 'tx'", () => {
    const peers = [makePeer(), makePeer(), makePeer()];
    const result = broadcastTransactionToPeers(rawTx, peers);
    expect(result.peerCount).toBe(3);
    for (const p of peers) {
      expect(p.received).toHaveLength(1);
      expect(p.received[0].command).toBe('tx');
      expect(p.received[0].payload).toEqual(rawTx);
    }
  });

  test('a failing peer does not count toward peerCount', () => {
    const ok1 = makePeer();
    const bad = makePeer({ fail: true });
    const ok2 = makePeer();
    const result = broadcastTransactionToPeers(rawTx, [ok1, bad, ok2]);
    // Only the two healthy peers were actually delivered to.
    expect(result.peerCount).toBe(2);
    expect(ok1.received).toHaveLength(1);
    expect(bad.received).toHaveLength(0);
    expect(ok2.received).toHaveLength(1);
  });

  test('all peers failing → peerCount = 0 (must be treated as not-sent)', () => {
    const peers = [makePeer({ fail: true }), makePeer({ fail: true })];
    const result = broadcastTransactionToPeers(rawTx, peers);
    expect(result.peerCount).toBe(0);
    expect(result.txid).toBe(expectedTxid);
  });

  test('returned txid matches the canonical reversed double-SHA256', () => {
    // The same byte order that wallet history rows, explorer URLs, and
    // outpoints throughout the wallet use — diverging would break linking
    // a broadcast to its history entry (H-2).
    const result = broadcastTransactionToPeers(rawTx, [makePeer()]);
    expect(result.txid).toBe(expectedTxid);
    expect(result.txid).toHaveLength(64);
  });
});
