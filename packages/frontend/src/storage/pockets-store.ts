/**
 * Persistence for Pockets (BIP44 sub-accounts of one wallet).
 *
 * Mirrors the multi-wallet index in `secure-store.ts`: a JSON registry stored
 * per wallet in the key-value store, plus a per-wallet pointer to the active
 * Pocket. A wallet with no stored registry is treated as a single implicit
 * "main" Pocket at account 0, so pre-Pockets wallets need no migration.
 */

import { getItemAsync, setItemAsync, deleteItemAsync } from './kv-store';
import { type PocketInfo, MAIN_POCKET_ACCOUNT, normalizePockets } from '../wallet/pockets';

const POCKETS_PREFIX = 'fairwallet_pockets_';
const ACTIVE_POCKET_PREFIX = 'fairwallet_active_pocket_';

/** The Pocket registry for a wallet (always contains the main Pocket). */
export async function getPockets(walletId: string): Promise<PocketInfo[]> {
  const raw = await getItemAsync(`${POCKETS_PREFIX}${walletId}`);
  if (!raw) return normalizePockets([]);
  try {
    return normalizePockets(JSON.parse(raw) as PocketInfo[]);
  } catch {
    // Corrupted registry JSON — fall back to the implicit main Pocket rather
    // than throwing, so a bad write never bricks wallet init.
    return normalizePockets([]);
  }
}

/** Persist the Pocket registry for a wallet. */
export async function savePockets(walletId: string, pockets: PocketInfo[]): Promise<void> {
  await setItemAsync(`${POCKETS_PREFIX}${walletId}`, JSON.stringify(normalizePockets(pockets)));
}

/** The active Pocket (BIP44 account index) for a wallet; defaults to main (0). */
export async function getActivePocket(walletId: string): Promise<number> {
  const raw = await getItemAsync(`${ACTIVE_POCKET_PREFIX}${walletId}`);
  if (!raw) return MAIN_POCKET_ACCOUNT;
  const account = Number.parseInt(raw, 10);
  return Number.isInteger(account) && account >= 0 ? account : MAIN_POCKET_ACCOUNT;
}

/** Set the active Pocket for a wallet. */
export async function setActivePocket(walletId: string, account: number): Promise<void> {
  await setItemAsync(`${ACTIVE_POCKET_PREFIX}${walletId}`, String(account));
}

/** Remove all Pocket data for a wallet (call when the wallet is deleted). */
export async function clearPockets(walletId: string): Promise<void> {
  await deleteItemAsync(`${POCKETS_PREFIX}${walletId}`);
  await deleteItemAsync(`${ACTIVE_POCKET_PREFIX}${walletId}`);
}
