/**
 * Peable's own keychain items after the iOS access-group split (oxy ADR 0062):
 * moved out of the shared group ONCE, before any other storage call, never
 * over a value the wallet group already holds, and never read from the shared
 * group again once the move's marker exists. Untouched on every other platform.
 */
import { describe, expect, test } from 'bun:test';
import type { KeychainAccess } from '@oxy.so/core/crypto';
import { createGroupedKeychainAdapter, type KeychainStore } from './keychain-groups';
import {
  KEYCHAIN_MOVE_MARKER,
  keychainMoveKeys,
  walletSecretKeys,
  walletSeedKey,
} from './wallet-keys';

const WALLET = 'ABCDE12345.so.oxy.wallet';
const SHARED = 'ABCDE12345.group.so.oxy.shared';
const PEABLE: KeychainAccess = {
  mode: 'grouped',
  prefix: 'ABCDE12345.',
  defaultGroup: WALLET,
  role: 'wallet',
};
const peable = async () => PEABLE;
const INDEX = JSON.stringify([{ id: 'w1', name: 'Wallet 1', createdAt: 1 }]);

/**
 * Apple's semantics, reduced: no group → every entitled group in order. With
 * `slowShared`, a read that can reach the shared group answers what it saw a
 * few milliseconds LATER, as a native call does — the window the app's own
 * writes and deletes used to race the move through.
 */
function keychain(entitlements = [WALLET, SHARED]) {
  const items = new Map<string, string>();
  const calls: Array<{ op: string; key: string; options?: { accessGroup?: string } }> = [];
  let failWrites = false;
  let slowShared = false;
  const store: KeychainStore = {
    getItemAsync: async (key, options?: { accessGroup?: string }) => {
      calls.push({ op: 'get', key, options });
      let found: string | null = null;
      for (const g of options?.accessGroup ? [options.accessGroup] : entitlements) {
        const v = items.get(`${g}|${key}`);
        if (v !== undefined) {
          found = v;
          break;
        }
      }
      if (slowShared && options?.accessGroup !== WALLET) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return found;
    },
    setItemAsync: async (key, value, options?: { accessGroup?: string }) => {
      calls.push({ op: 'set', key, options });
      if (failWrites) throw new Error('errSecIO');
      items.set(`${options?.accessGroup ?? entitlements[0]}|${key}`, value);
    },
    deleteItemAsync: async (key, options?: { accessGroup?: string }) => {
      calls.push({ op: 'delete', key, options });
      for (const g of options?.accessGroup ? [options.accessGroup] : entitlements) {
        items.delete(`${g}|${key}`);
      }
    },
  };
  return {
    items,
    calls,
    store,
    setFailWrites: (v: boolean) => (failWrites = v),
    setSlowShared: (v: boolean) => (slowShared = v),
  };
}

/** A keychain as a pre-split build left it: everything in the shared group. */
function preSplit(entries: Record<string, string>) {
  const k = keychain();
  for (const [key, value] of Object.entries(entries)) k.items.set(`${SHARED}|${key}`, value);
  return k;
}

/** Run `fn` a millisecond from now: while a slow shared read is in flight. */
async function later(fn: () => Promise<void>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await fn();
}

const sharedReads = (k: ReturnType<typeof keychain>) =>
  k.calls.filter((c) => c.op === 'get' && c.options?.accessGroup !== WALLET);

