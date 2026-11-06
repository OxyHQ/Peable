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
  IDENTITY_WALLET_ID,
  isWalletKey,
  keychainMoveKeys,
  PREFERENCE_KEYS,
  PREFERENCE_PREFIXES,
  SECRET_KEYS,
  SECRET_PREFIXES,
  walletIdsOfIndex,
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
