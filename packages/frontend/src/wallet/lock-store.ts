/**
 * App-lock state (review finding C1).
 *
 * The PIN lock used to be enforced only by navigating to the `/lock` route on
 * boot. That was bypassable: the `(tabs)` group had no guard, deep links pushed
 * straight into authenticated screens, and keys/SPV were loaded BEFORE the PIN
 * was ever checked. This store is the single source of truth for "is the app
 * locked", consumed by the root-level lock overlay (which covers every
 * authenticated screen) and by the navigation guards.
 *
 * `locked` starts `true` so nothing authenticated can render until boot has
 * decided whether a PIN exists; `resolveInitialLock` then either keeps it
 * locked (PIN set) or unlocks it (no PIN / no wallet).
 */

import { create } from 'zustand';

export interface LockState {
  /** True while the app is locked; authenticated UI must not be shown. */
  locked: boolean;
  /** Whether the initial lock decision has been made (PIN existence checked). */
  resolved: boolean;
  /**
   * Deep link URL captured while the app was locked (N-10). The lock screen
   * intentionally refuses to navigate into authenticated screens while
   * locked, but discarding the URL outright is poor UX — receiving a
   * `faircoin:` URI while locked, unlocking, and landing on Home instead of
   * the pre-filled Send screen is confusing. We stash the URL here, the
   * unlock path consumes it, and the deep-link handler navigates after the
   * unlock transition. Cleared by `consumePendingDeepLink` or implicitly
   * after a freshness timeout in the consumer.
   */
  pendingDeepLink: { url: string; capturedAt: number } | null;
  /** Mark the app unlocked (after a successful PIN / biometric unlock). */
  unlock: () => void;
  /** Lock the app (auto-lock on background, or manual lock). */
  lock: () => void;
  /**
   * Set the initial lock state from whether a PIN is configured. The caller
   * (boot) performs the `hasPin()` check and passes the result, keeping this
   * store free of storage imports. Returns whether the app ended up locked.
   */
  resolveInitialLock: (pinSet: boolean) => boolean;
  /** Unlock without a PIN check, for wallets that have no PIN configured. */
  markNoPinUnlocked: () => void;
  /**
   * Queue a deep link URL that arrived while the app was locked. Overwrites
   * any previous queued URL — only the latest matters (a second incoming
   * payment URI invalidates the first).
   */
  queueDeepLink: (url: string) => void;
  /**
   * Pop the queued deep link URL if one is present AND it was queued within
   * `maxAgeMs` (defaults to 5 minutes). Returns the URL or null. Clears the
   * pending entry either way so we don't replay it on the next unlock.
   */
  consumePendingDeepLink: (maxAgeMs?: number) => string | null;
}

const DEFAULT_DEEP_LINK_MAX_AGE_MS = 5 * 60 * 1000;

export const useLockStore = create<LockState>((set, get) => ({
  locked: true,
  resolved: false,
  pendingDeepLink: null,

  unlock: (): void => {
    set({ locked: false, resolved: true });
  },

  lock: (): void => {
    set({ locked: true });
  },

  resolveInitialLock: (pinSet: boolean): boolean => {
    set({ locked: pinSet, resolved: true });
    return pinSet;
  },

  markNoPinUnlocked: (): void => {
    set({ locked: false, resolved: true });
  },

  queueDeepLink: (url: string): void => {
    set({ pendingDeepLink: { url, capturedAt: Date.now() } });
  },

  consumePendingDeepLink: (maxAgeMs: number = DEFAULT_DEEP_LINK_MAX_AGE_MS): string | null => {
    const entry = get().pendingDeepLink;
    set({ pendingDeepLink: null });
    if (!entry) return null;
    if (Date.now() - entry.capturedAt > maxAgeMs) return null;
    return entry.url;
  },
}));
