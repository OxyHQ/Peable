/**
 * What the chain holds, read straight from the FairCoin Explorer's HTTP API.
 *
 * This is the whole reason an app that is not the Peable wallet can pay: the
 * SPV path needs a TCP socket and a local database, and this needs neither. It
 * returns the SAME `UTXO` shape the SPV path produces, so coin selection,
 * balances and fees downstream are one implementation, not two.
 *
 * The Explorer echoes the request Origin in `access-control-allow-origin`, so a
 * browser reaches it with no proxy (verified 2026-09-06).
 */

import { EXPLORER_BASE_URL, hexToBytes, type NetworkType } from '@fairco.in/core';
import type { UTXO } from '../wallet/utxo-set';

/**
 * `OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG`, as hex: the only
 * script shape `signInput` produces a valid signature for.
 */
const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/i;

function isP2PKHScript(script: string): boolean {
  return P2PKH_SCRIPT.test(script);
}

interface ExplorerUtxo {
  readonly txid?: unknown;
  readonly outputIndex?: unknown;
  readonly script?: unknown;
  readonly satoshis?: unknown;
  readonly height?: unknown;
}

/**
 * Narrow one explorer entry, or `null` if it is not usable.
 *
 * Every field is checked because a malformed entry that reached the UTXO set
 * would corrupt the balance rather than fail loudly — `satoshis` in particular
 * is a JSON number, and a non-integer there would throw inside `BigInt` at a
 * point far from the response that caused it.
 */
function toUtxo(entry: ExplorerUtxo, address: string): UTXO | null {
  const { txid, outputIndex, script, satoshis, height } = entry;
  if (typeof txid !== 'string' || typeof script !== 'string') return null;
  // Only outputs this library can actually spend. `signInput` always builds a
  // P2PKH scriptSig, so a P2PK output — which FairCoin pays staking rewards to
  // — would be selected, signed INVALIDLY, and the whole transaction rejected
  // by the network with the coins still counted as available. Excluding them
  // here means the balance and the fee are computed from what is spendable.
  if (!isP2PKHScript(script)) return null;
  if (typeof outputIndex !== 'number' || !Number.isInteger(outputIndex)) return null;
  if (typeof satoshis !== 'number' || !Number.isSafeInteger(satoshis)) return null;
  const blockHeight = typeof height === 'number' && Number.isInteger(height) ? height : 0;

  return {
    txid,
    vout: outputIndex,
    address,
    value: BigInt(satoshis),
    scriptPubKey: hexToBytes(script),
    blockHeight,
    // Height 0 is what the explorer reports for an output still in the mempool.
    // Calling that confirmed would let the wallet treat an unsettled receive as
    // spendable.
    confirmed: blockHeight > 0,
  };
}

export interface AddressInfo {
  /**
   * How many transactions have ever touched this address. Gap-limit discovery
   * scans on THIS and not on the UTXO count: an address that received and was
   * later swept holds nothing but is used, and a scan that stopped there would
   * miss every address beyond it — under-reporting the balance while looking
   * authoritative.
   */
  readonly txCount: number;
  readonly utxos: readonly UTXO[];
}

/**
 * What the chain knows about each of `addresses`, keyed by address.
 *
 * An address the Explorer has never seen answers `{ txCount: 0, utxos: [] }`
 * rather than being absent or throwing: a freshly derived receive address is
 * exactly that until someone pays it, and a caller doing gap-limit discovery
 * must be able to tell "never used" from "not asked about".
 */
export async function fetchAddressInfo(
  addresses: readonly string[],
  network: NetworkType
): Promise<Map<string, AddressInfo>> {
  const result = new Map<string, AddressInfo>();
  if (addresses.length === 0) return result;

  const entries = await Promise.all(
    [...new Set(addresses)].map(async (address): Promise<[string, AddressInfo]> => {
      const url = `${EXPLORER_BASE_URL}/api/address/${encodeURIComponent(address)}?network=${network}`;
      const response = await fetch(url);
      if (!response.ok) return [address, { txCount: 0, utxos: [] }];

      const body: unknown = await response.json();
      const info = (body as { addressInfo?: { utxos?: unknown; txCount?: unknown } })?.addressInfo;
      const rawUtxos = Array.isArray(info?.utxos) ? info.utxos : [];
      const txCount =
        typeof info?.txCount === 'number' && Number.isSafeInteger(info.txCount)
          ? info.txCount
          : 0;

      const utxos = rawUtxos
        .map((entry: ExplorerUtxo) => toUtxo(entry, address))
        .filter((utxo): utxo is UTXO => utxo !== null);

      return [address, { txCount, utxos }];
    })
  );

  for (const [address, info] of entries) result.set(address, info);
  return result;
}
