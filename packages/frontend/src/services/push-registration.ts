/**
 * Background-notification registration lifecycle (spec §4.5).
 *
 * Watches the wallet store and the notification prefs and keeps the server-side
 * subscription in sync with them:
 *   - enabled + a wallet present + a device push token → register the wallet's
 *     watch-only account xpub with the configured server (idempotent — skipped
 *     when the payload hasn't changed since the last successful registration);
 *   - disabled → DELETE the existing subscription.
 * It re-registers on token rotation, confirmation-depth change, server-URL
 * change, and wallet switch, because each changes the registration payload.
 *
 * The registration path uses ONLY the public account xpub (never a private key)
 * and never prompts for the PIN, so it is safe while the wallet is locked.
 *
 * ## Testability / import safety
 *
 * The core reconciler {@link createPushRegistration} is fully dependency-injected
 * and imports no native modules, so its unit test can drive it without loading
 * react-native. The production entry {@link startPushRegistration} lazily
 * `require`s the native pieces (expo-notifications, the wallet store, Platform)
 * inside its body — matching the `kv-store` pattern — so merely importing this
 * module never pulls react-native into the test runner.
 */

import {
  registerForPush,
  unregisterFromPush,
  normalizeServerUrl,
  type RegisterInput,
} from './notification-server';
import type { NotificationPrefs, StoredSubscription } from './notification-settings';

/**
 * BIP44 default gap limit registered with the server. Matches the wallet's own
 * external-address lookahead; the server may widen it (spec §4.1).
 */
const REGISTRATION_GAP_LIMIT = 20;

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** The registerable facts about the active wallet (all public — no secrets). */
export interface RegistrationWallet {
  walletId: string;
  network: 'mainnet' | 'testnet';
  accountXpub: string;
  gapLimit: number;
}

/** A native push token plus the platform it came from. */
export interface DeviceToken {
  token: string;
  platform: 'android' | 'ios';
}

export interface PushRegistrationDeps {
  getPrefs: () => Promise<NotificationPrefs>;
  subscribePrefs: (onChange: () => void) => () => void;
  /** The active wallet, or null when none is up (locked / no wallet). */
  getWallet: () => RegistrationWallet | null;
  subscribeWallet: (onChange: () => void) => () => void;
  /** Acquire the native push token, or null on web/electron/denied permission. */
  getDeviceToken: () => Promise<DeviceToken | null>;
  register: (input: RegisterInput) => Promise<{ subscriptionId: string }>;
  unregister: (serverUrl: string, subscriptionId: string) => Promise<void>;
  loadSubscription: (walletId: string) => Promise<StoredSubscription | null>;
  saveSubscription: (walletId: string, subscription: StoredSubscription) => Promise<void>;
  clearSubscription: (walletId: string) => Promise<void>;
}

