/**
 * Tests for the P2P `networkStatus*` state on the wallet store (U-2).
 *
 * The store now exposes a structured `networkStatusKey` + optional
 * `networkStatusData` so the UI can translate at render time instead of
 * displaying whatever language string the store happened to write. This
 * test pins the set of i18n keys the store can emit and verifies that
 * every one is present in both supported translation tables (`en`, `es`).
 * Without this guard, adding a new P2P state in the store would silently
 * ship an untranslated label to users.
 *
 * Reads the i18n source file directly with the filesystem instead of
 * importing `../i18n/index.ts`, because that module pulls in
 * `expo-localization` (a React Native dependency that cannot load under
 * the bun test runner).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NETWORK_STATUS_KEYS = [
  'wallet.network.offline',
  'wallet.network.resolvingDns',
  'wallet.network.connecting',
  'wallet.network.waitingForPeers',
  'wallet.network.searchingForPeers',
  'wallet.network.connectedSingular',
  'wallet.network.connectedPlural',
  'wallet.network.error',
] as const;

const I18N_SOURCE_PATH = join(__dirname, '..', 'i18n', 'index.ts');
const I18N_SOURCE = readFileSync(I18N_SOURCE_PATH, 'utf8');

/**
 * Find every occurrence of `"<key>": "<value>"` and return the list of
 * non-empty translation values. Either quote style matches: the formatter
 * writes single quotes, and keeps double quotes around a value that contains
 * an apostrophe. The i18n file declares two tables (en, es)
 * inside a single object, so a translated key will appear twice if both
 * translations are wired.
 */
function findTranslations(key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`["']${escaped}["']\\s*:\\s*(?:"([^"]+)"|'([^']+)')`, 'g');
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(I18N_SOURCE)) !== null) {
    values.push(m[1] ?? m[2]);
  }
  return values;
}

describe('U-2: P2P network status i18n', () => {
  test('every status key has an English and a Spanish translation', () => {
    for (const key of NETWORK_STATUS_KEYS) {
      const values = findTranslations(key);
      // Two tables (en + es) => two occurrences.
      expect(values.length).toBe(2);
      for (const v of values) {
        expect(v.length).toBeGreaterThan(0);
      }
    }
  });

  test('English and Spanish translations are distinct for at least one key', () => {
    // Sanity: confirm the ES table really has its own strings (not a typo'd
    // duplicate of EN). If both languages collapse to the same string for
    // every key the test above can still pass, but the user would never see
    // Spanish — catch that here.
    const enOffline = findTranslations('wallet.network.offline')[0];
    const esOffline = findTranslations('wallet.network.offline')[1];
    expect(enOffline).toBeTruthy();
    expect(esOffline).toBeTruthy();
    expect(esOffline).not.toBe(enOffline);
  });

  test('placeholder keys keep their interpolation placeholders in both languages', () => {
    // The store passes `{count}` / `{message}` payloads to the UI; if either
    // translation drops the placeholder the rendered status loses the
    // dynamic data (e.g. "Connected to peers" with no number).
    for (const v of findTranslations('wallet.network.connectedPlural')) {
      expect(v).toContain('{count}');
    }
    for (const v of findTranslations('wallet.network.error')) {
      expect(v).toContain('{message}');
    }
  });
});
