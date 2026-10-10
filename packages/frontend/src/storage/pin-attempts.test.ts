/**
 * Tests for the persistent PIN-attempt policy (N-3).
 *
 * Targets the pure helpers — `computeNextPinAttemptState` and
 * `lockoutSecondsForAttempts` — so we can exercise the brute-force-defence
 * back-off without spinning up the storage adapter (kv-store pulls in
 * react-native which can't load in the bun test runner). The persisted-
 * round-trip is the responsibility of `loadPinAttempts` / `recordPinFailure`
 * over kv-store, which is itself a thin wrapper around secure-store /
 * localStorage that the integration suites cover at the device level.
 */

import { describe, test, expect } from 'bun:test';
import {
  computeNextPinAttemptState,
  lockoutSecondsForAttempts,
  PIN_MAX_ATTEMPTS,
  PIN_BASE_LOCKOUT_SECONDS,
  PIN_MAX_LOCKOUT_SECONDS,
  type PinAttemptState,
} from './pin-attempts-policy';

const NOW = 1_700_000_000_000; // arbitrary fixed wall clock for determinism
const EMPTY: PinAttemptState = { failedAttempts: 0, lockedUntil: 0 };

describe('N-3: PIN attempt back-off math', () => {
  test('no lockout under the threshold', () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      expect(lockoutSecondsForAttempts(i)).toBe(0);
    }
  });

  test('the first lockout uses the base duration', () => {
    expect(lockoutSecondsForAttempts(PIN_MAX_ATTEMPTS)).toBe(PIN_BASE_LOCKOUT_SECONDS);
  });

  test('each subsequent triggered lockout doubles the wait', () => {
    expect(lockoutSecondsForAttempts(PIN_MAX_ATTEMPTS + 1)).toBe(PIN_BASE_LOCKOUT_SECONDS * 2);
    expect(lockoutSecondsForAttempts(PIN_MAX_ATTEMPTS + 2)).toBe(PIN_BASE_LOCKOUT_SECONDS * 4);
    expect(lockoutSecondsForAttempts(PIN_MAX_ATTEMPTS + 3)).toBe(PIN_BASE_LOCKOUT_SECONDS * 8);
  });

  test('back-off is capped at PIN_MAX_LOCKOUT_SECONDS', () => {
    // Push the back-off well above the cap.
    const huge = PIN_MAX_ATTEMPTS + 30;
    expect(lockoutSecondsForAttempts(huge)).toBe(PIN_MAX_LOCKOUT_SECONDS);
  });
});

describe('N-3: PIN attempt state transitions', () => {
  test('an attempt below the threshold only increments the counter', () => {
    const next = computeNextPinAttemptState(EMPTY, NOW);
    expect(next.failedAttempts).toBe(1);
    expect(next.lockedUntil).toBe(0);
  });

  test('crossing the threshold sets lockedUntil = NOW + base * 1000', () => {
    const beforeLast: PinAttemptState = {
      failedAttempts: PIN_MAX_ATTEMPTS - 1,
      lockedUntil: 0,
    };
    const next = computeNextPinAttemptState(beforeLast, NOW);
    expect(next.failedAttempts).toBe(PIN_MAX_ATTEMPTS);
    expect(next.lockedUntil).toBe(NOW + PIN_BASE_LOCKOUT_SECONDS * 1000);
  });

  test('an additional failure after the first lockout uses the doubled back-off', () => {
    // The lock screen does NOT reset the counter when the timer expires
    // (deliberate, see LockScreenContent), so the next failure feeds into
    // the doubling math.
    const justExpired: PinAttemptState = {
      failedAttempts: PIN_MAX_ATTEMPTS,
      lockedUntil: NOW - 1, // already past
    };
    const next = computeNextPinAttemptState(justExpired, NOW);
    expect(next.failedAttempts).toBe(PIN_MAX_ATTEMPTS + 1);
    expect(next.lockedUntil).toBe(NOW + PIN_BASE_LOCKOUT_SECONDS * 2 * 1000);
  });

  test("a sustained loop of 'wait → fail again' produces exponential back-off (brute-force resistance)", () => {
    // Simulate an attacker who respects the base lockout, then tries again.
    // The cumulative wait time after k extra failed attempts must grow at
    // least as 1 + 2 + 4 + 8 + ... so the search space cost rises sharply.
    let state: PinAttemptState = {
      failedAttempts: PIN_MAX_ATTEMPTS,
      lockedUntil: 0,
    };
    let totalWaitSeconds = PIN_BASE_LOCKOUT_SECONDS;
    let now = NOW;
    for (let extra = 1; extra <= 5; extra++) {
      now += state.lockedUntil - (state.lockedUntil - 1); // advance past lockout
      now = state.lockedUntil + 1;
      const previous = state.lockedUntil;
      state = computeNextPinAttemptState(state, now);
      // Each new lockout deadline is now + base * 2^extra seconds.
      const wait = (state.lockedUntil - now) / 1000;
      expect(wait).toBe(PIN_BASE_LOCKOUT_SECONDS * (1 << extra));
      totalWaitSeconds += wait;
      expect(state.lockedUntil).toBeGreaterThan(previous);
    }
    // 30 + 60 + 120 + 240 + 480 + 960 = 1890 s ≈ 31.5 min after 6 failed
    // attempts past the initial threshold (≈ 11 failed PINs total). For a
    // 10⁶ space, even sustained the search would take centuries.
    expect(totalWaitSeconds).toBeGreaterThanOrEqual(
      PIN_BASE_LOCKOUT_SECONDS * (1 + 2 + 4 + 8 + 16 + 32), // 63x base
    );
  });
});
