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

const {
  deriveIdentitySeed,
  buildSeedSecret,
  identitySubjectOfWalletId,
  identityWalletIdOf,
  isIdentityWalletId,
  LEGACY_IDENTITY_WALLET_ID,
  personalSubject,
  PEABLE_SEED_INFO,
  SEED_SECRET_PREFIX,
} = await import('./identity-wallet');

const ACCOUNT_A = '0123456789abcdef01234567';
const ACCOUNT_B = '76543210fedcba9876543210';
const KEY = `02${'11'.repeat(32)}`;

describe('deriveIdentitySeed', () => {
  test('passes the Peable FairCoin domain info and ALWAYS names the key (R5-1)', async () => {
    scopedResult = new Uint8Array(32).fill(7);
    const seed = await deriveIdentitySeed(personalSubject(ACCOUNT_A), KEY);
    // Never the unselected read, which takes the keychain group every Oxy app
    // can write: the key the wallet decided on, by its public key.
    // Its retired keys are reached only as THIS account's (core 7.33.0, R5-2).
    expect(deriveScopedSeed).toHaveBeenLastCalledWith('peable/faircoin/v1', {
      ownerAccountId: ACCOUNT_A,
      publicKey: KEY,
    });
    expect(PEABLE_SEED_INFO).toBe('peable/faircoin/v1');
    expect(seed).toEqual(new Uint8Array(32).fill(7));
  });

  test("an organization's seed names its account and its key", async () => {
    scopedResult = new Uint8Array(32).fill(7);
    await deriveIdentitySeed({ kind: 'organization', accountId: ACCOUNT_B }, KEY);
    expect(deriveScopedSeed).toHaveBeenLastCalledWith('peable/faircoin/v1', {
      accountId: ACCOUNT_B,
      publicKey: KEY,
    });
  });

  test('returns null when this device does not hold the key named', async () => {
    scopedResult = null;
    expect(await deriveIdentitySeed(personalSubject(ACCOUNT_A), KEY)).toBeNull();
  });
});

describe('identity wallet ids (R5-2)', () => {
  test("each person's wallet is its own namespace, named by the account", () => {
    const a = identityWalletIdOf(personalSubject(ACCOUNT_A));
    const b = identityWalletIdOf(personalSubject(ACCOUNT_B));
    expect(a).toBe(`oxy-user-${ACCOUNT_A}`);
    expect(a).not.toBe(b);
    expect(identitySubjectOfWalletId(a)).toEqual(personalSubject(ACCOUNT_A));
    expect(identitySubjectOfWalletId(`oxy-org-${ACCOUNT_B}`)).toEqual({
      kind: 'organization',
      accountId: ACCOUNT_B,
    });
  });

  test('the legacy shared id names no account and is never opened as anyone’s', () => {
    expect(identitySubjectOfWalletId(LEGACY_IDENTITY_WALLET_ID)).toBeNull();
    expect(isIdentityWalletId(LEGACY_IDENTITY_WALLET_ID)).toBe(true);
    expect(identitySubjectOfWalletId('oxy-user-')).toBeNull();
    expect(isIdentityWalletId('3f2c-bip39-wallet')).toBe(false);
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
