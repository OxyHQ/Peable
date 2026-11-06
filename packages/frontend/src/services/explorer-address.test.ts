import { test, expect, afterEach } from 'bun:test';
import { fetchAddressActivity, fetchBalancesSat } from './explorer-address';

// Shape pinned against the LIVE endpoint (probed 2026-09-06):
//   GET https://explorer.fairco.in/api/address/:address?network=mainnet
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondPerAddress(balances: Record<string, number | null>): { calls: string[] } {
  const calls: string[] = [];
  const handler = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const address = decodeURIComponent(url.split('/api/address/')[1]?.split('?')[0] ?? '');
    const balanceSat = balances[address];
    if (balanceSat === null || balanceSat === undefined) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        addressInfo: { address, balanceSat, txCount: 1, utxos: [] },
        network: 'mainnet',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
  return { calls };
}

test('sums the balances of every address it is given', async () => {
  respondPerAddress({ Fa: 100, Fb: 250 });
  const result = await fetchBalancesSat(['Fa', 'Fb'], 'mainnet');
  expect(result.totalSat).toBe(350n);
  expect(result.byAddress.get('Fb')).toBe(250n);
});

/**
 * A freshly derived receive address is unknown to the explorer until someone
 * pays it. Treating that as an error would make a wallet with ONE unused
 * address fail to show any balance at all.
 */
test('counts an address the explorer does not know as zero, not an error', async () => {
  respondPerAddress({ Fa: 100, Funused: null });
  const result = await fetchBalancesSat(['Fa', 'Funused'], 'mainnet');
  expect(result.totalSat).toBe(100n);
  expect(result.byAddress.get('Funused')).toBe(0n);
});

test('makes no request at all for an empty address list', async () => {
  const { calls } = respondPerAddress({});
  const result = await fetchBalancesSat([], 'mainnet');
  expect(result.totalSat).toBe(0n);
  expect(calls).toEqual([]);
});

/**
 * The network must reach the query string: mainnet and testnet are different
 * chains, and asking the wrong one answers a confident, wrong balance.
 */
test('asks the explorer for the requested network', async () => {
  const { calls } = respondPerAddress({ Ta: 7 });
  await fetchBalancesSat(['Ta'], 'testnet');
  expect(calls[0]).toContain('network=testnet');
});

/** Answer with one status for every address, whatever it is. */
function respondWith(status: number, body = '{}'): void {
  const handler = async () => new Response(body, { status });
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
}

/**
 * Only the 404 above means zero. Every other failure THROWS.
 *
 * This function used to answer `0n` for any `!response.ok`, reusing the
 * unknown-address reason — true for one status — as the answer to all of them.
 * A wallet showing zero during an explorer outage or a rate limit tells someone
 * their money is gone, which is the worst thing this screen can say and the one
 * thing it must never say by accident. Throwing lets the caller's query report
 * the balance as unavailable and keep whatever it had on screen.
 *
 * 429 and 503 are named separately rather than looped, because they are the two
 * that actually happen: a rate limit under a wallet with many addresses, and an
 * explorer restart.
 */
test('throws on a rate limit rather than reporting a zero balance', async () => {
  respondWith(429);
  expect(fetchBalancesSat(['Fa'], 'mainnet')).rejects.toThrow(/429/);
});

test('throws on an explorer outage rather than reporting a zero balance', async () => {
  respondWith(503);
  expect(fetchBalancesSat(['Fa'], 'mainnet')).rejects.toThrow(/503/);
});

/**
 * A 200 carrying something this cannot read is not a zero balance either — it
 * is an answer we do not understand, and guessing the most alarming possible
 * number from it is not a safe default.
 */
test('throws on a successful response with no usable balanceSat', async () => {
  respondWith(200, JSON.stringify({ addressInfo: { balanceSat: 'not-a-number' } }));
  expect(fetchBalancesSat(['Fa'], 'mainnet')).rejects.toThrow(/balanceSat/);
});

