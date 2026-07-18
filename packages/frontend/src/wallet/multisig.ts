/**
 * FAIRWallet's minimal multisig-wallet path, consuming `@fairco.in/core`'s
 * Layer 1 multisig primitives. Watch-address registration (this file, added
 * first) lets the wallet notice funds sent to a multisig address it is a
 * cosigner for; spend building/signing/combining is added alongside it in a
 * later change to this file.
 */
import { multisigAddress, bytesToHex, type NetworkConfig } from "@fairco.in/core";
import type { Database } from "../storage/database";
import type { KeyManager } from "./key-manager";

/**
 * Compute the P2SH address for a redeem script, persist it as a watch
 * address, and register it with the KeyManager so it is owned (and
 * therefore Bloom-filter-watched) immediately -- without waiting for a
 * wallet restart.
 */
export async function registerMultisigWatchAddress(
  database: Database,
  keyManager: KeyManager,
  redeemScript: Uint8Array,
  network: NetworkConfig,
  label = "",
): Promise<string> {
  const address = multisigAddress(redeemScript, network);
  await database.insertWatchAddress(address, bytesToHex(redeemScript), label);
  keyManager.registerWatchAddress(address);
  return address;
}

/**
 * Restore every persisted watch address into the KeyManager. Called at
 * wallet init, alongside `keyManager.restoreCursors`, so multisig addresses
 * registered in a previous session are owned and watched again immediately.
 */
export async function loadWatchAddressesIntoKeyManager(
  database: Database,
  keyManager: KeyManager,
): Promise<void> {
  const rows = await database.getWatchAddresses();
  for (const row of rows) {
    keyManager.registerWatchAddress(row.address);
  }
}