export interface PushRegistrationController {
  /** Subscribe to wallet + prefs changes and reconcile once immediately. */
  start: () => void;
  /** Tear down the subscriptions (tests / teardown). */
  stop: () => void;
  /** Bring the server subscription in line with the current state. */
  reconcile: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

/**
 * Canonical form of a registration payload. Two payloads that would register the
 * same thing produce the same key, so an unchanged key means "already
 * registered, skip". `serverUrl` is normalized so a trailing-slash edit isn't a
 * spurious change.
 */
function payloadKeyFor(input: RegisterInput): string {
  return JSON.stringify({
    serverUrl: normalizeServerUrl(input.serverUrl),
    xpub: input.xpub,
    scriptType: input.scriptType,
    gapLimit: input.gapLimit,
    network: input.network,
    deviceToken: input.deviceToken,
    platform: input.platform,
    confirmations: input.confirmations,
    events: input.events,
  });
}

/**
 * Build a registration controller over injected dependencies. Pure of native
 * modules so it can be unit-tested directly.
 */
export function createPushRegistration(deps: PushRegistrationDeps): PushRegistrationController {
  let current: Promise<void> | null = null;
  let rerun = false;
  let started = false;
  const unsubscribers: (() => void)[] = [];

  async function reconcileOnce(): Promise<void> {
    const prefs = await deps.getPrefs();
    const wallet = deps.getWallet();

    // Desired: OFF — disabled, no wallet up, or no events selected. The server
    // rejects an empty `events` set (strict validation), and "enabled with zero
    // events" means nothing to notify, so it collapses to off: ensure no live
    // subscription for the current wallet and leave storage clean.
    if (!prefs.enabled || !wallet || prefs.events.length === 0) {
      if (wallet) {
        const existing = await deps.loadSubscription(wallet.walletId);
        if (existing) {
          await deps.unregister(existing.serverUrl, existing.subscriptionId);
          await deps.clearSubscription(wallet.walletId);
        }
      }
      return;
    }

    // Desired: ON. Registration needs a native push token; without one (web /
    // electron / denied permission) there is nothing to register — the wallet
    // still works, foreground alerts still fire (spec §6).
    const device = await deps.getDeviceToken();
    if (!device || device.token.length === 0) {
      return;
    }

    const input: RegisterInput = {
      serverUrl: prefs.serverUrl,
      xpub: wallet.accountXpub,
      scriptType: 'p2pkh',
      gapLimit: wallet.gapLimit,
      network: wallet.network,
      deviceToken: device.token,
      platform: device.platform,
      confirmations: prefs.confirmations,
      events: prefs.events,
    };
    const key = payloadKeyFor(input);
    const normalized = normalizeServerUrl(prefs.serverUrl);

    const existing = await deps.loadSubscription(wallet.walletId);
    // Idempotent: nothing changed since the last successful registration.
    if (existing && existing.payloadKey === key) {
      return;
    }

    // When the user pointed the wallet at a different server, drop the old
    // subscription there before registering on the new one. Best-effort: the old
    // server may be unreachable (self-host taken down), which must not block
    // registering on the new one.
    if (existing && existing.serverUrl !== normalized) {
      try {
        await deps.unregister(existing.serverUrl, existing.subscriptionId);
      } catch {
        // Old server unreachable — proceed to register on the new server.
      }
    }

    const result = await deps.register(input);
    await deps.saveSubscription(wallet.walletId, {
      subscriptionId: result.subscriptionId,
      serverUrl: normalized,
      payloadKey: key,
    });
  }

  function reconcile(): Promise<void> {
    // Serialise: if a reconcile lands while one is in flight, request a re-run
    // and return the SAME in-flight promise so the caller still awaits the
    // final settled state — never two register/unregister sequences at once.
    if (current) {
      rerun = true;
      return current;
    }
    const run = (async () => {
      try {
        do {
          rerun = false;
          await reconcileOnce();
        } while (rerun);
      } finally {
        current = null;
      }
    })();
    current = run;
    return run;
  }

  function trigger(): void {
    void reconcile().catch(() => {
      // Best-effort: a failed registration is retried on the next wallet/prefs
      // signal (e.g. the next unlock). Never surface as a wallet error.
    });
  }

  function start(): void {
    if (started) return;
    started = true;
    unsubscribers.push(deps.subscribePrefs(trigger));
    unsubscribers.push(deps.subscribeWallet(trigger));
    trigger();
  }

  function stop(): void {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
    started = false;
  }

  return { start, stop, reconcile };
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

let controller: PushRegistrationController | null = null;

/**
 * Start the registration lifecycle. Idempotent — a second call is a no-op.
 * No-op on web/electron (no native push module). Lazily requires the native
 * modules so importing this file never pulls react-native into the test runner.
 */
export function startPushRegistration(): void {
  if (controller) return;

  const rn = require('react-native') as typeof import('react-native');
  // No native push token surface on web; foreground alerts still work.
  if (rn.Platform.OS === 'web') return;

  const settings = require('./notification-settings') as typeof import('./notification-settings');
  const { useWalletStore, getActiveAccountXpub } =
    require('../wallet/wallet-store') as typeof import('../wallet/wallet-store');

  const deps: PushRegistrationDeps = {
    getPrefs: settings.getNotificationPrefs,
    subscribePrefs: settings.subscribeNotificationPrefs,
    getWallet: () => {
      const state = useWalletStore.getState();
      if (!state.initialized || !state.activeWalletId) return null;
      const xpub = getActiveAccountXpub();
      if (!xpub) return null;
      return {
        walletId: state.activeWalletId,
        network: state.network,
        accountXpub: xpub,
        gapLimit: REGISTRATION_GAP_LIMIT,
      };
    },
    subscribeWallet: (onChange) =>
      useWalletStore.subscribe((state, prevState) => {
        // Re-register only on the fields that change the payload — not on every
        // balance / sync tick, which would spam the server.
        if (
          state.activeWalletId !== prevState.activeWalletId ||
          state.initialized !== prevState.initialized ||
          state.network !== prevState.network
        ) {
          onChange();
        }
      }),
    getDeviceToken: async () => {
      try {
        const Notifications = require('expo-notifications') as typeof import('expo-notifications');
        const platform: 'android' | 'ios' = rn.Platform.OS === 'ios' ? 'ios' : 'android';
        const devicePushToken = await Notifications.getDevicePushTokenAsync();
        const value =
          typeof devicePushToken.data === 'string'
            ? devicePushToken.data
            : String(devicePushToken.data);
        if (value.length === 0) return null;
        return { token: value, platform };
      } catch {
        // No native module, permission denied, or no Google Play services.
        return null;
      }
    },
    register: (input) => registerForPush(input),
    unregister: (serverUrl, subscriptionId) => unregisterFromPush(serverUrl, subscriptionId),
    loadSubscription: settings.getStoredSubscription,
    saveSubscription: settings.saveStoredSubscription,
    clearSubscription: settings.clearStoredSubscription,
  };

  controller = createPushRegistration(deps);
  controller.start();
}

/** Stop the lifecycle (tests / teardown). */
export function stopPushRegistration(): void {
  if (controller) {
    controller.stop();
    controller = null;
  }
}
