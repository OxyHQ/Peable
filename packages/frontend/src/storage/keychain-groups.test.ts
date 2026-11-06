/**
 * Peable's own keychain items after the iOS access-group split (oxy ADR 0062):
 * written to the wallet group, read from it first, moved out of the shared
 * group verify-before-delete, and untouched on every other platform.
 */
import { describe, expect, test } from 'bun:test';
import type { KeychainAccess } from '@oxy.so/core/crypto';
import { createGroupedKeychainAdapter, type KeychainStore } from './keychain-groups';

const WALLET = 'ABCDE12345.so.oxy.wallet';
const SHARED = 'ABCDE12345.group.so.oxy.shared';
const PEABLE: KeychainAccess = {
  mode: 'grouped',
  prefix: 'ABCDE12345.',
  defaultGroup: WALLET,
  role: 'wallet',
};

/** Apple's semantics, reduced: no group → every entitled group in order. */
function keychain(entitlements = [WALLET, SHARED]) {
  const items = new Map<string, string>();
  const calls: Array<{ op: string; options?: { accessGroup?: string } }> = [];
  let failWrites = false;
  const store: KeychainStore = {
    getItemAsync: async (key, options?: { accessGroup?: string }) => {
      calls.push({ op: 'get', options });
      for (const g of options?.accessGroup ? [options.accessGroup] : entitlements) {
        const v = items.get(`${g}|${key}`);
        if (v !== undefined) return v;
      }
      return null;
    },
    setItemAsync: async (key, value, options?: { accessGroup?: string }) => {
      calls.push({ op: 'set', options });
      if (failWrites) throw new Error('errSecIO');
      items.set(`${options?.accessGroup ?? entitlements[0]}|${key}`, value);
    },
    deleteItemAsync: async (key, options?: { accessGroup?: string }) => {
      calls.push({ op: 'delete', options });
      for (const g of options?.accessGroup ? [options.accessGroup] : entitlements) {
        items.delete(`${g}|${key}`);
      }
    },
  };
  return { items, calls, store, setFailWrites: (v: boolean) => (failWrites = v) };
}

describe('Peable keychain items on iOS', () => {
  test('a pre-split item is moved out of the shared group on its first read', async () => {
    const k = keychain();
    k.items.set(`${SHARED}|fairwallet_mnemonic_w1`, 'twelve words');
    const kv = createGroupedKeychainAdapter(k.store, async () => PEABLE);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('twelve words');
    expect(k.items.get(`${WALLET}|fairwallet_mnemonic_w1`)).toBe('twelve words');
    expect(k.items.has(`${SHARED}|fairwallet_mnemonic_w1`)).toBe(false);
  });

  test('a failed copy leaves the item readable where it was', async () => {
    const k = keychain();
    k.items.set(`${SHARED}|fairwallet_seed_w1`, 'abcd');
    const kv = createGroupedKeychainAdapter(k.store, async () => PEABLE);
    k.setFailWrites(true);
    expect(await kv.getItem('fairwallet_seed_w1')).toBe('abcd');
    expect(k.items.get(`${SHARED}|fairwallet_seed_w1`)).toBe('abcd');
    k.setFailWrites(false);
    expect(await kv.getItem('fairwallet_seed_w1')).toBe('abcd');
    expect(k.items.has(`${SHARED}|fairwallet_seed_w1`)).toBe(false);
  });

  test('a write lands in the wallet group and removes the superseded shared copy', async () => {
    const k = keychain();
    k.items.set(`${SHARED}|fairwallet_pin`, 'old');
    const kv = createGroupedKeychainAdapter(k.store, async () => PEABLE);
    await kv.setItem('fairwallet_pin', 'new');
    expect(k.items.get(`${WALLET}|fairwallet_pin`)).toBe('new');
    expect(k.items.has(`${SHARED}|fairwallet_pin`)).toBe(false);
    expect(await kv.getItem('fairwallet_pin')).toBe('new');
  });

  test('Android, web and a build without the probe make the calls they always made', async () => {
    const k = keychain([SHARED]);
    const kv = createGroupedKeychainAdapter(k.store, async () => ({ mode: 'ungrouped' }));
    await kv.setItem('fairwallet_currency', 'EUR');
    expect(await kv.getItem('fairwallet_currency')).toBe('EUR');
    await kv.deleteItem('fairwallet_currency');
    expect(k.calls.every((c) => c.options === undefined)).toBe(true);
  });
});
