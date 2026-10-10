/**
 * Tests for the background-notification registration reconciler (spec §4.5).
 *
 * These drive {@link createPushRegistration} with fully-mocked dependencies, so
 * no native modules load. They prove the lifecycle:
 *   - registers ONCE when enabled with a wallet present and a device token;
 *   - is idempotent (a second reconcile with the same state does not re-POST);
 *   - unregisters when the master toggle is flipped off;
 *   - re-registers when the payload changes (confirmation depth);
 *   - never registers without a device token (web/electron guard);
 *   - only ever sends the watch-only xpub — no private key crosses the boundary.
 */

import { describe, test, expect, mock } from 'bun:test';
import {
  createPushRegistration,
  type PushRegistrationDeps,
  type RegistrationWallet,
} from './push-registration';
import type { NotificationPrefs, StoredSubscription } from './notification-settings';
import type { RegisterInput } from './notification-server';

const WALLET: RegistrationWallet = {
  walletId: 'wallet-1',
  network: 'mainnet',
  accountXpub: 'xpubACCOUNTKEY',
  gapLimit: 20,
};

interface Harness {
  deps: PushRegistrationDeps;
  prefs: NotificationPrefs;
  wallet: RegistrationWallet | null;
  deviceToken: { token: string; platform: 'android' | 'ios' } | null;
  registerCalls: RegisterInput[];
  unregisterCalls: { serverUrl: string; subscriptionId: string }[];
  subscriptions: Map<string, StoredSubscription>;
  notifyPrefs: () => void;
  notifyWallet: () => void;
}

function makeHarness(overrides?: Partial<NotificationPrefs>): Harness {
  const prefs: NotificationPrefs = {
    enabled: true,
    serverUrl: 'https://explorer.fairco.in',
    confirmations: 1,
    events: ['incoming_pending', 'incoming_confirmed', 'outgoing_confirmed'],
    ...overrides,
  };

  const state = {
    wallet: WALLET as RegistrationWallet | null,
    deviceToken: { token: 'device-token-abc', platform: 'android' as const } as {
      token: string;
      platform: 'android' | 'ios';
    } | null,
    registerCalls: [] as RegisterInput[],
    unregisterCalls: [] as { serverUrl: string; subscriptionId: string }[],
    subscriptions: new Map<string, StoredSubscription>(),
    prefsListeners: new Set<() => void>(),
    walletListeners: new Set<() => void>(),
  };

  let nextSubId = 1;

  const deps: PushRegistrationDeps = {
    getPrefs: async () => prefs,
    subscribePrefs: (onChange) => {
      state.prefsListeners.add(onChange);
      return () => state.prefsListeners.delete(onChange);
    },
    getWallet: () => state.wallet,
    subscribeWallet: (onChange) => {
      state.walletListeners.add(onChange);
      return () => state.walletListeners.delete(onChange);
    },
    getDeviceToken: async () => state.deviceToken,
    register: mock(async (input: RegisterInput) => {
      state.registerCalls.push(input);
      return { subscriptionId: `sub_${nextSubId++}` };
    }),
    unregister: mock(async (serverUrl: string, subscriptionId: string) => {
      state.unregisterCalls.push({ serverUrl, subscriptionId });
    }),
    loadSubscription: async (walletId: string) => state.subscriptions.get(walletId) ?? null,
    saveSubscription: async (walletId: string, sub: StoredSubscription) => {
      state.subscriptions.set(walletId, sub);
    },
    clearSubscription: async (walletId: string) => {
      state.subscriptions.delete(walletId);
    },
  };

  return {
    deps,
    prefs,
    get wallet() {
      return state.wallet;
    },
    set wallet(w) {
      state.wallet = w;
    },
    get deviceToken() {
      return state.deviceToken;
    },
    set deviceToken(v) {
      state.deviceToken = v;
    },
    registerCalls: state.registerCalls,
    unregisterCalls: state.unregisterCalls,
    subscriptions: state.subscriptions,
    notifyPrefs: () => {
      for (const l of state.prefsListeners) l();
    },
    notifyWallet: () => {
      for (const l of state.walletListeners) l();
    },
  };
}

