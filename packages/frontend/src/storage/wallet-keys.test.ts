/**
 * The wallet's key catalog is complete: every `fairwallet_` key the app keeps
 * in `kv-store` is one the iOS keychain move knows, so none is left in the
 * group every Oxy app reads, or dropped by the upgrade.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_IDENTITY_WALLET_ID } from '../wallet/identity-wallet';
import {
  adoptableFromShared,
  IDENTITY_WALLET_ID,
  isWalletKey,
  keychainMoveKeys,
  PREFERENCE_KEYS,
  PREFERENCE_PREFIXES,
  SECRET_KEYS,
  SECRET_PREFIXES,
  walletIdOfDatabaseFile,
  walletIdsOfIndex,
  walletOfAdoptedSecret,
} from './wallet-keys';

const ROOT = join(import.meta.dir, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the wallet key catalog', () => {
  test('knows every fairwallet_ key a kv-store user spells', () => {
    const known = new Set<string>([
      ...Object.values(SECRET_KEYS),
      ...Object.values(SECRET_PREFIXES),
      ...PREFERENCE_KEYS,
      ...PREFERENCE_PREFIXES,
    ]);
    const unknown: string[] = [];
    for (const file of [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'app'))]) {
      const text = readFileSync(file, 'utf8');
      if (!/storage\/kv-store'|from '\.\/kv-store'/.test(text)) continue;
      for (const [, key] of text.matchAll(/['"`](fairwallet_[A-Za-z_]*)/g)) {
        if (!known.has(key)) unknown.push(`${file}: ${key}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test('its identity wallet id is the wallet store’s', () => {
    expect(IDENTITY_WALLET_ID).toBe(LEGACY_IDENTITY_WALLET_ID);
    expect(keychainMoveKeys([])).toContain('fairwallet_pockets_oxy-identity');
  });

  test('adopts wallet keys only', () => {
    expect(isWalletKey('fairwallet_mnemonic_w1')).toBe(true);
    expect(isWalletKey('fairwallet_pin')).toBe(true);
    expect(isWalletKey('fairwallet_unknown')).toBe(false);
    expect(isWalletKey('fairwallet_mnemonic_')).toBe(false);
    expect(isWalletKey('oxy_identity_key')).toBe(false);
  });

  test('reads wallet ids from an index, dropping what no keychain key can carry', () => {
    expect(
      walletIdsOfIndex(JSON.stringify([{ id: 'w1' }, { id: 'a b' }, { id: 'w1' }, {}])),
    ).toEqual(['w1']);
    expect(walletIdsOfIndex('not json')).toEqual([]);
    expect(walletIdsOfIndex(null)).toEqual([]);
  });
});

describe('what the keychain move may take from the shared group (R6-4)', () => {
  const evidence = { walletIds: new Set(['w1']) };
  const none = { walletIds: new Set<string>() };

  test('nothing without evidence of an earlier install', () => {
    expect(adoptableFromShared('fairwallet_pin', 'pin', none)).toBeNull();
    expect(adoptableFromShared('fairwallet_mnemonic_w1', 'words', none)).toBeNull();
  });

  test('a cached seed and the pre-multi-wallet phrase never', () => {
    expect(adoptableFromShared('fairwallet_seed_w1', 'ab', evidence)).toBeNull();
    expect(adoptableFromShared('fairwallet_mnemonic', 'words', evidence)).toBeNull();
  });

  test('per-wallet keys and the pointer only for a wallet with evidence', () => {
    expect(adoptableFromShared('fairwallet_mnemonic_w1', 'words', evidence)).toBe('words');
    expect(adoptableFromShared('fairwallet_mnemonic_evil', 'words', evidence)).toBeNull();
    expect(adoptableFromShared('fairwallet_active_wallet', 'w1', evidence)).toBe('w1');
    expect(adoptableFromShared('fairwallet_active_wallet', 'evil', evidence)).toBeNull();
    expect(adoptableFromShared('fairwallet_pin', 'pin', evidence)).toBe('pin');
  });

  test('the index keeps only wallets with evidence', () => {
    const index = JSON.stringify([{ id: 'w1' }, { id: 'evil' }]);
    expect(adoptableFromShared('fairwallet_wallets_index', index, evidence)).toBe(
      JSON.stringify([{ id: 'w1' }]),
    );
    expect(
      adoptableFromShared('fairwallet_wallets_index', JSON.stringify([{ id: 'evil' }]), evidence),
    ).toBeNull();
  });

  test('evidence comes from the sandbox database names', () => {
    expect(walletIdOfDatabaseFile('fairwallet.db')).toBe('');
    expect(walletIdOfDatabaseFile('fairwallet_w1.db')).toBe('w1');
    expect(walletIdOfDatabaseFile('fairwallet_oxy-identity_acct2.db')).toBe('oxy-identity');
    expect(walletIdOfDatabaseFile('fairwallet_w1.db-wal')).toBeNull();
    expect(walletIdOfDatabaseFile('other.db')).toBeNull();
  });

  test('only a phrase or xpub makes a wallet adopted', () => {
    expect(walletOfAdoptedSecret('fairwallet_mnemonic_w1')).toBe('w1');
    expect(walletOfAdoptedSecret('fairwallet_xpub_w1')).toBe('w1');
    expect(walletOfAdoptedSecret('fairwallet_pin')).toBeNull();
  });
});
