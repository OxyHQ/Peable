import { test, expect } from 'bun:test';
import { TESTNET, mnemonicToSeed, deriveKeyFromSeed } from '@fairco.in/core';
import { HDKey } from '@scure/bip32';
import { deriveIntentAddress } from '../derivation';

// Watch-only account xpub for the canonical all-"abandon" + "art" testnet
// mnemonic, produced by `scripts/gen-xpub-vector.ts` (m/44'/1'/0' neutered).
const XPUB =
  'DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn';

// Same 24-word mnemonic the vector generator uses.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

test('derives deterministic external receive addresses from the xpub', () => {
  expect(deriveIntentAddress(XPUB, 0, 0, TESTNET)).toBe('TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3');
  expect(deriveIntentAddress(XPUB, 0, 1, TESTNET)).toBe('TVdQEadb9Yurh3QCBf1vwjZxNySQvHxFmk');
  expect(deriveIntentAddress(XPUB, 0, 2, TESTNET)).toBe('TRhbVij2oTwETnzpVNDixacseS48FZgsUZ');
});

test('distinct indexes yield distinct addresses', () => {
  const a0 = deriveIntentAddress(XPUB, 0, 0, TESTNET);
  const a1 = deriveIntentAddress(XPUB, 0, 1, TESTNET);
  expect(a1).not.toBe(a0);
});

test('rejects a private xprv (non-custody guard)', () => {
  const seed = mnemonicToSeed(MNEMONIC);
  const root = deriveKeyFromSeed(seed, TESTNET);
  const accountNode = root.derive(`m/44'/${TESTNET.bip44CoinType}'/0'`);
  const xprv = accountNode.hdKey.privateExtendedKey;

  // Sanity: the extended key we built really is private (carries a key).
  const parsed = HDKey.fromExtendedKey(xprv, {
    public: TESTNET.bip32.public,
    private: TESTNET.bip32.private,
  });
  expect(parsed.privateKey).not.toBeNull();

  expect(() => deriveIntentAddress(xprv, 0, 0, TESTNET)).toThrow('watch-only violation');
});