/**
 * `balanceSat` above `Number.MAX_SAFE_INTEGER` has already been rounded by
 * `JSON.parse` before any code here can see it, so the value is not the number
 * the chain holds. Refusing is the only honest answer — and it is why this
 * function reads `balanceSat` and never the unbounded cumulative totals beside
 * it, one of which is already within 1.3x of that ceiling.
 */
test('throws rather than reporting a balance JSON.parse has already rounded', async () => {
  respondWith(200, `{"addressInfo":{"balanceSat":${String(Number.MAX_SAFE_INTEGER)}0}}`);
  expect(fetchBalancesSat(['Fa'], 'mainnet')).rejects.toThrow(/balanceSat/);
});

/**
 * Vacuity floor. Every case above asserts a REFUSAL and would pass against a
 * function that threw on everything — including the unknown address that must
 * still answer zero, which is the behaviour the original over-broad `0n` was
 * protecting and which this change must not lose.
 */
test('still answers zero for the one case that means zero', async () => {
  respondPerAddress({ Funused: null });
  const result = await fetchBalancesSat(['Funused'], 'mainnet');
  expect(result.byAddress.get('Funused')).toBe(0n);
  expect(result.totalSat).toBe(0n);
});

function respondPerRequest(handler: (address: string) => Response): { calls: string[] } {
  const calls: string[] = [];
  const fetchStub = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(decodeURIComponent(url.split('/api/address/')[1]?.split('?')[0] ?? ''));
  };
  globalThis.fetch = Object.assign(fetchStub, { preconnect: realFetch.preconnect });
  return { calls };
}

function addressBody(utxos: unknown[]): Response {
  return new Response(JSON.stringify({ addressInfo: { balanceSat: 0, txCount: 1, utxos } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('activity: the confirmed heights of an address, ascending, and whether the mempool holds one', async () => {
  respondPerRequest(() =>
    addressBody([
      { txid: 'aa', outputIndex: 0, satoshis: 1, height: 900 },
      { txid: 'bb', outputIndex: 1, satoshis: 1, height: 0 },
      { txid: 'cc', outputIndex: 0, satoshis: 1, height: 700 },
    ]),
  );
  const result = await fetchAddressActivity(['Fa'], 'mainnet');
  expect(result.get('Fa')).toEqual({ confirmedHeights: [700, 900], hasUnconfirmed: true });
});

test('activity: an address the explorer does not know holds nothing', async () => {
  respondPerRequest(() => new Response('{}', { status: 404 }));
  const result = await fetchAddressActivity(['Fa'], 'mainnet');
  expect(result.get('Fa')).toEqual({ confirmedHeights: [], hasUnconfirmed: false });
});

// The caller records an index as checked once this answers. A 502 read as
// "nothing here" would be a payment nobody ever looks for again.
test('activity: any other failure throws rather than reading as unpaid', async () => {
  respondPerRequest((address) =>
    address === 'Fb' ? new Response('', { status: 502 }) : addressBody([]),
  );
  await expect(fetchAddressActivity(['Fa', 'Fb'], 'mainnet')).rejects.toThrow(/502/);
  respondPerRequest(() => new Response(JSON.stringify({ addressInfo: {} }), { status: 200 }));
  await expect(fetchAddressActivity(['Fa'], 'mainnet')).rejects.toThrow(/utxo list/);
});

test('activity: reads each address once, a bounded number at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const fetchStub = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return addressBody([]);
  };
  globalThis.fetch = Object.assign(fetchStub, { preconnect: realFetch.preconnect });
  const addresses = Array.from({ length: 40 }, (_, i) => `F${String(i)}`);
  const result = await fetchAddressActivity([...addresses, 'F0'], 'mainnet');
  expect(result.size).toBe(40);
  expect(calls).toHaveLength(40);
  expect(peak).toBeLessThanOrEqual(8);
});
