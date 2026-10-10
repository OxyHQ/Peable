import { test, expect } from 'bun:test';
import type { PaymentIntentStatus } from '@peable.to/shared-types';
import { applyEvent, type IntentEvent } from '../intentState';

// Happy-path table: (state, event) -> expected next status.
const legal: Array<[PaymentIntentStatus, IntentEvent, PaymentIntentStatus]> = [
  ['created', 'deliver', 'awaiting_approval'],
  ['awaiting_approval', 'approve', 'approved'],
  ['awaiting_approval', 'reject', 'rejected'],
  ['approved', 'broadcast', 'broadcast'],
  ['broadcast', 'mempool_seen', 'confirming'],
  ['confirming', 'confirmed', 'settled'],
  ['broadcast', 'underpaid', 'failed'],
  ['confirming', 'underpaid', 'failed'],
  ['created', 'expire', 'expired'],
  ['awaiting_approval', 'expire', 'expired'],
];

for (const [from, event, expected] of legal) {
  test(`applyEvent('${from}', '${event}') -> '${expected}'`, () => {
    expect(applyEvent(from, event)).toBe(expected);
  });
}

// Illegal (state, event) combos must fail loud, never silently no-op.
const illegal: Array<[PaymentIntentStatus, IntentEvent]> = [
  ['settled', 'approve'],
  ['created', 'confirmed'],
  ['rejected', 'approve'],
  ['failed', 'broadcast'],
  ['created', 'reorg_below_threshold'],
];

for (const [from, event] of illegal) {
  test(`applyEvent('${from}', '${event}') throws`, () => {
    expect(() => applyEvent(from, event)).toThrow();
  });
}

test('reorg_below_threshold rewinds settled -> confirming (documented exception)', () => {
  expect(applyEvent('settled', 'reorg_below_threshold')).toBe('confirming');
});

test('mempool_seen on confirming is an idempotent re-poll -> confirming', () => {
  expect(applyEvent('confirming', 'mempool_seen')).toBe('confirming');
});

test('confirmed on an already-settled intent is an idempotent re-poll -> settled', () => {
  // The watcher may re-observe an already-settled tx with more confirmations;
  // current === target ('settled') so it is a safe no-op, not an illegal transition.
  expect(applyEvent('settled', 'confirmed')).toBe('settled');
});
