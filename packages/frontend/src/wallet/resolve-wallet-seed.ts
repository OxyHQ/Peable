/**
 * Resolve the spending seed for a wallet, identity-wallet-aware.
 *
 * A wallet's spendable seed comes from one of three places depending on kind:
 *  - identity wallet (`OXY_IDENTITY_WALLET_ID`): re-derived from the Oxy
 *    identity on every call — it is NEVER persisted (see identity-wallet.ts).
 *  - BIP39 wallet: the cached seed if present, else derived from the stored
 *    mnemonic (PBKDF2, expensive) and cached for next time.
 *  - watch-only wallet (`xpub:` marker mnemonic): has no spending seed.
 *
 * `switchPocket` and `moveBetweenPockets` (wallet-store.ts) both need this
 * exact resolution; this is the ONE place it happens, so neither special-cases
 * `walletId === OXY_IDENTITY_WALLET_ID` on its own. `initialize`'s own
 * secret-to-KeyManager dance shares the BIP39 cache-or-derive step below
 * ({@link getOrDeriveBip39Seed}) rather than keeping a third divergent copy.
 *
 * Every dependency is injected — this module does no I/O and does not import
 * `../storage/secure-store`, which pulls in `react-native` and can't load
 * under the bun test runner (see storage/pin-attempts.test.ts). wallet-store.ts,
 * which already imports the real implementations for its own use, wires them
 * through once.
 */

import { OXY_IDENTITY_WALLET_ID } from './identity-wallet';

/**
 * Prefix stored in place of a mnemonic for watch-only wallets:
 * `xpub:<account-level extended public key>`. `initialize` routes any secret
 * with this prefix to the public-only KeyManager (no private keys derived).
 */
export const XPUB_MARKER_PREFIX = 'xpub:';

export interface ResolveWalletSeedDeps {
  deriveIdentitySeed: () => Promise<Uint8Array | null>;
  getWalletMnemonic: (walletId: string) => Promise<string | null>;
  getCachedWalletSeed: (walletId: string) => Promise<Uint8Array | null>;
  cacheWalletSeed: (walletId: string, seed: Uint8Array) => Promise<void>;
  deriveSeed: (mnemonic: string) => Uint8Array;
}

/**
 * Cache-first BIP39 seed derivation shared by every caller that ends up
 * spending from a BIP39 mnemonic: derive the seed once (PBKDF2, several
 * seconds on Hermes), then reuse the cached bytes on every subsequent call
 * keyed by `cacheId`.
 */
export async function getOrDeriveBip39Seed(
  cacheId: string,
  mnemonic: string,
  deps: Pick<ResolveWalletSeedDeps, 'getCachedWalletSeed' | 'cacheWalletSeed' | 'deriveSeed'>,
): Promise<Uint8Array> {
  const cached = await deps.getCachedWalletSeed(cacheId);
  if (cached) return cached;
  const seed = deps.deriveSeed(mnemonic);
  await deps.cacheWalletSeed(cacheId, seed);
  return seed;
}

export async function resolveWalletSeed(
  walletId: string,
  deps: ResolveWalletSeedDeps,
): Promise<Uint8Array> {
  if (walletId === OXY_IDENTITY_WALLET_ID) {
    const seed = await deps.deriveIdentitySeed();
    if (!seed) {
      throw new Error('Oxy identity unavailable — cannot resolve wallet seed');
    }
    return seed;
  }

  // BIP39 wallet: reuse the cached seed when present (same cache `initialize`
  // populates), else fetch + validate the mnemonic and derive it.
  const cached = await deps.getCachedWalletSeed(walletId);
  if (cached) return cached;

  const mnemonic = await deps.getWalletMnemonic(walletId);
  if (!mnemonic) {
    throw new Error('Wallet mnemonic not found');
  }
  if (mnemonic.startsWith(XPUB_MARKER_PREFIX)) {
    throw new Error('Watch-only wallets have no spending seed');
  }

  return getOrDeriveBip39Seed(walletId, mnemonic, deps);
}
