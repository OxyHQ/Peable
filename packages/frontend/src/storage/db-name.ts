/**
 * SQLite filename for a wallet + Pocket (BIP44 account index).
 *
 * Kept in its own module (no expo-sqlite import) so it is unit-testable and so
 * the account-0 backward-compat rule lives in exactly one place:
 *   - account 0 keeps the pre-Pockets filename, so existing installs keep
 *     using their existing database untouched;
 *   - account > 0 gets an `_acct<n>` suffix, giving each Pocket a fully isolated
 *     UTXO set / cursor space / history.
 */

const DEFAULT_DATABASE_NAME = 'fairwallet.db';

export function databaseFileName(walletId?: string, account = 0): string {
  if (!walletId) {
    return account === 0 ? DEFAULT_DATABASE_NAME : `fairwallet_acct${account}.db`;
  }
  return account === 0 ? `fairwallet_${walletId}.db` : `fairwallet_${walletId}_acct${account}.db`;
}
