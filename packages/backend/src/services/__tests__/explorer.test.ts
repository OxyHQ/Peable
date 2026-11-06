import { afterEach, describe, expect, test } from 'bun:test';
import { parseFairToUnits } from '@fairco.in/core';
import {
  addressHasTransaction,
  getAddressUsage,
  getTip,
  getTransaction,
  listAddressTransactions,
  useExplorerTimeout,
  verifyPayment,
  type ExplorerTx,
} from '../explorer';

// The Explorer response shapes below are pinned against the LIVE endpoints
// (probed 2026-07-18):
//   GET https://explorer.fairco.in/api/stats?network=mainnet
//   GET https://explorer.fairco.in/api/transaction/:txid?network=mainnet
// See ../explorer.ts for the recorded JSON paths.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replace the global fetch with one that always answers `body`/`status`,
// mimicking a real Response (ok/status/json()) via the platform Response.
// `preconnect` is carried over from the real fetch so the mock structurally
// satisfies `typeof fetch` without a cast.
function respondWith(body: unknown, status = 200): void {
  const handler = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  globalThis.fetch = Object.assign(handler, {
    preconnect: realFetch.preconnect,
  });
}

const STATS_BODY = {
  stats: {
    blockHeight: 67763,
    difficulty: 124.3,
    avgBlockTime: 120,
    phase: 'PoS',
  },
};

const TX_BODY = {
  transaction: {
    txid: '41bc0000000000000000000000000000000000000000000000000000000041bc',
    confirmations: 1,
    blockheight: 67763,
    vout: [
      // nonstandard output — no scriptPubKey.addresses, must be skipped.
      { value: 0, n: 0, scriptPubKey: { type: 'nonstandard' } },
      {
        value: 3769.9894497,
        n: 1,
        scriptPubKey: {
          type: 'pubkey',
          addresses: ['FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4'],
        },
      },
    ],
  },
  network: 'mainnet',
};

test('getTip parses stats.blockHeight', async () => {
  respondWith(STATS_BODY);
  expect(await getTip('mainnet')).toBe(67763);
});

test('getTransaction maps the standard output and skips the addressless vout', async () => {
  respondWith(TX_BODY);
  const tx = await getTransaction('41bc...', 'mainnet');
  if (tx === null) throw new Error('expected a transaction, got null');
  const expectedSat = parseFairToUnits('3769.9894497');
  if (expectedSat === null) throw new Error('fixture amount must parse');
  expect(tx.confirmations).toBe(1);
  expect(tx.outputs).toEqual([
    { address: 'FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4', valueSat: expectedSat },
  ]);
});

test('getTransaction returns null when the body carries no transaction', async () => {
  respondWith({ network: 'mainnet' });
  expect(await getTransaction('deadbeef', 'mainnet')).toBeNull();
});

test('getTransaction returns null on a non-200 response', async () => {
  respondWith({ error: 'not found' }, 404);
  expect(await getTransaction('deadbeef', 'mainnet')).toBeNull();
});

const PAID_TX: ExplorerTx = {
  txid: 'abc',
  confirmations: 3,
  outputs: [{ address: 'FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4', valueSat: 100n }],
};

test('verifyPayment: paid when an output matches the address and value >= expected', () => {
  expect(
    verifyPayment(PAID_TX, [{ address: 'FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4', amount: 100n }]),
  ).toEqual({
    paid: true,
    confirmations: 3,
  });
});

test('verifyPayment: not paid when the matching output underpays', () => {
  const result = verifyPayment(PAID_TX, [
    { address: 'FRwfgBQzXt3NTVxJ7YAMVZz9i84S9ZESi4', amount: 101n },
  ]);
  expect(result.paid).toBe(false);
  expect(result.confirmations).toBe(3);
});

test('verifyPayment: not paid when no output pays the address', () => {
  expect(
    verifyPayment(PAID_TX, [{ address: 'FSomeOtherAddress00000000000000000000', amount: 1n }]).paid,
  ).toBe(false);
});

const SPLIT_TX: ExplorerTx = {
  txid: 'def',
  confirmations: 1,
  outputs: [
    { address: 'FSellerA', valueSat: 700n },
    { address: 'FSellerB', valueSat: 300n },
    { address: 'FChange', valueSat: 5n },
  ],
};

test('verifyPayment: a split payment is paid only when EVERY output is (ADR 0021 D6)', () => {
  const both = [
    { address: 'FSellerA', amount: 700n },
    { address: 'FSellerB', amount: 300n },
  ];
  expect(verifyPayment(SPLIT_TX, both)).toEqual({ paid: true, confirmations: 1 });
  // One seller short, the other overpaid: still underpaid as a whole.
  expect(
    verifyPayment(SPLIT_TX, [
      { address: 'FSellerA', amount: 600n },
      { address: 'FSellerB', amount: 301n },
    ]).paid,
  ).toBe(false);
  // An output missing from the transaction.
  expect(verifyPayment(SPLIT_TX, [...both, { address: 'FSellerC', amount: 1n }]).paid).toBe(false);
  // Nothing expected is never paid.
  expect(verifyPayment(SPLIT_TX, []).paid).toBe(false);
});