describe('the one-shot move out of the shared group', () => {
  test('every indexed wallet secret moves — the default seed cache included (R4-8)', async () => {
    const entries: Record<string, string> = { fairwallet_wallets_index: INDEX };
    for (const key of walletSecretKeys(['w1'])) entries[key] ??= `v:${key}`;
    const k = preSplit(entries);
    const kv = createGroupedKeychainAdapter(k.store, peable);
    await kv.getItem('fairwallet_currency');
    for (const [key, value] of Object.entries(entries)) {
      expect(k.items.get(`${WALLET}|${key}`)).toBe(value);
      expect(k.items.has(`${SHARED}|${key}`)).toBe(false);
    }
    expect(k.items.has(`${WALLET}|${walletSeedKey('default')}`)).toBe(true);
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
    expect(k.items.has(`${SHARED}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
  });

  test('the move covers every secret clearAll deletes, and the preferences', () => {
    const moved = new Set(keychainMoveKeys(['w1', 'oxy-org-abc']));
    for (const key of walletSecretKeys(['w1', 'oxy-org-abc'])) expect(moved.has(key)).toBe(true);
    for (const key of ['fairwallet_pockets_oxy-identity', 'fairwallet_pin_attempts']) {
      expect(moved.has(key)).toBe(true);
    }
    expect(moved.has(KEYCHAIN_MOVE_MARKER)).toBe(false);
  });

  test('the active identity wallet is enumerated although no index names it', async () => {
    const k = preSplit({
      fairwallet_active_wallet: 'oxy-org-abc',
      'fairwallet_pockets_oxy-org-abc': '[0,1]',
    });
    const kv = createGroupedKeychainAdapter(k.store, peable);
    expect(await kv.getItem('fairwallet_pockets_oxy-org-abc')).toBe('[0,1]');
    expect(k.items.has(`${SHARED}|fairwallet_pockets_oxy-org-abc`)).toBe(false);
  });

  test('a newer value in the wallet group is never overwritten (R4-14)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'old words' });
    k.items.set(`${WALLET}|fairwallet_mnemonic_w1`, 'new words');
    const kv = createGroupedKeychainAdapter(k.store, peable);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('new words');
    expect(k.items.has(`${SHARED}|fairwallet_mnemonic_w1`)).toBe(false);
  });

  test('a write issued while the move runs lands after it, and wins (R4-14)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_pin: 'old record' });
    k.setSlowShared(true);
    const kv = createGroupedKeychainAdapter(k.store, peable);
    // The write is issued while the first read is still waiting on the keychain.
    await Promise.all([
      kv.getItem('fairwallet_pin'),
      later(() => kv.setItem('fairwallet_pin', 'new record')),
    ]);
    expect(await kv.getItem('fairwallet_pin')).toBe('new record');
    expect(k.items.get(`${WALLET}|fairwallet_pin`)).toBe('new record');
  });

  test('a deleted phrase is not resurrected — this launch or the next (R4-14)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'words' });
    k.setSlowShared(true);
    const kv = createGroupedKeychainAdapter(k.store, peable);
    await Promise.all([
      kv.getItem('fairwallet_mnemonic_w1'),
      later(() => kv.deleteItem('fairwallet_mnemonic_w1')),
    ]);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    const nextLaunch = createGroupedKeychainAdapter(k.store, peable);
    expect(await nextLaunch.getItem('fairwallet_mnemonic_w1')).toBeNull();
  });

  test('a failed move: read-only fallback, no marker, retried next launch', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_seed_w1: 'abcd' });
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, peable);
    expect(await kv.getItem('fairwallet_seed_w1')).toBe('abcd');
    expect(k.items.get(`${SHARED}|fairwallet_seed_w1`)).toBe('abcd');
    expect(k.items.has(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
    k.setFailWrites(false);
    const nextLaunch = createGroupedKeychainAdapter(k.store, peable);
    expect(await nextLaunch.getItem('fairwallet_seed_w1')).toBe('abcd');
    expect(k.items.has(`${SHARED}|fairwallet_seed_w1`)).toBe(false);
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('without a marker, a key this launch deleted is not answered from the shared group', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX });
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, peable);
    await kv.deleteItem('fairwallet_mnemonic_w1');
    k.items.set(`${SHARED}|fairwallet_mnemonic_w1`, 'planted');
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
  });

  test('only the wallet keys are adopted: anything else in the shared group is ignored', async () => {
    const k = preSplit({ some_other_app_key: 'x', fairwallet_unknown: 'y' });
    const kv = createGroupedKeychainAdapter(k.store, peable);
    expect(await kv.getItem('some_other_app_key')).toBeNull();
    expect(await kv.getItem('fairwallet_unknown')).toBeNull();
    expect(k.items.has(`${WALLET}|some_other_app_key`)).toBe(false);
  });

  test('an index id no keychain key can carry does not block the marker', async () => {
    const k = preSplit({
      fairwallet_wallets_index: JSON.stringify([{ id: 'bad id/..' }, { id: 'w1' }]),
    });
    const kv = createGroupedKeychainAdapter(k.store, peable);
    await kv.getItem('fairwallet_currency');
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });
});

describe('after the marker', () => {
  test('the shared group is never read again, and a planted item is ignored (R4-7)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX });
    await createGroupedKeychainAdapter(k.store, peable).getItem('fairwallet_pin');
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');

    // Another Oxy app plants a wallet in the group it can write.
    k.items.set(`${SHARED}|fairwallet_mnemonic_evil`, 'attacker words');
    k.items.set(`${SHARED}|fairwallet_active_wallet`, 'evil');
    k.items.set(`${SHARED}|fairwallet_pin`, 'attacker pin record');
    k.calls.length = 0;

    const nextLaunch = createGroupedKeychainAdapter(k.store, peable);
    expect(await nextLaunch.getItem('fairwallet_mnemonic_evil')).toBeNull();
    expect(await nextLaunch.getItem('fairwallet_active_wallet')).toBeNull();
    expect(await nextLaunch.getItem('fairwallet_pin')).toBeNull();
    expect(sharedReads(k)).toEqual([]);
    expect(k.items.has(`${WALLET}|fairwallet_mnemonic_evil`)).toBe(false);
  });

  test('a write lands in the wallet group and removes a shared copy', async () => {
    const k = preSplit({});
    const kv = createGroupedKeychainAdapter(k.store, peable);
    await kv.getItem('fairwallet_pin');
    k.items.set(`${SHARED}|fairwallet_pin`, 'planted');
    await kv.setItem('fairwallet_pin', 'new');
    expect(k.items.get(`${WALLET}|fairwallet_pin`)).toBe('new');
    expect(k.items.has(`${SHARED}|fairwallet_pin`)).toBe(false);
    expect(await kv.getItem('fairwallet_pin')).toBe('new');
  });
});

describe("a native build with the app's own group (core 7.31+, ADR 0062 D6)", () => {
  const APP = 'ABCDE12345.to.peable.app';
  const WITH_APP: KeychainAccess = { ...PEABLE, appGroup: APP };
  const withApp = async () => WITH_APP;
  /** A keychain as the wallet-group build left it, plus anything still shared. */
  function walletGroupBuild(wallet: Record<string, string>, shared: Record<string, string> = {}) {
    const k = keychain([WALLET, SHARED, APP]);
    for (const [key, value] of Object.entries(wallet)) k.items.set(`${WALLET}|${key}`, value);
    for (const [key, value] of Object.entries(shared)) k.items.set(`${SHARED}|${key}`, value);
    return k;
  }

  test('what the wallet group holds moves to the app group; a planted shared item does not', async () => {
    const k = walletGroupBuild(
      {
        [KEYCHAIN_MOVE_MARKER]: '1',
        fairwallet_wallets_index: INDEX,
        fairwallet_mnemonic_w1: 'words',
        fairwallet_pin: 'pin record',
      },
      { fairwallet_seed_w1: 'planted seed', fairwallet_currency: 'XXX' },
    );
    const kv = createGroupedKeychainAdapter(k.store, withApp);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('words');
    expect(await kv.getItem('fairwallet_seed_w1')).toBeNull();
    expect(await kv.getItem('fairwallet_currency')).toBeNull();
    expect(k.items.get(`${APP}|fairwallet_wallets_index`)).toBe(INDEX);
    expect(k.items.get(`${APP}|fairwallet_pin`)).toBe('pin record');
    expect(k.items.has(`${WALLET}|fairwallet_mnemonic_w1`)).toBe(false);
    expect(k.items.has(`${WALLET}|fairwallet_pin`)).toBe(false);
    expect(k.items.has(`${APP}|fairwallet_seed_w1`)).toBe(false);
    expect(k.items.get(`${APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('straight from a pre-split build: the shared items move to the app group', async () => {
    const k = walletGroupBuild({}, { fairwallet_wallets_index: INDEX, fairwallet_seed_w1: 'ab' });
    const kv = createGroupedKeychainAdapter(k.store, withApp);
    expect(await kv.getItem('fairwallet_seed_w1')).toBe('ab');
    expect(k.items.get(`${APP}|fairwallet_seed_w1`)).toBe('ab');
    expect(k.items.has(`${SHARED}|fairwallet_seed_w1`)).toBe(false);
    expect(k.items.get(`${APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('an unfinished wallet-group move: its value wins over the shared one', async () => {
    const k = walletGroupBuild(
      { fairwallet_pin: 'newer' },
      { fairwallet_pin: 'older', fairwallet_wallets_index: INDEX },
    );
    const kv = createGroupedKeychainAdapter(k.store, withApp);
    expect(await kv.getItem('fairwallet_pin')).toBe('newer');
    expect(k.items.has(`${WALLET}|fairwallet_pin`)).toBe(false);
    expect(k.items.has(`${SHARED}|fairwallet_pin`)).toBe(false);
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
  });

  test('a failed move falls back to the wallet group, never to a closed shared group', async () => {
    const k = walletGroupBuild(
      { [KEYCHAIN_MOVE_MARKER]: '1', fairwallet_wallets_index: INDEX },
      { fairwallet_mnemonic_w1: 'planted' },
    );
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, withApp);
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    expect(k.items.has(`${APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
  });

  test('after the marker neither earlier group is read; a write clears both copies', async () => {
    const k = walletGroupBuild({ [KEYCHAIN_MOVE_MARKER]: '1' });
    await createGroupedKeychainAdapter(k.store, withApp).getItem('fairwallet_pin');
    k.items.set(`${WALLET}|fairwallet_pin`, 'stale');
    k.items.set(`${SHARED}|fairwallet_pin`, 'planted');
    k.calls.length = 0;
    const nextLaunch = createGroupedKeychainAdapter(k.store, withApp);
    expect(await nextLaunch.getItem('fairwallet_pin')).toBeNull();
    expect(k.calls.filter((c) => c.op === 'get' && c.options?.accessGroup !== APP)).toEqual([]);
    await nextLaunch.setItem('fairwallet_pin', 'new');
    expect(k.items.get(`${APP}|fairwallet_pin`)).toBe('new');
    expect(k.items.has(`${WALLET}|fairwallet_pin`)).toBe(false);
    expect(k.items.has(`${SHARED}|fairwallet_pin`)).toBe(false);
  });

  test('a delete names the app group: wiping a wallet never rests on the default group', async () => {
    const k = walletGroupBuild({ [KEYCHAIN_MOVE_MARKER]: '1' });
    const kv = createGroupedKeychainAdapter(k.store, withApp);
    await kv.setItem('fairwallet_seed_w1', 'seed');
    k.items.set(`${WALLET}|fairwallet_seed_w1`, 'stale');
    k.calls.length = 0;
    await kv.deleteItem('fairwallet_seed_w1');
    const deletes = k.calls.filter((c) => c.op === 'delete').map((c) => c.options?.accessGroup);
    expect(deletes).toEqual([APP, WALLET, SHARED, undefined]);
    expect(await kv.getItem('fairwallet_seed_w1')).toBeNull();
  });

  test('the dev build uses its own groups: to.peable.app.dev, then so.oxy.wallet.dev', async () => {
    const DEV_WALLET = 'ABCDE12345.so.oxy.wallet.dev';
    const DEV_APP = 'ABCDE12345.to.peable.app.dev';
    const dev: KeychainAccess = {
      mode: 'grouped',
      prefix: 'ABCDE12345.',
      defaultGroup: DEV_WALLET,
      role: 'wallet',
      appGroup: DEV_APP,
      variant: '.dev',
    };
    const k = keychain([DEV_WALLET, SHARED, DEV_APP]);
    k.items.set(`${DEV_WALLET}|fairwallet_pin`, 'dev pin');
    const kv = createGroupedKeychainAdapter(k.store, async () => dev);
    expect(await kv.getItem('fairwallet_pin')).toBe('dev pin');
    expect(k.items.get(`${DEV_APP}|fairwallet_pin`)).toBe('dev pin');
    expect(k.calls.some((c) => c.options?.accessGroup === WALLET)).toBe(false);
    expect(k.calls.some((c) => c.options?.accessGroup === SHARED)).toBe(false);
  });
});

describe('a development build never touches the shared group (R5-5)', () => {
  const DEV_WALLET = 'ABCDE12345.so.oxy.wallet.dev';
  const DEV_APP = 'ABCDE12345.to.peable.app.dev';
  const dev: KeychainAccess = {
    mode: 'grouped',
    prefix: 'ABCDE12345.',
    defaultGroup: DEV_WALLET,
    role: 'wallet',
    appGroup: DEV_APP,
    variant: '.dev',
  };
  /** A phone carrying the production wallet's pre-split items in the shared group. */
  function devPhone() {
    const k = keychain([DEV_WALLET, SHARED, DEV_APP]);
    k.items.set(`${SHARED}|fairwallet_wallets_index`, INDEX);
    k.items.set(`${SHARED}|fairwallet_mnemonic_w1`, 'production words');
    k.items.set(`${SHARED}|fairwallet_pin`, 'production pin');
    return k;
  }
  const sharedCalls = (k: ReturnType<typeof keychain>) =>
    k.calls.filter((c) => c.options?.accessGroup === SHARED || c.options === undefined);

  test('the move neither adopts nor deletes what the shared group holds', async () => {
    const k = devPhone();
    const kv = createGroupedKeychainAdapter(k.store, async () => dev);
    expect(await kv.getItem('fairwallet_wallets_index')).toBeNull();
    expect(await kv.getItem('fairwallet_pin')).toBeNull();
    expect(k.items.get(`${SHARED}|fairwallet_mnemonic_w1`)).toBe('production words');
    expect(k.items.get(`${SHARED}|fairwallet_pin`)).toBe('production pin');
    expect(k.items.has(`${DEV_APP}|fairwallet_pin`)).toBe(false);
    expect(k.items.get(`${DEV_APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
    expect(sharedCalls(k)).toEqual([]);
  });

  test('a failed move falls back to the dev wallet group only', async () => {
    const k = devPhone();
    k.items.set(`${DEV_WALLET}|fairwallet_wallets_index`, INDEX);
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, async () => dev);
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    expect(sharedCalls(k)).toEqual([]);
  });

  test('writes and deletes leave the shared copy alone and make no unscoped call', async () => {
    const k = devPhone();
    const kv = createGroupedKeychainAdapter(k.store, async () => dev);
    await kv.setItem('fairwallet_pin', 'dev pin');
    expect(k.items.get(`${DEV_APP}|fairwallet_pin`)).toBe('dev pin');
    await kv.deleteItem('fairwallet_pin');
    expect(k.items.has(`${DEV_APP}|fairwallet_pin`)).toBe(false);
    const deletes = k.calls.filter((c) => c.op === 'delete').map((c) => c.options?.accessGroup);
    expect(deletes).toEqual([DEV_WALLET, DEV_APP, DEV_WALLET]);
    expect(k.items.get(`${SHARED}|fairwallet_pin`)).toBe('production pin');
    expect(sharedCalls(k)).toEqual([]);
  });
});

describe('other platforms', () => {
  test('Android, web and a build without the probe make the calls they always made', async () => {
    const k = keychain([SHARED]);
    const kv = createGroupedKeychainAdapter(k.store, async () => ({ mode: 'ungrouped' }));
    await kv.setItem('fairwallet_currency', 'EUR');
    expect(await kv.getItem('fairwallet_currency')).toBe('EUR');
    await kv.deleteItem('fairwallet_currency');
    expect(k.calls.map((c) => c.op)).toEqual(['set', 'get', 'delete']);
    expect(k.calls.every((c) => c.options === undefined)).toBe(true);
  });
});
