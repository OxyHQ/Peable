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