// One real-network assertion: mainnet has a live, advancing tip (testnet is
// currently empty). Kept last so the mocked tests' fetch restore runs first.
test('getTip returns a positive tip from the live mainnet explorer', async () => {
  const tip = await getTip('mainnet');
  expect(tip).toBeGreaterThan(0);
}, 20000);

/** An address with `count` transactions, served 50 a page as the live Explorer does. */
function addressWithTransactions(count: number, reported?: number): string[] {
  const asked: string[] = [];
  const txids = Array.from({ length: count }, (_, i) =>
    i === reported ? 'reported' : `dust_${i}`,
  );
  const handler = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.search);
    const page = Number(url.searchParams.get('page') ?? '1');
    const limit = Math.min(50, Number(url.searchParams.get('limit') ?? '20'));
    const slice = txids.slice((page - 1) * limit, page * limit);
    return new Response(
      JSON.stringify({
        transactions: slice.map((txid) => ({ txid, type: 'received' })),
        page,
        limit,
        total: count,
        network: 'mainnet',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
  return asked;
}

test('addressHasTransaction reads every page: dust past the first page cannot hide the absence of the reported txid', async () => {
  addressWithTransactions(130);
  expect(await addressHasTransaction('F_addr', 'mainnet', 'reported')).toBe('no');
  addressWithTransactions(130, 120);
  expect(await addressHasTransaction('F_addr', 'mainnet', 'reported')).toBe('yes');
});

test('addressHasTransaction stops at 1 000 transactions and reads that as absent', async () => {
  const asked = addressWithTransactions(5_000);
  expect(await addressHasTransaction('F_addr', 'mainnet', 'reported')).toBe('no');
  expect(asked).toHaveLength(20);
});

test('addressHasTransaction is unknown when a page fails', async () => {
  respondWith({ error: 'Internal error' }, 500);
  expect(await addressHasTransaction('F_addr', 'mainnet', 'reported')).toBe('unknown');
});

test("getAddressUsage: a full answer is used/unused; testnet's no-index answer is unknown", async () => {
  respondWith({
    addressInfo: { txCount: 0, totalReceivedSat: 0, utxos: [] },
    network: 'mainnet',
  });
  expect(await getAddressUsage('F_addr', 'mainnet')).toBe('unused');
  respondWith({
    addressInfo: { txCount: 2, totalReceivedSat: 10, utxos: [] },
    network: 'mainnet',
  });
  expect(await getAddressUsage('F_addr', 'mainnet')).toBe('used');
  respondWith({
    addressInfo: {
      txCount: 0,
      totalReceivedSat: 0,
      utxos: [],
      isValid: false,
      note: 'addressindex not enabled on node; limited data available',
    },
    network: 'testnet',
  });
  expect(await getAddressUsage('T_addr', 'testnet')).toBe('unknown');
  respondWith({ error: 'Internal error' }, 500);
  expect(await getAddressUsage('F_addr', 'mainnet')).toBe('unknown');
});

// Round-3 review: no Explorer read had a timeout, so a stalled Explorer held a
// confirm's address check, the watcher's poll and the retire sweep for as long
// as the socket stayed open. Every read now carries a bounded signal, and an
// abandoned read is the Explorer not answering — never "missing" or "unused".
describe('every Explorer read is bounded', () => {
  let restoreTimeout: (() => void) | null = null;
  afterEach(() => {
    restoreTimeout?.();
    restoreTimeout = null;
  });

  /** A fetch that never answers (headers, or with `stallBody` the body) until its signal aborts. */
  function stall(stallBody = false): { signals: (AbortSignal | null | undefined)[] } {
    const signals: (AbortSignal | null | undefined)[] = [];
    const handler = (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      signals.push(signal);
      if (!stallBody) {
        return new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"addressInfo":'));
          signal?.addEventListener('abort', () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
    return { signals };
  }

  test('a stalled address read is unknown, never unused', async () => {
    restoreTimeout = useExplorerTimeout(20);
    const { signals } = stall();
    expect(await getAddressUsage('F_addr', 'mainnet')).toBe('unknown');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    stall(true);
    expect(await getAddressUsage('F_addr', 'mainnet')).toBe('unknown');
  });

  test('a stalled transaction read throws, never answers "missing" (null)', async () => {
    restoreTimeout = useExplorerTimeout(20);
    stall();
    await expect(getTransaction('41bc', 'mainnet')).rejects.toThrow();
    stall(true);
    await expect(getTransaction('41bc', 'mainnet')).rejects.toThrow();
  });

  test('a stalled tip or transaction list is the Explorer not answering', async () => {
    restoreTimeout = useExplorerTimeout(20);
    stall();
    await expect(getTip('mainnet')).rejects.toThrow();
    expect(await listAddressTransactions('F_addr', 'mainnet')).toBeNull();
    expect(await addressHasTransaction('F_addr', 'mainnet', 'reported')).toBe('unknown');
  });
});
