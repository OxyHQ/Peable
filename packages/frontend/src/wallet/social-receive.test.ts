import { describe, test, expect, mock } from 'bun:test';
import { getPublicKey } from '@noble/secp256k1';
import {
  buildTransaction,
  bytesToHex,
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
// An organization's key (oxy ADR 0061), held apart from the person's: the fake
// holder answers `{ accountId }` requests only from this one.
const ORG_ID = '0123456789abcdef01234567';
const ORG_KEY = 'cc'.repeat(32);
const ORG_PUB = bytesToHex(getPublicKey(hexToBytes(ORG_KEY), false));
let orgHolderKey: string | null = ORG_KEY;
let orgPublicKeyResult: string | null = null;
const getSharedPublicKey = mock(async () => sharedPublicKeyResult);
const getOrganizationPublicKey = mock(async (_accountId: string) => orgPublicKeyResult);
const signSocialReceive = mock(
  async (index: number, digest: string, opts?: { accountId?: string }) => {
    if (opts?.accountId !== undefined) {
      return opts.accountId === ORG_ID && orgHolderKey
        ? realOxyCrypto.signSocialReceiveDigest(orgHolderKey, index, digest)
        : null;
    }
    return holderKey ? realOxyCrypto.signSocialReceiveDigest(holderKey, index, digest) : null;
  },
);
mock.module('@oxy.so/core/crypto', () => ({
  ...realOxyCrypto,
  getOrganizationPublicKey,
  KeyManager: { getSharedPublicKey, signSocialReceive },
}));

const {
  compressedPublicKeyHex,
  readDeviceKeyHint,
  deriveSocialReceiveWatchWindow,
  signSocialReceiveInput,
  highestIndex,
  judgeSocialReceiveKey,
  accountKeyFromDidDocument,
} = await import('./social-receive');

const TESTNET = getNetwork('testnet');

const PERSON = { kind: 'personal', accountId: '76543210fedcba9876543210' } as const;

describe('readDeviceKeyHint (an UNTRUSTED hint, R5-1)', () => {
  test("is the shared identity's public key, compressed", async () => {
    sharedPublicKeyResult = IDENTITY_PUB_A;
    expect(await readDeviceKeyHint(PERSON)).toBe(IDENTITY_PUB_A_COMPRESSED);
  });

  test('is null when no identity holder answers (web, keyless, Commons absent)', async () => {
    sharedPublicKeyResult = null;
    expect(await readDeviceKeyHint(PERSON)).toBeNull();
    sharedPublicKeyResult = IDENTITY_PUB_A;
  });

  test("for an organization, is the ORGANIZATION's key this phone reaches", async () => {
    orgPublicKeyResult = ORG_PUB;
    const subject = { kind: 'organization', accountId: ORG_ID } as const;
    expect(await readDeviceKeyHint(subject)).toBe(compressedPublicKeyHex(ORG_PUB));
    expect(getOrganizationPublicKey).toHaveBeenLastCalledWith(ORG_ID);
  });

  test("for an organization this phone cannot reach, is null — never the person's key", async () => {
    orgPublicKeyResult = null;
    sharedPublicKeyResult = IDENTITY_PUB_A;
    const subject = { kind: 'organization', accountId: ORG_ID } as const;
    expect(await readDeviceKeyHint(subject)).toBeNull();
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
    const other = bytesToHex(getPublicKey(hexToBytes('bb'.repeat(32)), false));
    const [first] = deriveSocialReceiveWatchWindow(IDENTITY_PUB_A, 0, 1, TESTNET);
    const [second] = deriveSocialReceiveWatchWindow(other, 0, 1, TESTNET);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.address).not.toBe(first?.address);
  });
});

