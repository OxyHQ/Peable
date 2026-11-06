/**
 * `clearAll` and the iOS keychain move enumerate ONE list of the wallet's
 * secret keys (`./wallet-keys`), so a wipe and the move out of the shared
 * keychain group cannot diverge (R4-8: the seed cached under `'default'` was in
 * one and not the other). `kv-store` pulls in react-native, so it is replaced
 * by an in-memory map here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KEYCHAIN_MOVE_MARKER,
  keychainMoveKeys,
  walletSecretKeys,
  walletSeedKey,
} from './wallet-keys';

const kv = new Map<string, string>();
const deleted: string[] = [];
mock.module('./kv-store', () => ({
  getItemAsync: async (key: string) => kv.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    kv.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    deleted.push(key);
    kv.delete(key);
  },
}));
const store = await import('./secure-store');

/** Every writer this module exports, for two wallets. */
async function writeEverything(): Promise<void> {
  await store.saveMnemonic('legacy words'); // no active wallet → the legacy key
  for (const id of ['w1', 'w2']) {
    await store.addWalletToIndex(id, id);
    await store.saveWalletMnemonic(id, 'words');
    await store.cacheWalletSeed(id, new Uint8Array([1, 2, 3]));
    await store.saveWalletXpub(id, 'xpub');
    await store.markWalletBackedUp(id);
  }
  await store.setActiveWalletId('w1');
  await store.cacheWalletSeed('default', new Uint8Array([4, 5, 6]));
  await store.savePin('123456');
  await store.setBiometricsEnabled(true);
  await store.setAutoLockTimeout(1);
  await store.setCurrency('EUR');
}

describe('one list for the wipe and the keychain move', () => {
  beforeEach(() => {
    kv.clear();
    deleted.length = 0;
  });

  test('clearAll leaves nothing any secure-store writer wrote — the default seed included', async () => {
    await writeEverything();
    expect(kv.has(walletSeedKey('default'))).toBe(true);
    await store.clearAll();
    expect([...kv.keys()]).toEqual([]);
  });

  test('clearAll deletes exactly walletSecretKeys, all of which the keychain move covers', async () => {
    await writeEverything();
    await store.clearAll();
    expect(new Set(deleted)).toEqual(new Set(walletSecretKeys(['w1', 'w2'])));
    const moved = new Set(keychainMoveKeys(['w1', 'w2']));
    for (const key of deleted) expect(moved.has(key)).toBe(true);
    expect(deleted).toContain(walletSeedKey('default'));
    expect(deleted).not.toContain(KEYCHAIN_MOVE_MARKER);
    // The index goes last, so an interrupted wipe can still find its wallets.
    expect(deleted.at(-1)).toBe('fairwallet_wallets_index');
  });

  test('every per-wallet key pattern is in the list', () => {
    const keys = walletSecretKeys(['w1']);
    for (const key of [
      'fairwallet_mnemonic_w1',
      'fairwallet_seed_w1',
      'fairwallet_xpub_w1',
      'fairwallet_backedup_w1',
      'fairwallet_seed_default',
    ]) {
      expect(keys).toContain(key);
    }
  });

  test('secure-store spells no key of its own: they all come from ./wallet-keys', () => {
    const source = readFileSync(join(import.meta.dir, 'secure-store.ts'), 'utf8');
    expect(source).not.toMatch(/['"`]fairwallet_/);
  });
});
