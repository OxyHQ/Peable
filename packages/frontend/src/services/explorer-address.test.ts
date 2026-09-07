import { test, expect, afterEach } from "bun:test";
import { fetchBalancesSat } from "./explorer-address";

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
    const address = decodeURIComponent(url.split("/api/address/")[1]?.split("?")[0] ?? "");
    const balanceSat = balances[address];
    if (balanceSat === null || balanceSat === undefined) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(
      JSON.stringify({ addressInfo: { address, balanceSat, txCount: 1, utxos: [] }, network: "mainnet" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
  return { calls };
}

test("sums the balances of every address it is given", async () => {
  respondPerAddress({ Fa: 100, Fb: 250 });
  const result = await fetchBalancesSat(["Fa", "Fb"], "mainnet");
  expect(result.totalSat).toBe(350n);
  expect(result.byAddress.get("Fb")).toBe(250n);
});

/**
 * A freshly derived receive address is unknown to the explorer until someone
 * pays it. Treating that as an error would make a wallet with ONE unused
 * address fail to show any balance at all.
 */
test("counts an address the explorer does not know as zero, not an error", async () => {
  respondPerAddress({ Fa: 100, Funused: null });
  const result = await fetchBalancesSat(["Fa", "Funused"], "mainnet");
  expect(result.totalSat).toBe(100n);
  expect(result.byAddress.get("Funused")).toBe(0n);
});

test("makes no request at all for an empty address list", async () => {
  const { calls } = respondPerAddress({});
  const result = await fetchBalancesSat([], "mainnet");
  expect(result.totalSat).toBe(0n);
  expect(calls).toEqual([]);
});

/**
 * The network must reach the query string: mainnet and testnet are different
 * chains, and asking the wrong one answers a confident, wrong balance.
 */
test("asks the explorer for the requested network", async () => {
  const { calls } = respondPerAddress({ Ta: 7 });
  await fetchBalancesSat(["Ta"], "testnet");
  expect(calls[0]).toContain("network=testnet");
});
