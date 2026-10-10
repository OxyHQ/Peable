import { describe, test, expect } from 'bun:test';
import { databaseFileName } from './db-name';

describe('databaseFileName', () => {
  test('no walletId, account 0 → legacy default name', () => {
    expect(databaseFileName()).toBe('fairwallet.db');
    expect(databaseFileName(undefined, 0)).toBe('fairwallet.db');
  });

  test('walletId, account 0 → legacy per-wallet name (backward compatible)', () => {
    expect(databaseFileName('abc', 0)).toBe('fairwallet_abc.db');
  });

  test('walletId, account > 0 → suffixed per-pocket name', () => {
    expect(databaseFileName('abc', 1)).toBe('fairwallet_abc_acct1.db');
    expect(databaseFileName('abc', 7)).toBe('fairwallet_abc_acct7.db');
  });

  test('no walletId, account > 0 → suffixed default name', () => {
    expect(databaseFileName(undefined, 2)).toBe('fairwallet_acct2.db');
  });
});
