/**
 * Persisted preferences for background payment notifications, plus the
 * per-wallet registration state.
 *
 * The prefs are a small observable store: `getNotificationPrefs` reads the
 * persisted value (cached after the first load), `setNotificationPrefs` merges a
 * patch and notifies subscribers, and `subscribeNotificationPrefs` lets the
 * registration lifecycle ({@link ./push-registration}) re-register when the user
 * flips the master toggle, changes the server URL, or edits confirmation depth.
 *
 * Persistence goes through the platform-agnostic `kv-store` adapter (SecureStore
 * on native, localStorage on web). None of these values are secret — the account
 * xpub they gate is watch-only — but reusing the wallet's storage keeps a single
 * at-rest container.
 */

import { getItemAsync, setItemAsync, deleteItemAsync } from '../storage/kv-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The payment events a user can subscribe to. Mirrors the Explorer wire
 * contract (spec §4.1) and the notification catalog core set (spec §3).
 */
export type NotificationEvent = 'incoming_pending' | 'incoming_confirmed' | 'outgoing_confirmed';

export interface NotificationPrefs {
  /** Master switch. When false, no registration exists and no push is sent. */
  enabled: boolean;
  /** Notification server base URL (the privacy dial — official / self-hosted). */
  serverUrl: string;
  /** Confirmation depth for the "confirmed" events (BIP44 default 1). */
  confirmations: number;
  /** Which events to receive. */
  events: NotificationEvent[];
}

/**
 * Registration state persisted per wallet id so the lifecycle knows whether an
 * active subscription already exists (and can DELETE it on disable) without
 * re-registering on every reconcile. `payloadKey` is the canonical form of the
 * last successfully-registered request; an unchanged key means "already
 * registered, skip".
 */
export interface StoredSubscription {
  subscriptionId: string;
  serverUrl: string;
  payloadKey: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The official FairCoin Explorer — the default (and privacy "Default") server. */
export const DEFAULT_NOTIFICATION_SERVER_URL = 'https://explorer.fairco.in';

const ALL_EVENTS: readonly NotificationEvent[] = [
  'incoming_pending',
  'incoming_confirmed',
  'outgoing_confirmed',
];

/** Minimum / maximum confirmation depth the UI and store enforce. */
const MIN_CONFIRMATIONS = 1;
const MAX_CONFIRMATIONS = 100;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false,
  serverUrl: DEFAULT_NOTIFICATION_SERVER_URL,
  confirmations: 1,
  events: [...ALL_EVENTS],
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const PREFS_KEY = 'fairwallet_notification_prefs';
const SUBSCRIPTION_KEY_PREFIX = 'fairwallet_notification_sub_';

function subscriptionKey(walletId: string): string {
  return `${SUBSCRIPTION_KEY_PREFIX}${walletId}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNotificationEvent(value: unknown): value is NotificationEvent {
  return (
    value === 'incoming_pending' || value === 'incoming_confirmed' || value === 'outgoing_confirmed'
  );
}

/**
 * Coerce an arbitrary parsed object into a valid {@link NotificationPrefs},
 * filling any missing/invalid field from the defaults. Never throws — a corrupt
 * persisted value degrades to defaults rather than breaking boot.
 */
function sanitizePrefs(raw: unknown): NotificationPrefs {
  const obj: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const enabled = obj.enabled === true;

  const serverUrl =
    typeof obj.serverUrl === 'string' && obj.serverUrl.trim().length > 0
      ? obj.serverUrl.trim()
      : DEFAULT_NOTIFICATION_SERVER_URL;

  let confirmations = DEFAULT_NOTIFICATION_PREFS.confirmations;
  if (typeof obj.confirmations === 'number' && Number.isFinite(obj.confirmations)) {
    confirmations = Math.min(
      MAX_CONFIRMATIONS,
      Math.max(MIN_CONFIRMATIONS, Math.round(obj.confirmations)),
    );
  }

  let events: NotificationEvent[];
  if (Array.isArray(obj.events)) {
    // Filter to known events and de-duplicate while preserving catalog order.
    const seen = new Set<NotificationEvent>();
    for (const candidate of obj.events) {
      if (isNotificationEvent(candidate)) seen.add(candidate);
    }
    events = ALL_EVENTS.filter((e) => seen.has(e));
  } else {
    events = [...ALL_EVENTS];
  }

  return { enabled, serverUrl, confirmations, events };
}

// ---------------------------------------------------------------------------
// Observable prefs store
// ---------------------------------------------------------------------------

let cachedPrefs: NotificationPrefs | null = null;
const listeners = new Set<() => void>();

/**
 * Read the current notification preferences, merged over defaults. Cached after
 * the first load so subscribers can read synchronously-fresh values after the
 * initial hydration.
 */
export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  if (cachedPrefs) return cachedPrefs;
  try {
    const stored = await getItemAsync(PREFS_KEY);
    cachedPrefs = stored ? sanitizePrefs(JSON.parse(stored)) : { ...DEFAULT_NOTIFICATION_PREFS };
  } catch {
    // Corrupt JSON or storage unavailable — fall back to defaults so the app
    // still boots; the next successful write repairs the persisted value.
    cachedPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  }
  return cachedPrefs;
}

/**
 * Merge a patch into the current prefs, persist, and notify subscribers. Returns
 * the new prefs. The in-memory cache is updated even if persistence fails, so
 * the running session honours the user's choice regardless.
 */
export async function setNotificationPrefs(
  patch: Partial<NotificationPrefs>,
): Promise<NotificationPrefs> {
  const current = await getNotificationPrefs();
  const next = sanitizePrefs({ ...current, ...patch });
  cachedPrefs = next;
  try {
    await setItemAsync(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory value; a later successful write persists it.
  }
  for (const listener of listeners) listener();
  return next;
}

/** Subscribe to prefs changes. Returns an unsubscribe function. */
export function subscribeNotificationPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Per-wallet subscription persistence
// ---------------------------------------------------------------------------

/** Load the persisted registration state for a wallet, or null if none. */
export async function getStoredSubscription(walletId: string): Promise<StoredSubscription | null> {
  try {
    const raw = await getItemAsync(subscriptionKey(walletId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.subscriptionId !== 'string' ||
      typeof obj.serverUrl !== 'string' ||
      typeof obj.payloadKey !== 'string'
    ) {
      return null;
    }
    return {
      subscriptionId: obj.subscriptionId,
      serverUrl: obj.serverUrl,
      payloadKey: obj.payloadKey,
    };
  } catch {
    return null;
  }
}

/** Persist the registration state for a wallet. */
export async function saveStoredSubscription(
  walletId: string,
  subscription: StoredSubscription,
): Promise<void> {
  await setItemAsync(subscriptionKey(walletId), JSON.stringify(subscription));
}

/** Remove the persisted registration state for a wallet. */
export async function clearStoredSubscription(walletId: string): Promise<void> {
  await deleteItemAsync(subscriptionKey(walletId));
}
