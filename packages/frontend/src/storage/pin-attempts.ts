/**
 * Persistent PIN-attempt tracker (N-3).
 *
 * The wallet's PIN gate enforces a max-attempts lockout. Keeping the counter
 * in component state alone is bypassable: an attacker can try N-1 PINs,
 * force-kill the app before the lockout fires, re-open the app, and start
 * fresh with the counter reset. For a 6-digit numeric PIN (10⁶ space)
 * without any per-attempt cost, that turns brute-force into a few-hours job.
 *
 * This module stores `{ failedAttempts, lockedUntil }` in the same secure
 * key-value store as the PIN record (Keychain / EncryptedSharedPreferences
 * on device, localStorage on web/Electron). The values survive force-quit
 * and reboot — the next launch sees the same lockout the user was waiting
 * out, so abandoning the app does not reset the policy.
 *
 * Exponential back-off: as `failedAttempts` keeps growing past the normal
 * lockout threshold, the lockout window doubles, so a determined attacker
 * can't simply respect the base lockout in a loop. Pure back-off math lives
 * in {@link ./pin-attempts-policy} so it is testable without a platform
 * storage dependency.
 */

import { getItemAsync, setItemAsync, deleteItemAsync } from './kv-store';
import { computeNextPinAttemptState, type PinAttemptState } from './pin-attempts-policy';

// Re-export the public surface so callers only import from one module.
export {
  PIN_MAX_ATTEMPTS,
  PIN_BASE_LOCKOUT_SECONDS,
  PIN_MAX_LOCKOUT_SECONDS,
  lockoutSecondsForAttempts,
  computeNextPinAttemptState,
  type PinAttemptState,
} from './pin-attempts-policy';

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

/**
 * Single key holding the JSON-encoded `PinAttemptState`. Kept separate from
 * the PIN record so a corrupt attempts blob can be reset without invalidating
 * the PIN itself.
 */
const PIN_ATTEMPTS_KEY = 'fairwallet_pin_attempts';

const EMPTY_STATE: PinAttemptState = {
  failedAttempts: 0,
  lockedUntil: 0,
};

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Read the persisted state. Returns the empty state if no record exists, the
 * record is malformed, or the store is unavailable. Defensive parsing on the
 * way in means a tampered/corrupted blob fails closed (no implicit "reset"
 * by writing rubbish, but also no crash).
 */
export async function loadPinAttempts(): Promise<PinAttemptState> {
  try {
    const raw = await getItemAsync(PIN_ATTEMPTS_KEY);
    if (raw === null) return EMPTY_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('failedAttempts' in parsed) ||
      !('lockedUntil' in parsed)
    ) {
      return EMPTY_STATE;
    }
    const failedAttempts = (parsed as { failedAttempts: unknown }).failedAttempts;
    const lockedUntil = (parsed as { lockedUntil: unknown }).lockedUntil;
    if (!isFiniteNonNegative(failedAttempts) || !isFiniteNonNegative(lockedUntil)) {
      return EMPTY_STATE;
    }
    return {
      failedAttempts: Math.floor(failedAttempts),
      lockedUntil: Math.floor(lockedUntil),
    };
  } catch {
    return EMPTY_STATE;
  }
}

async function persist(state: PinAttemptState): Promise<void> {
  try {
    await setItemAsync(PIN_ATTEMPTS_KEY, JSON.stringify(state));
  } catch {
    // Persistence errors must not crash the lock screen; the worst case is
    // that a force-quit lets an attacker reset the in-memory counter. Better
    // than an unrecoverable lock UI.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a failed PIN attempt. Increments `failedAttempts`, schedules a new
 * `lockedUntil` if the threshold was crossed, and returns the post-update
 * state so the UI can render the new attempt count / lockout deadline
 * without a separate read.
 */
export async function recordPinFailure(): Promise<PinAttemptState> {
  const current = await loadPinAttempts();
  const next = computeNextPinAttemptState(current, Date.now());
  await persist(next);
  return next;
}

/**
 * Clear the attempts state after a successful PIN verification or biometric
 * unlock. Idempotent — safe to call when no lockout exists.
 */
export async function clearPinAttempts(): Promise<void> {
  try {
    await deleteItemAsync(PIN_ATTEMPTS_KEY);
  } catch {
    // best-effort; the next persist() will overwrite.
  }
}
