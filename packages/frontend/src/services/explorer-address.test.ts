import { test, expect, afterEach } from "bun:test";
import { fetchAddressInfo } from "./explorer-address";

// Shape pinned against the LIVE endpoint (probed 2026-09-06):
//   GET https://explorer.fairco.in/api/address/:address?network=mainnet
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FakeUtxo {
  txid: string;
  outputIndex: number;
  script: string;
  satoshis: number;
  height: number;
}

function respondPerAddress(
  utxos: Record<string, FakeUtxo[] | null>,
  txCounts: Record<string, number> = {},
): { calls: string[] } {
  const calls: string[] = [];
  const handler = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const address = decodeURIComponent(url.split("/api/address/")[1]?.split("?")[0] ?? "");
    const list = utxos[address];
    if (list === null || list === undefined) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        addressInfo: {
          address,
          balanceSat: list.reduce((sum, u) => sum + u.satoshis, 0),
          txCount: txCounts[address] ?? list.length,
          utxos: list.map((u) => ({ ...u, address })),
        },
        network: "mainnet",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
  return { calls };
}

const UTXO: FakeUtxo = {
  txid: "aa".repeat(32),
  outputIndex: 1,
  script: "76a914fe274341ca09164d65993bd32c7a7c8b57102abb88ac",
  satoshis: 250,
  height: 140000,
};

test("returns one UTXO per explorer entry, in the wallet's own shape", async () => {
  respondPerAddress({ Fa: [UTXO] });
  const [utxo] = (await fetchAddressInfo(["Fa"], "mainnet")).get("Fa")?.utxos ?? [];
  expect(utxo?.txid).toBe(UTXO.txid);
  expect(utxo?.vout).toBe(1);
  expect(utxo?.address).toBe("Fa");
  expect(utxo?.value).toBe(250n);
  expect(utxo?.blockHeight).toBe(140000);
  expect(utxo?.scriptPubKey).toBeInstanceOf(Uint8Array);
});

/**
 * `height: 0` is what the explorer reports for an output that is not in a block
 * yet. Marking it confirmed would let the wallet spend a mempool output as if
 * it were settled.
 */
test("treats a zero-height output as unconfirmed", async () => {
  respondPerAddress({ Fa: [{ ...UTXO, height: 0 }] });
  const [utxo] = (await fetchAddressInfo(["Fa"], "mainnet")).get("Fa")?.utxos ?? [];
  expect(utxo?.confirmed).toBe(false);
});

test("marks an output that is in a block as confirmed", async () => {
  respondPerAddress({ Fa: [UTXO] });
  const [utxo] = (await fetchAddressInfo(["Fa"], "mainnet")).get("Fa")?.utxos ?? [];
  expect(utxo?.confirmed).toBe(true);
});

/**
 * A freshly derived receive address is unknown to the explorer until someone
 * pays it. Throwing there would make a wallet whose newest address is unused
 * fail to load at all.
 */
test("skips an address the explorer does not know", async () => {
  respondPerAddress({ Fa: [UTXO], Funused: null });
  const info = await fetchAddressInfo(["Fa", "Funused"], "mainnet");
  expect(info.get("Fa")?.utxos).toHaveLength(1);
  // Present, and reported as never used — not absent, which a caller doing
  // gap-limit discovery could not tell from "not asked for".
  expect(info.get("Funused")).toEqual({ txCount: 0, utxos: [] });
});

test("makes no request at all for an empty address list", async () => {
  const { calls } = respondPerAddress({});
  expect((await fetchAddressInfo([], "mainnet")).size).toBe(0);
  expect(calls).toEqual([]);
});

test("asks the explorer for the requested network", async () => {
  const { calls } = respondPerAddress({ Ta: [] });
  await fetchAddressInfo(["Ta"], "testnet");
  expect(calls[0]).toContain("network=testnet");
});

/**
 * `txCount` is what gap-limit discovery scans on: an address that RECEIVED and
 * was then swept holds no UTXOs but is used, and a scan that stopped at it would
 * miss every address beyond — under-reporting the balance while looking
 * authoritative.
 */
test("reports an address that was used and then emptied as used", async () => {
  respondPerAddress({ Fa: [] }, { Fa: 4 });
  const info = await fetchAddressInfo(["Fa"], "mainnet");
  expect(info.get("Fa")).toEqual({ txCount: 4, utxos: [] });
});
