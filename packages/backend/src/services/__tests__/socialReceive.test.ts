import { test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { must } from '../../__tests__/helpers/must';
import { testIdentityPublicKey } from '../../__tests__/setup/identityKeys';
import type { DidDocument } from '@oxy.so/contracts';
import {
  resetGatewayTables,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

const IDENTITY_PUB_A_UNCOMPRESSED_HEX =
  '046a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb336b6fbcb60b5b3d4f1551ac45e5ffc4936466e7d98f6c7c0ec736539f74691a6';

function didWithKey(userId: string, publicKeyHex: string | null): DidDocument {
  return {
    '@context': [],
    id: `did:web:oxy.so:u:${userId}`,
    controller: [],
    verificationMethod: publicKeyHex
      ? [
          {
            id: `did:web:oxy.so:u:${userId}#key-1`,
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: `did:web:oxy.so:u:${userId}`,
            publicKeyHex,
          },
        ]
      : [],
    authentication: [],
    assertionMethod: [],
    alsoKnownAs: [],
    service: [],
  };
}

const resolveDidMock = mock(async (userId: string) =>
  didWithKey(userId, IDENTITY_PUB_A_UNCOMPRESSED_HEX),
);

/** Every DID request the gateway made: its URL and its init. */
const didRequests: { url: string; init: RequestInit }[] = [];

const {
  resolveIdentityPublicKey,
  resolveIdentityPublicKeyHex,
  reserveNextSocialAddress,
  getReservedThrough,
  IdentityDocumentUnavailableError,
  SOCIAL_RECEIVE_FIRST_FRESH_INDEX,
  useDidTransport,
  useIdentityKeyResolver,
} = await import('../socialReceive');

// This suite is about the DID read itself: not the preloaded test keys. The
// transport is the seam (Oxy's own fetch in production); the gateway's request
// and its parsing are real.
const previousResolver = useIdentityKeyResolver(null);
const previousTransport = useDidTransport(async (url, init) => {
  didRequests.push({ url, init });
  const userId = decodeURIComponent(must(must(/\/u\/([^/]+)\/did\.json$/.exec(url))[1]));
  return Response.json(await resolveDidMock(userId));
});
afterAll(() => {
  useIdentityKeyResolver(previousResolver);
  useDidTransport(previousTransport);
});

useGatewayDatabase();

beforeEach(async () => {
  await resetGatewayTables();
  resolveDidMock.mockClear();
  didRequests.length = 0;
  resolveDidMock.mockImplementation(async (userId: string) =>
    didWithKey(userId, IDENTITY_PUB_A_UNCOMPRESSED_HEX),
  );
});

test('SOCIAL_RECEIVE_FIRST_FRESH_INDEX is 1', () => {
  expect(SOCIAL_RECEIVE_FIRST_FRESH_INDEX).toBe(1);
});

test('resolveIdentityPublicKey returns the decoded secp256k1 key for a self-sovereign user', async () => {
  const key = await resolveIdentityPublicKey('user_a');
  expect(key).not.toBeNull();
});

test('resolveIdentityPublicKey returns null for a keyless (custodial) user', async () => {
  resolveDidMock.mockImplementationOnce(async (userId: string) => didWithKey(userId, null));
  const key = await resolveIdentityPublicKey('user_keyless');
  expect(key).toBeNull();
});

// A document can list more than one identity key — a linked device adds one.
// The account's own key is `#key-1`, and it is chosen BY NAME: picking
// whichever came first meant the address a payer derives could belong to a key
// the recipient's device does not hold, decided by list order.
test("resolveIdentityPublicKey takes the account's own #key-1, not whichever key is listed first", async () => {
  resolveDidMock.mockImplementationOnce(async (userId: string) => {
    const doc = didWithKey(userId, IDENTITY_PUB_A_UNCOMPRESSED_HEX);
    const accountKey = must(doc.verificationMethod[0]);
    return {
      ...doc,
      verificationMethod: [
        { ...accountKey, id: `did:web:oxy.so:u:${userId}#device-7` },
        accountKey,
      ],
    };
  });

  const key = await resolveIdentityPublicKey('user_two_keys');

  expect(key).not.toBeNull();
  // Same bytes as the account key, which is the one the recipient's device holds.
  expect(Buffer.from(must(key)).toString('hex')).toBe(IDENTITY_PUB_A_UNCOMPRESSED_HEX);
});

test('resolveIdentityPublicKey returns null when the document lists no account key', async () => {
  resolveDidMock.mockImplementationOnce(async (userId: string) => {
    const doc = didWithKey(userId, IDENTITY_PUB_A_UNCOMPRESSED_HEX);
    return {
      ...doc,
      verificationMethod: [
        { ...must(doc.verificationMethod[0]), id: `did:web:oxy.so:u:${userId}#device-7` },
      ],
    };
  });

  expect(await resolveIdentityPublicKey('user_device_key_only')).toBeNull();
});

test('the cursor records the identity key its addresses came from', async () => {
  await reserveNextSocialAddress('user_key_recorded', 'testnet');

  const cursor = await getReservedThrough('user_key_recorded', 'testnet');

  expect(cursor.reservedThrough).toBe(1);
  expect(cursor.identityPublicKey).toBe(IDENTITY_PUB_A_UNCOMPRESSED_HEX);
});

test('reserveNextSocialAddress claims index 1, 2, 3 in order with distinct addresses (index 0 never handed out)', async () => {
  const first = await reserveNextSocialAddress('user_a', 'testnet');
  const second = await reserveNextSocialAddress('user_a', 'testnet');
  const third = await reserveNextSocialAddress('user_a', 'testnet');

  expect(first).toEqual({
    index: 1,
    address: 'TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ',
    identityPublicKey: IDENTITY_PUB_A_UNCOMPRESSED_HEX,
  });
  expect(second).toEqual({
    index: 2,
    address: 'TVsFKn7zkDN1QnMNe1thrJUEXBGiqnu19g',
    identityPublicKey: IDENTITY_PUB_A_UNCOMPRESSED_HEX,
  });
  expect(third?.index).toBe(3);

  const addresses = new Set([first?.address, second?.address, third?.address]);
  expect(addresses.size).toBe(3);
});

test('reserveNextSocialAddress returns null for a keyless recipient (spec §4.5 invite path)', async () => {
  resolveDidMock.mockImplementationOnce(async (userId: string) => didWithKey(userId, null));
  const result = await reserveNextSocialAddress('user_keyless', 'testnet');
  expect(result).toBeNull();
});

test('concurrent first-time reservations for the same user never collide on an index', async () => {
  const [a, b, c] = await Promise.all([
    reserveNextSocialAddress('user_concurrent', 'testnet'),
    reserveNextSocialAddress('user_concurrent', 'testnet'),
    reserveNextSocialAddress('user_concurrent', 'testnet'),
  ]);
  const indexes = [a?.index, b?.index, c?.index];
  expect(new Set(indexes).size).toBe(3);
  expect(indexes.every((i) => typeof i === 'number' && i >= 1)).toBe(true);
});

test('getReservedThrough returns 0 for a user with no cursor yet', async () => {
  expect((await getReservedThrough('user_no_cursor', 'testnet')).reservedThrough).toBe(0);
});

test('getReservedThrough tracks the highest index reserveNextSocialAddress has EVER handed out, without reserving another one', async () => {
  await reserveNextSocialAddress('user_b', 'testnet');
  await reserveNextSocialAddress('user_b', 'testnet');

  expect((await getReservedThrough('user_b', 'testnet')).reservedThrough).toBe(2);
  // Read-only — calling it again does not advance the cursor.
  expect((await getReservedThrough('user_b', 'testnet')).reservedThrough).toBe(2);

  await reserveNextSocialAddress('user_b', 'testnet');
  expect((await getReservedThrough('user_b', 'testnet')).reservedThrough).toBe(3);
});

test('getReservedThrough is scoped per network', async () => {
  await reserveNextSocialAddress('user_c', 'testnet');
  expect((await getReservedThrough('user_c', 'testnet')).reservedThrough).toBe(1);
  expect((await getReservedThrough('user_c', 'mainnet')).reservedThrough).toBe(0);
});

// F6 (ADR 0002, amended 2026-11-06): the SDK's `resolveDid` caches the
// document for a minute, so a reservation right after a rotation derived from
// the replaced key and wrote it back onto the cursor. Every read is fresh now.
test('every key read asks Oxy again — no cached document, no-store', async () => {
  await resolveIdentityPublicKey('user_fresh');
  await resolveIdentityPublicKey('user_fresh');

  expect(didRequests).toHaveLength(2);
  const request = must(didRequests[0]);
  expect(request.url.endsWith('/u/user_fresh/did.json')).toBe(true);
  expect(request.init.cache).toBe('no-store');
  expect(new Headers(request.init.headers).get('cache-control')).toBe('no-cache');
});

test('a rotation between two reservations: the second derives from, and records, the new key', async () => {
  const rotated = Buffer.from(testIdentityPublicKey('user_rotating:after')).toString('hex');
  const before = must(await reserveNextSocialAddress('user_rotating', 'testnet'));
  resolveDidMock.mockImplementation(async (userId: string) => didWithKey(userId, rotated));
  const after = must(await reserveNextSocialAddress('user_rotating', 'testnet'));

  expect(before.identityPublicKey).toBe(IDENTITY_PUB_A_UNCOMPRESSED_HEX);
  expect(after.identityPublicKey).toBe(rotated);
  expect(after.address).not.toBe(before.address);
  expect((await getReservedThrough('user_rotating', 'testnet')).identityPublicKey).toBe(rotated);
});

test('the key is answered as lowercase hex, the spelling every recorded key uses', async () => {
  resolveDidMock.mockImplementationOnce(async (userId: string) =>
    didWithKey(userId, IDENTITY_PUB_A_UNCOMPRESSED_HEX.toUpperCase()),
  );
  expect(await resolveIdentityPublicKeyHex('user_upper')).toBe(IDENTITY_PUB_A_UNCOMPRESSED_HEX);
});

test('Oxy not answering is an error, never "keyless"', async () => {
  const previous = useDidTransport(async () => new Response('busy', { status: 503 }));
  try {
    await expect(resolveIdentityPublicKey('user_outage')).rejects.toBeInstanceOf(
      IdentityDocumentUnavailableError,
    );
  } finally {
    useDidTransport(previous);
  }
});