describe('createPushRegistration reconcile', () => {
  test('registers once with the wallet xpub + device token when enabled', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();

    expect(h.registerCalls).toHaveLength(1);
    const input = h.registerCalls[0];
    expect(input.xpub).toBe('xpubACCOUNTKEY');
    expect(input.deviceToken).toBe('device-token-abc');
    expect(input.platform).toBe('android');
    expect(input.confirmations).toBe(1);
    expect(input.gapLimit).toBe(20);
    // Persisted so the next reconcile can short-circuit.
    expect(h.subscriptions.get('wallet-1')?.subscriptionId).toBe('sub_1');
  });

  test('registration uses ONLY the watch-only xpub, no private key (locked-safe)', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();

    const input = h.registerCalls[0] as unknown as Record<string, unknown>;
    expect(input.xpub).toBe('xpubACCOUNTKEY');
    for (const forbidden of ['privateKey', 'xprv', 'mnemonic', 'seed', 'wif']) {
      expect(input).not.toHaveProperty(forbidden);
    }
  });

  test('is idempotent — a second reconcile with the same state does not re-POST', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();
    await controller.reconcile();

    expect(h.registerCalls).toHaveLength(1);
  });

  test('unregisters when the master toggle is flipped off', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();
    expect(h.registerCalls).toHaveLength(1);

    h.prefs.enabled = false;
    await controller.reconcile();

    expect(h.unregisterCalls).toHaveLength(1);
    expect(h.unregisterCalls[0].subscriptionId).toBe('sub_1');
    expect(h.subscriptions.has('wallet-1')).toBe(false);
  });

  test('re-registers when the confirmation depth changes', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();
    expect(h.registerCalls).toHaveLength(1);

    h.prefs.confirmations = 6;
    await controller.reconcile();

    expect(h.registerCalls).toHaveLength(2);
    expect(h.registerCalls[1].confirmations).toBe(6);
  });

  test('does not register without a device token (web/electron guard)', async () => {
    const h = makeHarness();
    h.deviceToken = null;
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();

    expect(h.registerCalls).toHaveLength(0);
  });

  test('does not register when no wallet is up (locked / none)', async () => {
    const h = makeHarness();
    h.wallet = null;
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();

    expect(h.registerCalls).toHaveLength(0);
  });

  test('does not register with zero events selected (server rejects an empty set)', async () => {
    // The Explorer validates `events` as a NON-EMPTY subset; registering with
    // [] is a guaranteed 400. Enabled-but-no-events means "nothing to notify",
    // so treat it as off: never POST, and tear down any existing subscription.
    const h = makeHarness();
    h.prefs.events = [];
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();
    expect(h.registerCalls).toHaveLength(0);
  });

  test('unregisters when the last event is toggled off', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    await controller.reconcile();
    expect(h.registerCalls).toHaveLength(1);

    h.prefs.events = [];
    await controller.reconcile();

    expect(h.unregisterCalls).toHaveLength(1);
    expect(h.subscriptions.has('wallet-1')).toBe(false);
  });
});

describe('createPushRegistration start()', () => {
  test('reconciles immediately and re-reconciles on a prefs change', async () => {
    const h = makeHarness();
    const controller = createPushRegistration(h.deps);

    controller.start();
    // Let the initial reconcile settle.
    await controller.reconcile();
    expect(h.registerCalls).toHaveLength(1);

    // Flip off and notify via the prefs subscription; the lifecycle reconciles.
    h.prefs.enabled = false;
    h.notifyPrefs();
    await controller.reconcile();

    expect(h.unregisterCalls).toHaveLength(1);
    controller.stop();
  });
});
