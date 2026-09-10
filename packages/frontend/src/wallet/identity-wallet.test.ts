import { describe, test, expect, mock } from "bun:test";
import { getNetwork, hexToBytes } from "@fairco.in/core";
import { KeyManager as FairKeyManager } from "./key-manager";

// Mock @oxy.so/core BEFORE importing the module under test. `mock.module` is
// process-wide, so the replacement must KEEP every other export: a factory
// returning only `KeyManager` deletes the rest of the Oxy SDK for every test
// file that runs after this one in the same `bun test` process, and any module
// importing e.g. `isValidUsername` then fails to load. The spread snapshots the
// real namespace into a plain object before the registry entry is replaced.
const realOxyCore = { ...(await import("@oxy.so/core")) };
let scopedResult: Uint8Array | null = new Uint8Array(32).fill(7);
const deriveScopedSeed = mock(async (_info: string) => scopedResult);
mock.module("@oxy.so/core", () => ({
  ...realOxyCore,
  KeyManager: { deriveScopedSeed },
}));

const { deriveIdentitySeed, buildSeedSecret, PEABLE_SEED_INFO, SEED_SECRET_PREFIX } =
  await import("./identity-wallet");

describe("deriveIdentitySeed", () => {
  test("passes the Peable FairCoin domain info and returns the seed", async () => {
    scopedResult = new Uint8Array(32).fill(7);
    const seed = await deriveIdentitySeed();
    expect(deriveScopedSeed).toHaveBeenCalledWith("peable/faircoin/v1");
    expect(PEABLE_SEED_INFO).toBe("peable/faircoin/v1");
    expect(seed).toEqual(new Uint8Array(32).fill(7));
  });

  test("returns null when core has no identity key (web / keyless)", async () => {
    scopedResult = null;
    expect(await deriveIdentitySeed()).toBeNull();
  });
});

describe("FairCoin derivation from the identity seed", () => {
  test("is deterministic and uses coin type 1 on testnet", () => {
    const seed = new Uint8Array(32).fill(9);
    const a = FairKeyManager.fromSeed(seed, getNetwork("testnet")).getNextAddress();
    const b = FairKeyManager.fromSeed(seed, getNetwork("testnet")).getNextAddress();
    expect(a.address).toBe(b.address);
    expect(a.address.length).toBeGreaterThan(0);
    expect(a.path).toBe("m/44'/1'/0'/0/0");
  });

  test("buildSeedSecret round-trips losslessly through hexToBytes", () => {
    const seed = new Uint8Array(32).fill(3);
    const secret = buildSeedSecret(seed);
    expect(secret.startsWith(SEED_SECRET_PREFIX)).toBe(true);
    const back = hexToBytes(secret.slice(SEED_SECRET_PREFIX.length));
    const fromRoundTrip = FairKeyManager.fromSeed(back, getNetwork("testnet")).getNextAddress().address;
    const fromDirect = FairKeyManager.fromSeed(seed, getNetwork("testnet")).getNextAddress().address;
    expect(fromRoundTrip).toBe(fromDirect);
  });
});
