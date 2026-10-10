import { describe, test, expect, mock } from 'bun:test';
import {
  buildTransaction,
  createP2PKHScript,
  decodeAddress,
  deriveSocialReceiveSpendingKey,
  getNetwork,
  hexToBytes,
  signInput,
} from '@fairco.in/core';

// Mock @oxy.so/core/crypto BEFORE importing the module under test — mirrors
// identity-wallet.test.ts's established pattern for wrapping KeyManager,
// including its spread: `mock.module` is process-wide, so replacing the module
// with only `KeyManager` would delete every other Oxy export for the rest of
// the run and break unrelated test files that import them.
//
// The fake holder is @oxy.so/core's own pure derivations over a test key: the
// same functions the iOS SDK runs and Commons' identity host reproduces
// natively on Android (pinned by the oxy repo's identity-host vectors.json).
const realOxyCrypto = { ...(await import('@oxy.so/core/crypto')) };
const IDENTITY_KEY_A = 'aa'.repeat(32);
// vectors.json: the published (uncompressed) public key of IDENTITY_KEY_A.
const IDENTITY_PUB_A =
  '046a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb336b6fbcb60b5b3d4f1551ac45e5ffc4936466e7d98f6c7c0ec736539f74691a6';
const IDENTITY_PUB_A_COMPRESSED =
  '026a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3';

let sharedPublicKeyResult: string | null = IDENTITY_PUB_A;
let holderKey: string | null = IDENTITY_KEY_A;
const getSharedPublicKey = mock(async () => sharedPublicKeyResult);
const signSocialReceive = mock(async (index: number, digest: string) =>
  holderKey ? realOxyCrypto.signSocialReceiveDigest(holderKey, index, digest) : null,
);
mock.module('@oxy.so/core/crypto', () => ({
  ...realOxyCrypto,
  KeyManager: { getSharedPublicKey, signSocialReceive },
}));

const {
  SOCIAL_RECEIVE_GAP_LIMIT,
  compressedPublicKeyHex,
  getIdentityPublicKeyHex,
  deriveSocialReceiveWatchWindow,
  signSocialReceiveInput,
  computeWindowExtension,
} = await import('./social-receive');

const TESTNET = getNetwork('testnet');

describe('SOCIAL_RECEIVE_GAP_LIMIT', () => {
  test('is 20', () => {
    expect(SOCIAL_RECEIVE_GAP_LIMIT).toBe(20);
  });
});

describe('getIdentityPublicKeyHex', () => {
  test("is the shared identity's public key, compressed", async () => {
    sharedPublicKeyResult = IDENTITY_PUB_A;
    expect(await getIdentityPublicKeyHex()).toBe(IDENTITY_PUB_A_COMPRESSED);
  });

  test('is null when no identity holder answers (web, keyless, Commons absent)', async () => {
    sharedPublicKeyResult = null;
    expect(await getIdentityPublicKeyHex()).toBeNull();
    sharedPublicKeyResult = IDENTITY_PUB_A;
  });
});

describe('compressedPublicKeyHex', () => {
  // The account publishes the uncompressed key and this device names its window
  // by the compressed one; two encodings of one key must compare equal, or the
  // cursor check turns social receive off for every account.
  test('names one key the same whatever its encoding', () => {
    expect(compressedPublicKeyHex(IDENTITY_PUB_A)).toBe(IDENTITY_PUB_A_COMPRESSED);
    expect(compressedPublicKeyHex(IDENTITY_PUB_A.toUpperCase())).toBe(IDENTITY_PUB_A_COMPRESSED);
    expect(compressedPublicKeyHex(IDENTITY_PUB_A_COMPRESSED)).toBe(IDENTITY_PUB_A_COMPRESSED);
    expect(compressedPublicKeyHex(hexToBytes(IDENTITY_PUB_A))).toBe(IDENTITY_PUB_A_COMPRESSED);
  });
});

