/**
 * Tests for the Explorer WebSocket protocol codec.
 *
 * These pin the frame validation the realtime socket relies on: `new-block`
 * and `block-count` yield a typed chain-tip height; every other (or malformed)
 * frame is ignored; server `error` frames are surfaced. The socket feeds this
 * untrusted input, so the parser must never throw and never mis-classify.
 */

import { describe, test, expect } from 'bun:test';
import { parseTipUpdate, parseServerError } from './explorer-events';

describe('parseTipUpdate', () => {
  test('extracts the height from a new-block frame', () => {
    expect(
      parseTipUpdate({
        type: 'new-block',
        network: 'mainnet',
        timestamp: 1,
        data: { hash: 'abc', height: 500000, tx: [] },
      }),
    ).toEqual({ network: 'mainnet', height: 500000 });
  });

  test('extracts the height from a block-count frame', () => {
    expect(
      parseTipUpdate({
        type: 'block-count',
        network: 'testnet',
        timestamp: 1,
        data: { height: 12345, previousHeight: 12344 },
      }),
    ).toEqual({ network: 'testnet', height: 12345 });
  });

  test('returns null for non-tip event types', () => {
    for (const type of ['ping', 'pong', 'subscribe', 'network-stats', 'mempool-update']) {
      expect(parseTipUpdate({ type, network: 'mainnet', timestamp: 1 })).toBeNull();
    }
  });

  test('returns null for malformed / non-object input', () => {
    expect(parseTipUpdate(null)).toBeNull();
    expect(parseTipUpdate('new-block')).toBeNull();
    expect(parseTipUpdate({ type: 'new-block', network: 'mainnet', data: {} })).toBeNull();
    expect(parseTipUpdate({ type: 'new-block', network: 'bogus', data: { height: 1 } })).toBeNull();
  });
});

describe('parseServerError', () => {
  test('extracts a server error frame', () => {
    expect(
      parseServerError({
        type: 'error',
        network: 'mainnet',
        timestamp: 1,
        data: { code: 'RATE_LIMIT', message: 'Too many connections' },
      }),
    ).toEqual({ code: 'RATE_LIMIT', message: 'Too many connections' });
  });

  test('returns null for non-error frames', () => {
    expect(
      parseServerError({ type: 'new-block', network: 'mainnet', data: { height: 1 } }),
    ).toBeNull();
  });
});
