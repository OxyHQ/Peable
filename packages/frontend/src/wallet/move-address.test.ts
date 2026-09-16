import { describe, test, expect } from "bun:test";
import { getNetwork, deriveAddress } from "@fairco.in/core";
import { mnemonicToSeedSync } from "@scure/bip39";
import { KeyManager } from "@peable.to/pay";
import { resolveMoveDestinationAddress } from "./move-address";

const MAINNET = getNetwork("mainnet");
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("resolveMoveDestinationAddress", () => {
  test("derives the destination account's external address at the given index", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const dest = resolveMoveDestinationAddress(seed, MAINNET, 1, 0);
    expect(dest.index).toBe(0);
    expect(dest.path).toBe(`m/44'/${MAINNET.bip44CoinType}'/1'/0/0`);
    expect(dest.address).toBe(deriveAddress(seed, 1, 0, 0, MAINNET).address);
  });

  test("respects a non-zero next-unused index", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const dest = resolveMoveDestinationAddress(seed, MAINNET, 2, 3);
    expect(dest.index).toBe(3);
    expect(dest.address).toBe(deriveAddress(seed, 2, 0, 3, MAINNET).address);
  });

  test("destination address belongs to the destination Pocket, not the source", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const source = KeyManager.fromSeed(seed, MAINNET, 0);
    const dest = resolveMoveDestinationAddress(seed, MAINNET, 1, 0);
    expect(source.ownsAddress(dest.address)).toBe(false);
  });
});
