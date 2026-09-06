import { test, expect } from "bun:test";
import { discoverUtxos, type AddressSource } from "./explorer-sync";
import type { AddressInfo } from "../services/explorer-address";
import type { UTXO } from "./utxo-set";

/**
 * A KeyManager stand-in that derives `a<n>` for external index n and `c<n>` for
 * change, so a test can say which addresses were "used" without building real
 * key material.
 */
function fakeKeyManager(): AddressSource & { derivedThrough: number } {
  let external = 0;
  let change = 0;
  return {
    derivedThrough: 0,
    restoreCursors(externalNext: number, changeNext: number) {
      external = Math.max(external, externalNext);
      change = Math.max(change, changeNext);
      this.derivedThrough = external;
    },
    getAllAddresses() {
      const out: string[] = [];
      for (let i = 0; i < external; i++) out.push(`a${i}`);
      for (let i = 0; i < change; i++) out.push(`c${i}`);
      return out;
    },
  };
}

function utxoAt(address: string, value: bigint): UTXO {
  return {
    txid: "bb".repeat(32),
    vout: 0,
    address,
    value,
    scriptPubKey: new Uint8Array([1]),
    blockHeight: 100,
    confirmed: true,
  };
}

function infoFor(used: Record<string, bigint | 0>) {
  return async (addresses: readonly string[]): Promise<Map<string, AddressInfo>> => {
    const map = new Map<string, AddressInfo>();
    for (const address of addresses) {
      const value = used[address];
      map.set(
        address,
        value === undefined
          ? { txCount: 0, utxos: [] }
          : { txCount: 1, utxos: value === 0 ? [] : [utxoAt(address, value)] },
      );
    }
    return map;
  };
}

test("collects the UTXOs of every used address", async () => {
  const utxos = await discoverUtxos(fakeKeyManager(), "testnet", infoFor({ a0: 100n, a2: 50n }));
  expect(utxos.reduce((sum, u) => sum + u.value, 0n)).toBe(150n);
});

/**
 * The property the whole scan exists for. An address that received and was then
 * swept holds nothing but IS used; a scan that stopped at the first empty
 * address would never reach `a30` and would report a balance short by its
 * amount, with no sign that anything was missed.
 */
test("keeps scanning past a used-but-emptied address", async () => {
  const utxos = await discoverUtxos(
    fakeKeyManager(),
    "testnet",
    infoFor({ a0: 0, a1: 0, a2: 0, a30: 777n }),
  );
  expect(utxos.map((u) => u.address)).toEqual(["a30"]);
});

test("stops once a full gap of unused addresses is reached", async () => {
  const keyManager = fakeKeyManager();
  await discoverUtxos(keyManager, "testnet", infoFor({}));
  // A wallet with no history must not scan forever.
  expect(keyManager.derivedThrough).toBeLessThan(100);
});

test("finds nothing, and no UTXOs, for a wallet that was never used", async () => {
  expect(await discoverUtxos(fakeKeyManager(), "testnet", infoFor({}))).toEqual([]);
});
