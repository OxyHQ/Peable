/**
 * One-off generator for the watch-only xpub test vector used by
 * `services/derivation.ts` tests (Task 4). Run: `bun run scripts/gen-xpub-vector.ts`.
 *
 * Derives a FairCoin **testnet** account xpub from a fixed BIP39 mnemonic and
 * prints the first external receive addresses, so the derivation test has
 * deterministic expected values without embedding a seed.
 */
import {
  mnemonicToSeed,
  validateMnemonic,
  deriveKeyFromSeed,
  publicKeyToAddress,
  TESTNET,
} from '@fairco.in/core';
import { HDKey } from '@scure/bip32';

// Canonical 24-word BIP39 test mnemonic (all "abandon" + checksum word "art").
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

if (!validateMnemonic(MNEMONIC)) throw new Error('test mnemonic invalid');

const seed = mnemonicToSeed(MNEMONIC);
const root = deriveKeyFromSeed(seed, TESTNET);
const accountPath = `m/44'/${TESTNET.bip44CoinType}'/0'`;
const accountXpub = root.derive(accountPath).hdKey.publicExtendedKey;

// Watch-only derivation exactly as the backend will do it.
const node = HDKey.fromExtendedKey(accountXpub, {
  public: TESTNET.bip32.public,
  private: TESTNET.bip32.private,
});

function addr(change: number, index: number): string {
  const child = node.deriveChild(change).deriveChild(index);
  if (!child.publicKey) throw new Error('no public key derived');
  return publicKeyToAddress(child.publicKey, TESTNET);
}

console.log(
  JSON.stringify(
    {
      network: 'testnet',
      accountPath,
      bip44CoinType: TESTNET.bip44CoinType,
      xpub: accountXpub,
      external: { '0/0': addr(0, 0), '0/1': addr(0, 1), '0/2': addr(0, 2) },
    },
    null,
    2,
  ),
);