describe('deriveSocialReceiveWatchWindow', () => {
  // The same addresses the window derived from the private key before Peable
  // stopped holding it: a wallet's watched addresses do not move.
  test('derives the pinned addr(0..2) starting at 0', () => {
    const window = deriveSocialReceiveWatchWindow(IDENTITY_PUB_A, 0, 3, TESTNET);
    expect(window).toEqual([
      { index: 0, address: 'TGW3g56Q5PvpA8UangXnzX6va2MkfaRx5r' },
      { index: 1, address: 'TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ' },
      { index: 2, address: 'TVsFKn7zkDN1QnMNe1thrJUEXBGiqnu19g' },
    ]);
    expect(deriveSocialReceiveWatchWindow(IDENTITY_PUB_A_COMPRESSED, 0, 3, TESTNET)).toEqual(
      window,
    );
  });

  test('a window starting mid-range derives the correct offset', () => {
    const window = deriveSocialReceiveWatchWindow(IDENTITY_PUB_A, 2, 1, TESTNET);
    expect(window).toEqual([{ index: 2, address: 'TVsFKn7zkDN1QnMNe1thrJUEXBGiqnu19g' }]);
  });

  test('count 0 returns an empty window', () => {
    expect(deriveSocialReceiveWatchWindow(IDENTITY_PUB_A, 0, 0, TESTNET)).toEqual([]);
  });

  test('a different identity is a different set of addresses', () => {
    const other = realOxyCrypto.deriveSocialReceiveKey('bb'.repeat(32), 0).publicKey;
    const [first] = deriveSocialReceiveWatchWindow(IDENTITY_PUB_A, 0, 1, TESTNET);
    expect(deriveSocialReceiveWatchWindow(other, 0, 1, TESTNET)[0]!.address).not.toBe(
      first!.address,
    );
  });
});

describe('signSocialReceiveInput', () => {
  const [{ address: SOCIAL_ADDR_1 }] = deriveSocialReceiveWatchWindow(
    IDENTITY_PUB_A,
    1,
    1,
    TESTNET,
  );
  const scriptPubKey = createP2PKHScript(decodeAddress(SOCIAL_ADDR_1!).hash);
  const tx = buildTransaction({
    utxos: [{ txid: '11'.repeat(32), vout: 0, value: 1_000_000n, scriptPubKey }],
    recipients: [{ address: 'TGW3g56Q5PvpA8UangXnzX6va2MkfaRx5r', value: 400_000n }],
    changeAddress: 'TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ',
    feePerByte: 10n,
    network: TESTNET,
  });

  test('is byte-identical to signing locally with the child key', async () => {
    holderKey = IDENTITY_KEY_A;
    const remote = await signSocialReceiveInput(tx, 0, scriptPubKey, 1, SOCIAL_ADDR_1!, TESTNET);
    const childKey = deriveSocialReceiveSpendingKey(hexToBytes(IDENTITY_KEY_A), 1);
    expect(remote).toEqual(signInput(tx, 0, scriptPubKey, childKey));
    // The holder was asked for child 1 over the input's sighash, never for a key.
    expect(signSocialReceive).toHaveBeenLastCalledWith(1, expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  test('throws when no identity holder answers', async () => {
    holderKey = null;
    await expect(
      signSocialReceiveInput(tx, 0, scriptPubKey, 1, SOCIAL_ADDR_1!, TESTNET),
    ).rejects.toThrow(/without the Oxy identity/);
    holderKey = IDENTITY_KEY_A;
  });

  test('refuses a signature from a key that does not own the address', async () => {
    holderKey = 'bb'.repeat(32);
    await expect(
      signSocialReceiveInput(tx, 0, scriptPubKey, 1, SOCIAL_ADDR_1!, TESTNET),
    ).rejects.toThrow(/does not own/);
    holderKey = IDENTITY_KEY_A;
  });
});

describe('computeWindowExtension', () => {
  test('no extension needed when the watched window already covers the gap limit', () => {
    // Nothing used yet (highestUsedIndex -1), window already covers 0..19.
    expect(computeWindowExtension(19, -1, 20)).toBeNull();
  });

  test('extends when the highest used index approaches the edge of the watched window', () => {
    // Used up to index 5, watched only up to 19 -> target = 5 + 20 = 25, extend 20..25.
    const extension = computeWindowExtension(19, 5, 20);
    expect(extension).toEqual({ start: 20, count: 6 });
  });

  test('extends from an empty window (first boot)', () => {
    const extension = computeWindowExtension(-1, -1, 20);
    expect(extension).toEqual({ start: 0, count: 20 });
  });

  test('extends by exactly the amount needed to restore the full gap limit', () => {
    // Used index 0 immediately after a 20-wide initial window (0..19):
    // target = 0 + 20 = 20, watched already covers up to 19 -> extend by 1 (index 20).
    const extension = computeWindowExtension(19, 0, 20);
    expect(extension).toEqual({ start: 20, count: 1 });
  });
});
