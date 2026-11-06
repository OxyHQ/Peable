/**
 * Regression test for the Pockets↔Peable integration bug: `switchPocket` and
 * `moveBetweenPockets` reconstructed a wallet's spending secret via
 * `getWalletMnemonic`/`getCachedWalletSeed` only, which works for BIP39
 * wallets but not Peable's PRIMARY wallet — the identity-derived wallet
 * (`oxy-user-<accountId>`), whose seed is NEVER persisted (re-derived from
 * the Oxy identity each boot, see identity-wallet.ts). Every Peable user is
 * on the identity wallet, so this broke Pockets switch/move for all of them.
 *
 * `resolveWalletSeed` is the single, identity-wallet-aware fix both call
 * sites now route through. All dependencies are injected, so this exercises
 * the real branching logic without touching SecureStore/Keychain or the Oxy
 * identity key manager.
 */

import { describe, test, expect, mock } from 'bun:test';
import { identityWalletIdOf, personalSubject } from './identity-wallet';

const PERSON_ID = '0123456789abcdef0123abcd';
const PERSONAL_WALLET_ID = identityWalletIdOf(personalSubject(PERSON_ID));
import {
  resolveWalletSeed,
  getOrDeriveBip39Seed,
  XPUB_MARKER_PREFIX,
  type ResolveWalletSeedDeps,
} from './resolve-wallet-seed';

const IDENTITY_SEED = new Uint8Array(32).fill(7);
const BIP39_MNEMONIC = 'test mnemonic phrase';
const BIP39_SEED = new Uint8Array(32).fill(3);
const CACHED_SEED = new Uint8Array(32).fill(9);

function makeDeps(overrides: Partial<ResolveWalletSeedDeps> = {}): ResolveWalletSeedDeps {
  return {
    deriveIdentitySeed: mock(async () => IDENTITY_SEED),
    getWalletMnemonic: mock(async () => BIP39_MNEMONIC),
    getCachedWalletSeed: mock(async () => null),
    cacheWalletSeed: mock(async () => {}),
    deriveSeed: mock(() => BIP39_SEED),
    ...overrides,
  };
}

describe('resolveWalletSeed — identity wallet', () => {
  test('resolves via deriveIdentitySeed, never touching secure-store', async () => {
    const deps = makeDeps();
    const seed = await resolveWalletSeed(PERSONAL_WALLET_ID, deps);
    expect(seed).toEqual(IDENTITY_SEED);
    expect(deps.deriveIdentitySeed).toHaveBeenCalledTimes(1);
    expect(deps.deriveIdentitySeed).toHaveBeenCalledWith(personalSubject(PERSON_ID));
    expect(deps.getWalletMnemonic).not.toHaveBeenCalled();
    expect(deps.getCachedWalletSeed).not.toHaveBeenCalled();
  });

  test('throws a clear error when the identity is unavailable (web / keyless)', async () => {
    const deps = makeDeps({ deriveIdentitySeed: mock(async () => null) });
    await expect(resolveWalletSeed(PERSONAL_WALLET_ID, deps)).rejects.toThrow(/identity/i);
  });
});

describe('resolveWalletSeed — an organization identity wallet (oxy ADR 0061)', () => {
  const ORG_ID = '0123456789abcdef01234567';

  test("derives from the ORGANIZATION's key, never the person's, and never from secure-store", async () => {
    const deps = makeDeps();
    const seed = await resolveWalletSeed(
      identityWalletIdOf({ kind: 'organization', accountId: ORG_ID }),
      deps,
    );
    expect(seed).toEqual(IDENTITY_SEED);
    expect(deps.deriveIdentitySeed).toHaveBeenCalledWith({
      kind: 'organization',
      accountId: ORG_ID,
    });
    expect(deps.getWalletMnemonic).not.toHaveBeenCalled();
    expect(deps.getCachedWalletSeed).not.toHaveBeenCalled();
  });

  test('throws when this phone cannot reach the organization key', async () => {
    const deps = makeDeps({ deriveIdentitySeed: mock(async () => null) });
    await expect(
      resolveWalletSeed(identityWalletIdOf({ kind: 'organization', accountId: ORG_ID }), deps),
    ).rejects.toThrow(/identity/i);
  });
});

describe('resolveWalletSeed — BIP39 wallet', () => {
  test('returns the cached seed without fetching the mnemonic', async () => {
    const deps = makeDeps({ getCachedWalletSeed: mock(async () => CACHED_SEED) });
    const seed = await resolveWalletSeed('wallet-1', deps);
    expect(seed).toEqual(CACHED_SEED);
    expect(deps.getWalletMnemonic).not.toHaveBeenCalled();
    expect(deps.deriveSeed).not.toHaveBeenCalled();
  });

  test('derives from the mnemonic and caches it when the cache is empty', async () => {
    const deps = makeDeps();
    const seed = await resolveWalletSeed('wallet-1', deps);
    expect(seed).toEqual(BIP39_SEED);
    expect(deps.deriveSeed).toHaveBeenCalledWith(BIP39_MNEMONIC);
    expect(deps.cacheWalletSeed).toHaveBeenCalledWith('wallet-1', BIP39_SEED);
  });

  test('throws when no mnemonic is stored for the wallet id', async () => {
    const deps = makeDeps({ getWalletMnemonic: mock(async () => null) });
    await expect(resolveWalletSeed('missing-wallet', deps)).rejects.toThrow(
      'Wallet mnemonic not found',
    );
  });
});

describe('resolveWalletSeed — watch-only wallet', () => {
  test('throws a clear error instead of deriving a spending key', async () => {
    const deps = makeDeps({
      getWalletMnemonic: mock(async () => `${XPUB_MARKER_PREFIX}xpubFakeExtendedKey`),
    });
    await expect(resolveWalletSeed('watch-only-wallet', deps)).rejects.toThrow(/watch-only/i);
    expect(deps.deriveSeed).not.toHaveBeenCalled();
  });
});

describe('getOrDeriveBip39Seed', () => {
  test('reuses the cached seed when present', async () => {
    const deps = makeDeps({ getCachedWalletSeed: mock(async () => CACHED_SEED) });
    const seed = await getOrDeriveBip39Seed('wallet-1', BIP39_MNEMONIC, deps);
    expect(seed).toEqual(CACHED_SEED);
    expect(deps.deriveSeed).not.toHaveBeenCalled();
    expect(deps.cacheWalletSeed).not.toHaveBeenCalled();
  });

  test('derives and caches on a cache miss', async () => {
    const deps = makeDeps();
    const seed = await getOrDeriveBip39Seed('wallet-1', BIP39_MNEMONIC, deps);
    expect(seed).toEqual(BIP39_SEED);
    expect(deps.cacheWalletSeed).toHaveBeenCalledWith('wallet-1', BIP39_SEED);
  });
});
