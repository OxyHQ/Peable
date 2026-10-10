/**
 * Tests for the app-lock gate logic (review finding C1).
 *
 * The lock store is the single source of truth the root LockGate overlay and
 * the navigation guards read to decide whether ANY authenticated screen may be
 * shown. These tests prove the gate starts closed, opens only on an explicit
 * unlock, re-closes on lock, and that the boot decision tracks PIN existence.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { useLockStore } from './lock-store';

function resetStore(): void {
  useLockStore.setState({
    locked: true,
    resolved: false,
    pendingDeepLink: null,
  });
}

describe('lock gate: default state', () => {
  beforeEach(resetStore);

  test('starts LOCKED and unresolved so nothing authenticated can render', () => {
    const s = useLockStore.getState();
    expect(s.locked).toBe(true);
    expect(s.resolved).toBe(false);
  });
});

describe('lock gate: transitions', () => {
  beforeEach(resetStore);

  test('unlock() opens the gate and marks it resolved', () => {
    useLockStore.getState().unlock();
    const s = useLockStore.getState();
    expect(s.locked).toBe(false);
    expect(s.resolved).toBe(true);
  });

  test('lock() re-closes the gate (auto-lock / manual lock)', () => {
    useLockStore.getState().unlock();
    useLockStore.getState().lock();
    expect(useLockStore.getState().locked).toBe(true);
  });

  test('markNoPinUnlocked() opens the gate for PIN-less wallets', () => {
    useLockStore.getState().markNoPinUnlocked();
    const s = useLockStore.getState();
    expect(s.locked).toBe(false);
    expect(s.resolved).toBe(true);
  });
});

describe('lock gate: boot decision tracks PIN existence', () => {
  beforeEach(resetStore);

  test('a wallet WITH a PIN stays locked after resolveInitialLock(true)', () => {
    const willLock = useLockStore.getState().resolveInitialLock(true);
    expect(willLock).toBe(true);
    const s = useLockStore.getState();
    expect(s.locked).toBe(true);
    expect(s.resolved).toBe(true);
  });

  test('a wallet WITHOUT a PIN unlocks after resolveInitialLock(false)', () => {
    const willLock = useLockStore.getState().resolveInitialLock(false);
    expect(willLock).toBe(false);
    expect(useLockStore.getState().locked).toBe(false);
  });
});

describe('N-10: deep-link queue while locked', () => {
  beforeEach(resetStore);

  test('queueDeepLink stashes the URL and a capture timestamp', () => {
    useLockStore.getState().queueDeepLink('faircoin:FabcDEF?amount=1.5');
    const pending = useLockStore.getState().pendingDeepLink;
    expect(pending).not.toBeNull();
    expect(pending?.url).toBe('faircoin:FabcDEF?amount=1.5');
    expect(typeof pending?.capturedAt).toBe('number');
  });

  test('consumePendingDeepLink returns and clears the URL', () => {
    useLockStore.getState().queueDeepLink('faircoin:Fxyz');
    const popped = useLockStore.getState().consumePendingDeepLink();
    expect(popped).toBe('faircoin:Fxyz');
    expect(useLockStore.getState().pendingDeepLink).toBeNull();
    // A second pop returns null — no replay across unlocks.
    expect(useLockStore.getState().consumePendingDeepLink()).toBeNull();
  });

  test('consumePendingDeepLink drops URLs older than the freshness window', () => {
    // Manually plant an old entry: 1h ago, window default is 5m.
    useLockStore.setState({
      pendingDeepLink: {
        url: 'faircoin:Fstale',
        capturedAt: Date.now() - 60 * 60 * 1000,
      },
    });
    const popped = useLockStore.getState().consumePendingDeepLink();
    expect(popped).toBeNull();
    // Stale entry is cleared too — we don't want to keep retrying it.
    expect(useLockStore.getState().pendingDeepLink).toBeNull();
  });

  test('a second queued URL supersedes the first (latest wins)', () => {
    useLockStore.getState().queueDeepLink('faircoin:Fone');
    useLockStore.getState().queueDeepLink('faircoin:Ftwo');
    expect(useLockStore.getState().consumePendingDeepLink()).toBe('faircoin:Ftwo');
  });

  test('consumePendingDeepLink honours a caller-supplied maxAgeMs', () => {
    useLockStore.setState({
      pendingDeepLink: {
        url: 'faircoin:Fmaybe',
        capturedAt: Date.now() - 2 * 1000,
      },
    });
    // 1s window → entry is stale.
    expect(useLockStore.getState().consumePendingDeepLink(1000)).toBeNull();
  });
});
