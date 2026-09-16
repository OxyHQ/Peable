import { describe, test, expect } from 'bun:test';
import { discoverUtxos, type AddressSource } from './discovery';
import type { AddressInfo } from './address';
import type { UTXO } from '../wallet/utxo-set';

/**
 * A key manager's addresses, without a key manager: discovery may derive and
 * read addresses and nothing else, so the seam it is given is this narrow.
 */
function addressSource(): AddressSource {
  let count = 0;
  return {
    restoreCursors: (externalNext: number) => {
      count = externalNext;
    },
    getAllAddresses: () => Array.from({ length: count }, (_unused, i) => `addr-${i}`),
  };
}

function utxoAt(address: string, value: bigint): UTXO {
  return {
    txid: 'ab'.repeat(32),
    vout: 0,
    address,
    value,
    scriptPubKey: new Uint8Array(),
    blockHeight: 100,
    confirmed: true,
  };
}

/** An explorer that knows about exactly the addresses in `used`. */
function explorerWith(used: Record<string, bigint>) {
  return async (addresses: readonly string[]): Promise<Map<string, AddressInfo>> => {
    const info = new Map<string, AddressInfo>();
    for (const address of addresses) {
      const value = used[address];
      info.set(
        address,
        value === undefined
          ? { txCount: 0, utxos: [] }
          : { txCount: 1, utxos: value > 0n ? [utxoAt(address, value)] : [] },
      );
    }
    return info;
  };
}

describe('discoverUtxos', () => {
  test('finds what the wallet holds', async () => {
    const found = await discoverUtxos(
      addressSource(),
      'mainnet',
      explorerWith({ 'addr-0': 500n, 'addr-3': 1_500n }),
    );

    expect(found.map((utxo) => utxo.value).sort((a, b) => Number(a - b))).toEqual([500n, 1_500n]);
  });

  test('a wallet nobody has paid holds nothing, and the scan ends', async () => {
    expect(await discoverUtxos(addressSource(), 'mainnet', explorerWith({}))).toEqual([]);
  });

  /**
   * The trap this function exists to avoid. An address that received and was
   * later swept holds nothing but PROVES the wallet reached that far; a scan
   * that stopped at it would report a balance short by everything beyond —
   * short and confident, which is the worst answer available.
   */
  test('a used-but-empty address does not end the scan', async () => {
    const found = await discoverUtxos(
      addressSource(),
      'mainnet',
      // addr-5 was swept; the money is further out than the gap limit from it.
      explorerWith({ 'addr-5': 0n, 'addr-30': 9_000n }),
    );

    expect(found.map((utxo) => utxo.value)).toEqual([9_000n]);
  });

  // A malformed answer must not spin forever: the scan is HTTP round trips, and
  // an explorer that reports every address as used would never stop on its own.
  test('stops even when every address reads as used', async () => {
    let asked = 0;
    const found = await discoverUtxos(addressSource(), 'mainnet', async (addresses) => {
      asked += addresses.length;
      return new Map(addresses.map((address) => [address, { txCount: 1, utxos: [] }]));
    });

    expect(found).toEqual([]);
    expect(asked).toBeLessThanOrEqual(520);
  });
});
