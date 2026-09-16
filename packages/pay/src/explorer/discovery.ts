/**
 * BIP44 gap-limit discovery over the Explorer, for a surface with no SPV.
 *
 * An app embedding this package has no SPV node, and the chain is public — so
 * it walks the address tree the way any wallet does on restore, asking the
 * Explorer instead of peers.
 *
 * The result feeds the SAME `UTXOSet` the SPV path feeds, so balance, fees and
 * coin selection downstream are one implementation.
 */

import type { NetworkType } from '@fairco.in/core';
import { fetchAddressInfo, type AddressInfo } from './address';
import type { UTXO } from '../wallet/utxo-set';

/**
 * The part of `KeyManager` discovery needs. Narrow on purpose: the scan derives
 * addresses and reads them back, and must not be able to touch key material.
 */
export interface AddressSource {
  restoreCursors(externalNext: number, changeNext: number): void;
  getAllAddresses(): string[];
}

/**
 * Consecutive unused addresses that end the scan.
 *
 * BIP44's own gap limit is 20. This is the number that decides whether a real
 * balance is found or silently missed, so it is deliberately not shared with
 * the SPV path's constants: that one bounds a bloom filter, this one bounds a
 * sequence of HTTP round trips, and they are free to differ.
 */
const DISCOVERY_GAP = 20;

/** How many more indices to derive each round once a used address is found. */
const SCAN_STEP = 20;

/** Hard stop, so a malformed explorer answer cannot spin forever. */
const MAX_SCANNED_INDICES = 500;

/**
 * Every unspent output the wallet behind `source` holds.
 *
 * Scans forward in steps, stopping only after `DISCOVERY_GAP` consecutive
 * addresses that were NEVER used — used-and-emptied does not end the scan,
 * because an address that received and was swept holds nothing yet proves the
 * wallet reached that far. Ending there would report a balance short by
 * everything beyond it, and short-but-confident is the worst answer available.
 *
 * `fetchInfo` is injected so the scan is testable without a network or real
 * key material.
 */
export async function discoverUtxos(
  source: AddressSource,
  network: NetworkType,
  fetchInfo: (
    addresses: readonly string[],
    network: NetworkType
  ) => Promise<Map<string, AddressInfo>> = fetchAddressInfo
): Promise<UTXO[]> {
  const utxos: UTXO[] = [];
  const seen = new Set<string>();
  let cursor = SCAN_STEP;
  let consecutiveUnused = 0;

  while (cursor <= MAX_SCANNED_INDICES) {
    source.restoreCursors(cursor, cursor);
    const addresses = source.getAllAddresses().filter((address) => !seen.has(address));
    if (addresses.length === 0) break;
    for (const address of addresses) seen.add(address);

    const info = await fetchInfo(addresses, network);

    let usedInBatch = false;
    for (const address of addresses) {
      const entry = info.get(address);
      if (!entry || entry.txCount === 0) {
        consecutiveUnused += 1;
        continue;
      }
      usedInBatch = true;
      consecutiveUnused = 0;
      utxos.push(...entry.utxos);
    }

    if (!usedInBatch && consecutiveUnused >= DISCOVERY_GAP) break;
    cursor += SCAN_STEP;
  }

  return utxos;
}