describe('signSocialReceiveInput', () => {
  const [slot1] = deriveSocialReceiveWatchWindow(IDENTITY_PUB_A, 1, 1, TESTNET);
  if (!slot1) throw new Error('expected one derived social receive address');
  const SOCIAL_ADDR_1 = slot1.address;
  const scriptPubKey = createP2PKHScript(decodeAddress(SOCIAL_ADDR_1).hash);
  const tx = buildTransaction({
    utxos: [{ txid: '11'.repeat(32), vout: 0, value: 1_000_000n, scriptPubKey }],
    recipients: [{ address: 'TGW3g56Q5PvpA8UangXnzX6va2MkfaRx5r', value: 400_000n }],
    changeAddress: 'TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ',
    feePerByte: 10n,
    network: TESTNET,
  });

  test('is byte-identical to signing locally with the child key', async () => {
    holderKey = IDENTITY_KEY_A;
    const remote = await signSocialReceiveInput(
      tx,
      0,
      scriptPubKey,
      1,
      SOCIAL_ADDR_1,
      TESTNET,
      PERSON,
    );
    const childKey = deriveSocialReceiveSpendingKey(hexToBytes(IDENTITY_KEY_A), 1);
    expect(remote).toEqual(signInput(tx, 0, scriptPubKey, childKey));
    // The holder was asked for child 1 over the input's sighash, never for a key.
    expect(signSocialReceive).toHaveBeenLastCalledWith(1, expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  test('throws when no identity holder answers', async () => {
    holderKey = null;
    await expect(
      signSocialReceiveInput(tx, 0, scriptPubKey, 1, SOCIAL_ADDR_1, TESTNET, PERSON),
    ).rejects.toThrow(/without the Oxy identity/);
    holderKey = IDENTITY_KEY_A;
  });

  test("an organization's address is signed by the organization's key, asked by accountId", async () => {
    const subject = { kind: 'organization', accountId: ORG_ID } as const;
    const [orgSlot] = deriveSocialReceiveWatchWindow(ORG_PUB, 1, 1, TESTNET);
    if (!orgSlot) throw new Error('expected one derived organization address');
    const orgScript = createP2PKHScript(decodeAddress(orgSlot.address).hash);
    const orgTx = buildTransaction({
      utxos: [{ txid: '22'.repeat(32), vout: 0, value: 1_000_000n, scriptPubKey: orgScript }],
      recipients: [{ address: SOCIAL_ADDR_1, value: 400_000n }],
      changeAddress: orgSlot.address,
      feePerByte: 10n,
      network: TESTNET,
    });
    const remote = await signSocialReceiveInput(
      orgTx,
      0,
      orgScript,
      1,
      orgSlot.address,
      TESTNET,
      subject,
    );
    const childKey = deriveSocialReceiveSpendingKey(hexToBytes(ORG_KEY), 1);
    expect(remote).toEqual(signInput(orgTx, 0, orgScript, childKey));
    expect(signSocialReceive).toHaveBeenLastCalledWith(1, expect.stringMatching(/^[0-9a-f]{64}$/), {
      accountId: ORG_ID,
    });

    // A phone without the organization key cannot sign, even though the
    // person's own key is right there.
    orgHolderKey = null;
    await expect(
      signSocialReceiveInput(orgTx, 0, orgScript, 1, orgSlot.address, TESTNET, subject),
    ).rejects.toThrow(/without the Oxy identity/);
    orgHolderKey = ORG_KEY;
  });

  test('refuses a signature from a key that does not own the address', async () => {
    holderKey = 'bb'.repeat(32);
    await expect(
      signSocialReceiveInput(tx, 0, scriptPubKey, 1, SOCIAL_ADDR_1, TESTNET, PERSON),
    ).rejects.toThrow(/does not own/);
    holderKey = IDENTITY_KEY_A;
  });
});

describe('highestIndex', () => {
  test('is -1 for nothing', () => {
    expect(highestIndex([])).toBe(-1);
    expect(highestIndex(new Map<string, number>().values())).toBe(-1);
  });

  // `Math.max(-1, ...values)` threw RangeError here: the spread passes every
  // entry as an argument, and the stack runs out (V8 100k-200k, Hermes lower).
  test('handles a window of millions without overflowing the stack', () => {
    const big = new Map<string, number>();
    for (let i = 0; i < 1_000_000; i++) big.set(`a${String(i)}`, i);
    expect(highestIndex(big.values())).toBe(999_999);
  });
});

describe('judgeSocialReceiveKey', () => {
  const OTHER_PUB = bytesToHex(getPublicKey(hexToBytes('dd'.repeat(32)), false));

  test("matches the account's published key, whatever its encoding", () => {
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: IDENTITY_PUB_A,
        lastReservedKey: null,
      }),
    ).toBe('match');
  });

  // F7: a rotation done on another device. The cursor's LAST reservation used
  // key A, the account now publishes B, and this phone still holds A: the next
  // reservation derives from B, so this phone must stop offering @username.
  test('the PUBLISHED key decides, not the key the last reservation used', () => {
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: OTHER_PUB,
        lastReservedKey: IDENTITY_PUB_A,
      }),
    ).toBe('mismatch');
    // And the reverse: this phone holds the NEW key; the last reservation was
    // under the old one. New reservations derive from this phone's key.
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: IDENTITY_PUB_A,
        lastReservedKey: OTHER_PUB,
      }),
    ).toBe('match');
  });

  test('an account that publishes no key is not this device', () => {
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: null,
        lastReservedKey: null,
      }),
    ).toBe('mismatch');
  });

  test('a published key that does not parse is not this device', () => {
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: 'not-a-key',
        lastReservedKey: null,
      }),
    ).toBe('mismatch');
  });

  test('without the published key, falls back to the last reservation (older gateway)', () => {
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: undefined,
        lastReservedKey: OTHER_PUB,
      }),
    ).toBe('mismatch');
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: undefined,
        lastReservedKey: IDENTITY_PUB_A,
      }),
    ).toBe('unverified');
    expect(
      judgeSocialReceiveKey({
        deviceKey: IDENTITY_PUB_A_COMPRESSED,
        accountKey: undefined,
        lastReservedKey: null,
      }),
    ).toBe('unverified');
  });
});

describe('accountKeyFromDidDocument', () => {
  const method = (
    id: string,
    publicKeyHex: string,
    type = 'EcdsaSecp256k1VerificationKey2019',
  ) => ({
    id,
    type,
    controller: 'did:oxy:x',
    publicKeyHex,
  });

  test('takes #key-1 by NAME, not the first secp256k1 method listed', () => {
    expect(
      accountKeyFromDidDocument({
        verificationMethod: [method('did:oxy:x#key-2', 'bb'), method('did:oxy:x#key-1', 'aa')],
      }),
    ).toBe('aa');
  });

  test('is null for a keyless account', () => {
    expect(accountKeyFromDidDocument({ verificationMethod: [] })).toBeNull();
    expect(accountKeyFromDidDocument({})).toBeNull();
    expect(
      accountKeyFromDidDocument({
        verificationMethod: [method('did:oxy:x#key-1', 'aa', 'Ed25519VerificationKey2020')],
      }),
    ).toBeNull();
  });
});
