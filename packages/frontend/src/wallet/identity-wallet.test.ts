import { describe, test, expect, mock } from 'bun:test';
import { getNetwork, hexToBytes } from '@fairco.in/core';
import { KeyManager as FairKeyManager } from '@peable.to/pay';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

// Mock @oxy.so/core/crypto BEFORE importing the module under test. `mock.module` is
// process-wide, so the replacement must KEEP every other export: a factory
// returning only `KeyManager` deletes the rest of the Oxy SDK for every test
// file that runs after this one in the same `bun test` process, and any module
// importing e.g. `isValidUsername` then fails to load. The spread snapshots the
// real `@oxy.so/core/crypto` namespace into a plain object before the registry entry is replaced.
const realOxyCrypto = { ...(await import('@oxy.so/core/crypto')) };
let scopedResult: Uint8Array | null = new Uint8Array(32).fill(7);
const deriveScopedSeed = mock(async (_info: string) => scopedResult);
mock.module('@oxy.so/core/crypto', () => ({
  ...realOxyCrypto,
  KeyManager: { deriveScopedSeed },
}));

const { deriveIdentitySeed, buildSeedSecret, PEABLE_SEED_INFO, SEED_SECRET_PREFIX } = await import(
  './identity-wallet'
);

describe('deriveIdentitySeed', () => {
  test('passes the Peable FairCoin domain info and returns the seed', async () => {
    scopedResult = new Uint8Array(32).fill(7);
    const seed = await deriveIdentitySeed();
    expect(deriveScopedSeed).toHaveBeenCalledWith('peable/faircoin/v1');
    expect(PEABLE_SEED_INFO).toBe('peable/faircoin/v1');
    expect(seed).toEqual(new Uint8Array(32).fill(7));
  });

  test('returns null when core has no identity key (web / keyless)', async () => {
    scopedResult = null;
    expect(await deriveIdentitySeed()).toBeNull();
  });
});

describe('FairCoin derivation from the identity seed', () => {
  test('is deterministic and uses coin type 1 on testnet', () => {
    const seed = new Uint8Array(32).fill(9);
    const a = FairKeyManager.fromSeed(seed, getNetwork('testnet')).getNextAddress();
    const b = FairKeyManager.fromSeed(seed, getNetwork('testnet')).getNextAddress();
    expect(a.address).toBe(b.address);
    expect(a.address.length).toBeGreaterThan(0);
    expect(a.path).toBe("m/44'/1'/0'/0/0");
  });

  test('buildSeedSecret round-trips losslessly through hexToBytes', () => {
    const seed = new Uint8Array(32).fill(3);
    const secret = buildSeedSecret(seed);
    expect(secret.startsWith(SEED_SECRET_PREFIX)).toBe(true);
    const back = hexToBytes(secret.slice(SEED_SECRET_PREFIX.length));
    const fromRoundTrip = FairKeyManager.fromSeed(back, getNetwork('testnet')).getNextAddress()
      .address;
    const fromDirect = FairKeyManager.fromSeed(seed, getNetwork('testnet')).getNextAddress()
      .address;
    expect(fromRoundTrip).toBe(fromDirect);
  });
});

describe('wallet continuity: the identity key derives the SAME wallet as before', () => {
  // Pinned in the oxy repo's `packages/commons/modules/oxy-identity-host/vectors.json`
  // (identity key aa×32, `peable/faircoin/v1`): the seed Commons computes over
  // IPC on Android and `KeyManager.deriveScopedSeed` computes from the
  // keychain-group key on iOS. Any change here strands every existing wallet.
  const IDENTITY_KEY = 'aa'.repeat(32);
  const PINNED_SEED = '3282e7b8585d3de14fc8856debc352b7b238eccd5c861ec33c92a443857e6040';

  test('the seed is the HKDF this wallet has always used', () => {
    // Stated independently of @oxy.so/core: HKDF-SHA256(key, salt, info, 32),
    // the derivation Peable's wallets were created under.
    const utf8 = (s: string) => new TextEncoder().encode(s);
    const independent = hkdf(
      sha256,
      hexToBytes(IDENTITY_KEY),
      utf8('oxy-identity-scoped-seed-v1'),
      utf8(PEABLE_SEED_INFO),
      32,
    );
    expect(Buffer.from(independent).toString('hex')).toBe(PINNED_SEED);
  });

  test("@oxy.so/core's derivation (what Commons and the iOS SDK run) matches it", () => {
    const seed = realOxyCrypto.deriveScopedSeedFromKey(IDENTITY_KEY, PEABLE_SEED_INFO);
    expect(Buffer.from(seed).toString('hex')).toBe(PINNED_SEED);
  });

  test("the seed's first receive addresses are pinned", () => {
    const seed = hexToBytes(PINNED_SEED);
    const mainnet = FairKeyManager.fromSeed(seed, getNetwork('mainnet')).getNextAddress();
    const testnet = FairKeyManager.fromSeed(seed, getNetwork('testnet')).getNextAddress();
    expect(mainnet).toMatchObject({
      address: 'FMPFAXJ7zw9xKttyBLzHaBh5QCu9T6kPjb',
      path: "m/44'/119'/0'/0/0",
    });
    expect(testnet).toMatchObject({
      address: 'TYeF2LDXgH7JLtPAQCGBhT8277if3mmakP',
      path: "m/44'/1'/0'/0/0",
    });
  });
});
