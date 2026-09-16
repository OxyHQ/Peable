import { describe, test, expect, mock, afterEach } from 'bun:test';
import { fetchAddressInfo } from './address';

const ADDRESS = 'fZ1example00000000000000000000000';
const P2PKH = `76a914${'11'.repeat(20)}88ac`;
/** `OP_PUSH33 <pubkey> OP_CHECKSIG` — what FairCoin pays staking rewards to. */
const P2PK = `21${'02'.repeat(33)}ac`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function explorerReturns(addressInfo: unknown): void {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ addressInfo }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('fetchAddressInfo', () => {
  test('returns the outputs an address holds, in the wallet"s own shape', async () => {
    explorerReturns({
      txCount: 2,
      utxos: [{ txid: 'ab'.repeat(32), outputIndex: 1, script: P2PKH, satoshis: 250_000, height: 900 }],
    });

    const info = await fetchAddressInfo([ADDRESS], 'mainnet');

    const utxo = info.get(ADDRESS)?.utxos[0];
    expect(info.get(ADDRESS)?.txCount).toBe(2);
    expect(utxo?.value).toBe(250_000n);
    expect(utxo?.vout).toBe(1);
    expect(utxo?.confirmed).toBe(true);
  });

  // Height 0 is what the Explorer reports for an output still in the mempool.
  // Treating it as confirmed would let the wallet spend an unsettled receive.
  test('a mempool output is not confirmed', async () => {
    explorerReturns({
      txCount: 1,
      utxos: [{ txid: 'cd'.repeat(32), outputIndex: 0, script: P2PKH, satoshis: 10_000, height: 0 }],
    });

    const info = await fetchAddressInfo([ADDRESS], 'mainnet');

    expect(info.get(ADDRESS)?.utxos[0]?.confirmed).toBe(false);
  });

  // The signer only ever produces a P2PKH scriptSig. A P2PK output selected as
  // an input would be signed invalidly and the whole transaction rejected —
  // while the balance kept counting those coins as spendable.
  test('drops outputs this package cannot sign', async () => {
    explorerReturns({
      txCount: 3,
      utxos: [
        { txid: 'ef'.repeat(32), outputIndex: 0, script: P2PK, satoshis: 999_000, height: 800 },
        { txid: 'ab'.repeat(32), outputIndex: 0, script: P2PKH, satoshis: 1_000, height: 800 },
      ],
    });

    const info = await fetchAddressInfo([ADDRESS], 'mainnet');

    expect(info.get(ADDRESS)?.utxos).toHaveLength(1);
    expect(info.get(ADDRESS)?.utxos[0]?.value).toBe(1_000n);
    // The address is still USED: discovery scans on txCount, so dropping the
    // unspendable output must not shorten the scan.
    expect(info.get(ADDRESS)?.txCount).toBe(3);
  });

  // A freshly derived address is exactly this until someone pays it, and
  // gap-limit discovery has to tell "never used" from "not asked about".
  test('an address the chain has never seen answers zero, not absent', async () => {
    globalThis.fetch = mock(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const info = await fetchAddressInfo([ADDRESS], 'mainnet');

    expect(info.get(ADDRESS)).toEqual({ txCount: 0, utxos: [] });
  });
});
