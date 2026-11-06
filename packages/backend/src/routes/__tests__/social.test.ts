import { test, expect, beforeAll, afterAll, beforeEach, describe, mock } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { User } from '@oxy.so/core';
import { oxy as realOxy } from '../../oxy';
import { overrideOxy } from '../../__tests__/helpers/oxyOverrides';
import type { DidDocument } from '@oxy.so/contracts';
import {
  SOCIAL_SOURCE_APP_MAX_LENGTH,
  SOCIAL_SOURCE_REF_MAX_LENGTH,
} from '@peable.to/shared-types';
import { socialReceiveCursors, socialSendAttributions } from '../../db/schema';
import { must } from '../../__tests__/helpers/must';
import { useAddressUsageReader } from '../../services/faircoin/addressPool';
import {
  gatewayDb,
  resetGatewayTables,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

const IDENTITY_PUB_A_UNCOMPRESSED_HEX =
  '046a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb336b6fbcb60b5b3d4f1551ac45e5ffc4936466e7d98f6c7c0ec736539f74691a6';

const PROFILES: Record<string, { id: string; username: string }> = {
  alice: { id: 'user_alice', username: 'alice' },
  keylessbob: { id: 'user_keylessbob', username: 'keylessbob' },
};

function didFor(userId: string): DidDocument {
  const hasKey = userId !== 'user_keylessbob';
  return {
    '@context': [],
    id: `did:web:oxy.so:u:${userId}`,
    controller: [],
    verificationMethod: hasKey
      ? [
          {
            id: `did:web:oxy.so:u:${userId}#key-1`,
            type: 'EcdsaSecp256k1VerificationKey2019',
            controller: `did:web:oxy.so:u:${userId}`,
            publicKeyHex: IDENTITY_PUB_A_UNCOMPRESSED_HEX,
          },
        ]
      : [],
    authentication: [],
    assertionMethod: [],
    alsoKnownAs: [],
    service: [],
  };
}

/**
 * `PROFILES` is a `Record<string, ...>`, so indexing it yields `| undefined`.
 * Tests that need a fixture by name want a hard failure on a typo, not an
 * optional chain that quietly asserts nothing.
 */
function testProfile(key: string): { id: string; username: string } {
  const found = PROFILES[key];
  if (!found) throw new Error(`unknown test profile: ${key}`);
  return found;
}

const getProfileByUsernameMock = mock(async (username: string) => {
  // Simulates a real oxy-api outage/timeout — no `.status` on the error, the
  // same shape a network failure produces. Must NOT be treated as a 404.
  if (username === 'flaky') {
    throw new Error('network timeout');
  }
  // `r1`, `r2`, …: as many distinct recipients as a test needs.
  if (/^r\d+$/.test(username)) return { id: `user_${username}`, username } as unknown as User;
  const profile = PROFILES[username];
  if (!profile) {
    // Real `getProfileByUsername` 404s carry `.status` (set by
    // `OxyServices.base.ts`'s `handleError`) — mirror that shape so
    // `isNotFoundError` in the route under test exercises the real check.
    const err = new Error('not found') as Error & { status: number };
    err.status = 404;
    throw err;
  }
  return profile as unknown as User;
});
const resolveDidMock = mock(async (userId: string) => didFor(userId));
// `enrichAddresses` resolves counterparty identity through this one.
const getUsersByIdsMock = mock(
  async (ids: string[]) =>
    ids
      .map((id) => Object.values(PROFILES).find((p) => p.id === id))
      .filter((p): p is { id: string; username: string } => p !== undefined)
      .map((p) => ({
        id: p.id,
        username: p.username,
        name: { displayName: p.username.toUpperCase() },
        avatar: null,
      })) as unknown as User[],
);

// `mock.module` is process-wide in bun: only the methods this file needs are
// replaced; the rest of `oxy` (its middleware included) stays real.
mock.module('../../oxy', () => ({
  oxy: overrideOxy(realOxy, {
    users: { byUsername: getProfileByUsernameMock, getMany: getUsersByIdsMock },
  }),
}));

const { createSocialRouter, NEXT_ADDRESS_PAIR_MAX, NEXT_ADDRESS_SENDER_MAX } = await import(
  '../social'
);
const { useDidTransport, useIdentityKeyResolver, useMaxFreshSocialAddresses } = await import(
  '../../services/socialReceive'
);

// This suite serves the DID document itself (the gateway reads it fresh,
// through its transport): not the preloaded test keys.
const previousResolver = useIdentityKeyResolver(null);
const previousTransport = useDidTransport(async (url) => {
  const userId = decodeURIComponent(must(must(/\/u\/([^/]+)\/did\.json$/.exec(url))[1]));
  return Response.json(await resolveDidMock(userId));
});
afterAll(() => {
  useIdentityKeyResolver(previousResolver);
  useDidTransport(previousTransport);
});

const TEST_SENDER_ID = 'user_test_sender';
// Honors an `X-Test-User-Id` override so individual tests can authenticate as
// a caller OTHER than the default sender — needed both for `GET
// /v1/social/me/cursor` (authenticated as the RECIPIENT, not the sender) and
// for the per-(sender,recipient) rate-limit tests (a fresh sender id per
// test keeps them independent of the shared in-memory limiter state, which
// — unlike the database tables — `beforeEach` below does not reset).
const stubRequireOxyUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = req.header('X-Test-User-Id') ?? TEST_SENDER_ID;
  next();
};

let server: Server;
let baseUrl: string;

interface NextAddressResponse {
  address?: string;
  index?: number;
  error?: { type: string; code?: string; message: string };
}

interface CursorResponse {
  reserved_through?: number;
  identity_public_key?: string | null;
  account_identity_public_key?: string | null;
  error?: { type: string; message: string };
}

async function postNextAddress(
  username: string,
  body: Record<string, unknown>,
  senderId?: string,
): Promise<{ status: number; body: NextAddressResponse }> {
  const res = await fetch(`${baseUrl}/v1/social/${username}/next_address`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(senderId ? { 'X-Test-User-Id': senderId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as NextAddressResponse };
}

async function getCursor(
  network: string | undefined,
  userId: string,
): Promise<{ status: number; body: CursorResponse }> {
  const query = network ? `?network=${network}` : '';
  const res = await fetch(`${baseUrl}/v1/social/me/cursor${query}`, {
    headers: { 'X-Test-User-Id': userId },
  });
  return { status: res.status, body: (await res.json()) as CursorResponse };
}

useGatewayDatabase();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createSocialRouter({ requireOxyUser: stubRequireOxyUser }));

  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await resetGatewayTables();
});

describe('POST /v1/social/:username/next_address', () => {
  test('reserves a fresh address and records the attribution', async () => {
    const { status, body } = await postNextAddress('alice', { network: 'testnet' });

    expect(status).toBe(200);
    expect(body.index).toBe(1);
    expect(body.address).toBe('TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ');

    // `findAttributionsForViewer` is the only repository read over this table
    // and it scopes to a viewer, which this assertion deliberately does not —
    // so the address lookup goes through drizzle directly. The stored column is
    // `derivation_index`.
    const [attribution] = await gatewayDb()
      .select()
      .from(socialSendAttributions)
      .where(eq(socialSendAttributions.address, body.address ?? ''));
    expect(attribution?.senderUserId).toBe(TEST_SENDER_ID);
    expect(attribution?.recipientUserId).toBe('user_alice');
    expect(attribution?.derivationIndex).toBe(1);
    // The key the address was derived from, recorded with it (ADR 0002, amended 2026-11-06).
    expect(attribution?.identityPublicKey).toBe(IDENTITY_PUB_A_UNCOMPRESSED_HEX);
  });

  test('second call for the same recipient reserves the next index', async () => {
    await postNextAddress('alice', { network: 'testnet' });
    const { body } = await postNextAddress('alice', { network: 'testnet' });
    expect(body.index).toBe(2);
  });

  test('a sender asking again before paying is handed the address it holds (ADR 0021 D9)', async () => {
    const previous = useAddressUsageReader(async () => 'unused');
    try {
      const first = await postNextAddress('alice', { network: 'testnet' }, 'user_repeat_sender');
      const again = await postNextAddress(
        'alice',
        { network: 'testnet', source: { app: 'mention', ref: 'post_later' } },
        'user_repeat_sender',
      );
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      // One row, now saying what the next payment to it is for.
      const rows = await gatewayDb()
        .select()
        .from(socialSendAttributions)
        .where(eq(socialSendAttributions.senderUserId, 'user_repeat_sender'));
      expect(rows.map((row) => [row.derivationIndex, row.sourceApp, row.sourceRef])).toEqual([
        [1, 'mention', 'post_later'],
      ]);
      // Another sender is not handed it.
      const other = await postNextAddress('alice', { network: 'testnet' }, 'user_other_sender');
      expect(other.body.index).toBe(2);
    } finally {
      useAddressUsageReader(previous);
    }
  });

  test('once the chain shows the address paid, the sender gets a fresh one', async () => {
    const previous = useAddressUsageReader(async () => 'used');
    try {
      await postNextAddress('alice', { network: 'testnet' }, 'user_paid_sender');
      const next = await postNextAddress('alice', { network: 'testnet' }, 'user_paid_sender');
      expect(next.body.index).toBe(2);
    } finally {
      useAddressUsageReader(previous);
    }
  });

  test('404s for an unknown username', async () => {
    const { status, body } = await postNextAddress('nobody', { network: 'testnet' });
    expect(status).toBe(404);
    expect(body.error?.type).toBe('invalid_request_error');
  });

  test('hands out indices past the old 1 980 ceiling: nothing caps a recipient (ADR 0021 D9)', async () => {
    await postNextAddress('alice', { network: 'testnet' }, 'user_tree_sender_1');
    await gatewayDb()
      .update(socialReceiveCursors)
      .set({ nextDerivationIndex: 1_985 })
      .where(eq(socialReceiveCursors.oxyUserId, 'user_alice'));
    const next = await postNextAddress('alice', { network: 'testnet' }, 'user_tree_sender_2');
    expect(next.status).toBe(200);
    expect(next.body.index).toBe(1_985);
  });

  test("503s faircoin_capacity_reached once the recipient's daily fresh @username bound is reached, reserving nothing", async () => {
    const previous = useMaxFreshSocialAddresses(2);
    // The chain shows every address unused, so a sender asking again is handed its own.
    const previousReader = useAddressUsageReader(async () => 'unused');
    try {
      expect((await postNextAddress('alice', { network: 'testnet' }, 'user_day_1')).status).toBe(
        200,
      );
      expect((await postNextAddress('alice', { network: 'testnet' }, 'user_day_2')).status).toBe(
        200,
      );
      const { status, body } = await postNextAddress('alice', { network: 'testnet' }, 'user_day_3');
      // Not 409: that status alone means a keyless recipient to the wallet.
      expect(status).toBe(503);
      expect(body.error?.type).toBe('api_error');
      expect(body.error?.code).toBe('faircoin_capacity_reached');
      expect(body.address).toBeUndefined();
      const attributions = await gatewayDb()
        .select()
        .from(socialSendAttributions)
        .where(eq(socialSendAttributions.senderUserId, 'user_day_3'));
      expect(attributions).toEqual([]);
      // Nothing was reserved: the next fresh address, another day, is index 3.
      const [cursor] = await gatewayDb()
        .select({ next: socialReceiveCursors.nextDerivationIndex })
        .from(socialReceiveCursors)
        .where(eq(socialReceiveCursors.oxyUserId, 'user_alice'));
      expect(cursor?.next).toBe(3);
      // A sender that already holds an address is still handed it.
      const again = await postNextAddress('alice', { network: 'testnet' }, 'user_day_1');
      expect(again.status).toBe(200);
      expect(again.body.index).toBe(1);
    } finally {
      useMaxFreshSocialAddresses(previous);
      useAddressUsageReader(previousReader);
    }
  });

  test('concurrent asks of one sender hand it ONE fresh address, re-read under the recipient lock', async () => {
    // The chain shows the held address unused, so an ask after the first one
    // committed is handed it back; asks that raced the first one past that
    // read are answered under the lock with the address it just got.
    const previous = useAddressUsageReader(async () => 'unused');
    try {
      const asks = await Promise.all(
        Array.from({ length: 4 }, () =>
          postNextAddress('alice', { network: 'testnet' }, 'user_concurrent_sender'),
        ),
      );
      for (const ask of asks) expect(ask.status).toBe(200);
      expect(new Set(asks.map((ask) => ask.body.address)).size).toBe(1);
      const rows = await gatewayDb()
        .select()
        .from(socialSendAttributions)
        .where(eq(socialSendAttributions.senderUserId, 'user_concurrent_sender'));
      expect(rows).toHaveLength(1);
    } finally {
      useAddressUsageReader(previous);
    }
  });

  test(`a sender is handed at most ${NEXT_ADDRESS_SENDER_MAX} fresh addresses an hour, across recipients`, async () => {
    const sender = 'user_sender_hourly';
    const previous = useAddressUsageReader(async () => 'unused');
    try {
      for (let i = 1; i <= NEXT_ADDRESS_SENDER_MAX; i += 1) {
        const { status } = await postNextAddress(`r${i}`, { network: 'testnet' }, sender);
        expect(status).toBe(200);
      }
      const { status, body } = await postNextAddress(
        `r${NEXT_ADDRESS_SENDER_MAX + 1}`,
        { network: 'testnet' },
        sender,
      );
      expect(status).toBe(429);
      expect(body.error?.type).toBe('rate_limit_error');
      // Asking again for an address it holds is not a fresh one.
      const held = await postNextAddress('r1', { network: 'testnet' }, sender);
      expect(held.status).toBe(200);
      expect(held.body.index).toBe(1);
    } finally {
      useAddressUsageReader(previous);
    }
  });

  test('409s with code keyless_recipient for a keyless recipient', async () => {
    const { status, body } = await postNextAddress('keylessbob', { network: 'testnet' });
    expect(status).toBe(409);
    expect(body.error?.type).toBe('invalid_request_error');
    expect(body.error?.code).toBe('keyless_recipient');
  });

  // The wallet refuses mainnet for pay-by-@username, but the wallet is not the
  // only client a bearer token can drive. The deployment decides, and it says so
  // here rather than trusting whoever is calling.
  test('403s on a network this deployment has not enabled for social pay', async () => {
    const { status, body } = await postNextAddress('alice', { network: 'mainnet' });

    expect(status).toBe(403);
    expect(body.error?.message).toContain('mainnet');
  });

  test('400s on a malformed network field', async () => {
    const { status, body } = await postNextAddress('alice', { network: 'regtest' });
    expect(status).toBe(400);
    expect(body.error?.type).toBe('invalid_request_error');
  });

  /**
   * "Tip a post": the payer's app says which app it is and hands over its own
   * opaque id for the thing being paid for, so the RECIPIENT can later see what
   * the payment was about.
   */
  test("records the paying app's context on the attribution", async () => {
    const { status, body } = await postNextAddress(
      'alice',
      { network: 'testnet', source: { app: 'mention', ref: 'post_abc123' } },
      'user_source_full_sender',
    );
    expect(status).toBe(200);

    const [attribution] = await gatewayDb()
      .select()
      .from(socialSendAttributions)
      .where(eq(socialSendAttributions.address, body.address ?? ''));
    // Stored verbatim: the ref is opaque to Peable, so anything other than a
    // copy would be the gateway interpreting what its users pay for.
    expect([attribution?.sourceApp, attribution?.sourceRef]).toEqual(['mention', 'post_abc123']);
  });

  test('accepts an app that names no single thing, storing a null ref', async () => {
    const { status, body } = await postNextAddress(
      'alice',
      { network: 'testnet', source: { app: 'mention' } },
      'user_source_app_only_sender',
    );
    expect(status).toBe(200);

    const [attribution] = await gatewayDb()
      .select()
      .from(socialSendAttributions)
      .where(eq(socialSendAttributions.address, body.address ?? ''));
    expect([attribution?.sourceApp, attribution?.sourceRef]).toEqual(['mention', null]);
  });

  /**
   * The context is optional and must STAY optional: a plain person-to-person
   * payment is for nothing in particular. NULL is then the honest record of
   * that, where a default would invent a context the payer never stated.
   */
  test('leaves both context columns null when the payer names none', async () => {
    const { status, body } = await postNextAddress(
      'alice',
      { network: 'testnet' },
      'user_source_absent_sender',
    );
    expect(status).toBe(200);

    const [attribution] = await gatewayDb()
      .select()
      .from(socialSendAttributions)
      .where(eq(socialSendAttributions.address, body.address ?? ''));
    expect([attribution?.sourceApp, attribution?.sourceRef]).toEqual([null, null]);
  });

  /**
   * The context is display-only and is an input to NOTHING that decides where
   * money goes. Asserted by reserving twice for the same recipient — once with
   * a source and once without — and requiring consecutive indices: a source
   * that reached the derivation would show up here as a different address or a
   * skipped index.
   */
  test('the context changes neither the index reserved nor the address derived', async () => {
    const sender = 'user_source_neutral_sender';
    const plain = await postNextAddress('alice', { network: 'testnet' }, sender);
    const sourced = await postNextAddress(
      'alice',
      { network: 'testnet', source: { app: 'mention', ref: 'post_1' } },
      sender,
    );

    expect([plain.body.index, sourced.body.index]).toEqual([1, 2]);
    expect(sourced.body.address).not.toBe(plain.body.address);
  });

  test('400s on a source.ref longer than the published bound', async () => {
    const { status, body } = await postNextAddress('alice', {
      network: 'testnet',
      source: { app: 'mention', ref: 'p'.repeat(SOCIAL_SOURCE_REF_MAX_LENGTH + 1) },
    });
    expect(status).toBe(400);
    expect(body.error?.type).toBe('invalid_request_error');
  });

  test('400s on a source.app longer than the published bound', async () => {
    const { status } = await postNextAddress('alice', {
      network: 'testnet',
      source: { app: 'm'.repeat(SOCIAL_SOURCE_APP_MAX_LENGTH + 1) },
    });
    expect(status).toBe(400);
  });

  /**
   * A ref means something only inside the app that minted it, so a ref with no
   * app names nothing anybody could resolve. Refused here as well as by
   * `social_send_attributions_source_ref_needs_app_check`, because a 400 is a
   * better answer to a caller than a 500 from a constraint.
   */
  test('400s on a source that names a ref but no app', async () => {
    const { status } = await postNextAddress('alice', {
      network: 'testnet',
      source: { ref: 'post_abc123' },
    });
    expect(status).toBe(400);
  });

  /**
   * The `.strict()` on the source object, stated as a test. Zod strips an
   * unknown key by default, so without it this exact body — the obvious
   * misspelling of `ref` — would reserve an address, record a context missing
   * the only part the recipient cares about, and answer 200.
   */
  test('400s on an unknown key inside source rather than silently dropping it', async () => {
    const { status } = await postNextAddress('alice', {
      network: 'testnet',
      source: { app: 'mention', postId: 'post_abc123' },
    });
    expect(status).toBe(400);
  });

  /**
   * `ref` is bounded to an id shape, not to prose: an opaque column nothing
   * reads is exactly where a free-text memo about two users would end up
   * unnoticed.
   */
  test('400s on a source.ref carrying whitespace-separated prose', async () => {
    const { status } = await postNextAddress('alice', {
      network: 'testnet',
      source: { app: 'mention', ref: 'thanks for the coffee yesterday' },
    });
    expect(status).toBe(400);
  });

  test('502s with type api_error (not 404) when the profile lookup fails upstream', async () => {
    const { status, body } = await postNextAddress('flaky', { network: 'testnet' });
    expect(status).toBe(502);
    expect(body.error?.type).toBe('api_error');
  });
});

describe('POST /v1/social/:username/next_address — per-(sender,recipient) anti-grief rate limit', () => {
  test(`the ${NEXT_ADDRESS_PAIR_MAX + 1}th reservation against the same recipient from the same sender is rate-limited`, async () => {
    const sender = 'user_grief_sender_a';
    for (let i = 0; i < NEXT_ADDRESS_PAIR_MAX; i++) {
      const { status } = await postNextAddress('alice', { network: 'testnet' }, sender);
      expect(status).toBe(200);
    }

    const { status, body } = await postNextAddress('alice', { network: 'testnet' }, sender);
    expect(status).toBe(429);
    expect(body.error?.type).toBe('rate_limit_error');
  });

  test('the limit is keyed per (sender, recipient) pair — a different sender against the same recipient is unaffected', async () => {
    const griefer = 'user_grief_sender_b';
    for (let i = 0; i < NEXT_ADDRESS_PAIR_MAX; i++) {
      await postNextAddress('alice', { network: 'testnet' }, griefer);
    }
    const grieferLimited = await postNextAddress('alice', { network: 'testnet' }, griefer);
    expect(grieferLimited.status).toBe(429);

    const otherSender = await postNextAddress(
      'alice',
      { network: 'testnet' },
      'user_grief_sender_c',
    );
    expect(otherSender.status).toBe(200);
  });
});

describe('GET /v1/social/me/cursor', () => {
  test('returns reserved_through: 0 for a caller with no cursor yet', async () => {
    const { status, body } = await getCursor('testnet', 'user_cursor_fresh');
    expect(status).toBe(200);
    expect(body.reserved_through).toBe(0);
  });

  test('returns the highest index ever reserved for the authenticated caller (recipient), not the sender', async () => {
    const sender = 'user_cursor_value_sender';
    await postNextAddress('alice', { network: 'testnet' }, sender);
    await postNextAddress('alice', { network: 'testnet' }, sender);

    const { status, body } = await getCursor('testnet', 'user_alice');
    expect(status).toBe(200);
    expect(body.reserved_through).toBe(2);
  });

  test('is scoped per network — a testnet reservation does not surface under mainnet', async () => {
    const sender = 'user_cursor_network_sender';
    await postNextAddress('alice', { network: 'testnet' }, sender);

    const { status, body } = await getCursor('mainnet', 'user_alice');
    expect(status).toBe(200);
    expect(body.reserved_through).toBe(0);
  });

  // F7 (ADR 0002, amended 2026-11-06): the cursor's own key says only what the
  // LAST reservation used. The device compares against the account's current
  // `#key-1`, read fresh, which the answer now carries beside it.
  test("carries the caller's CURRENT #key-1 beside the key the last reservation used", async () => {
    await postNextAddress('alice', { network: 'testnet' }, 'user_cursor_key_sender');
    const rotated = `02${'5'.repeat(64)}`;
    resolveDidMock.mockImplementation(async (userId: string) => {
      const doc = didFor(userId);
      return {
        ...doc,
        verificationMethod: doc.verificationMethod.map((vm) => ({ ...vm, publicKeyHex: rotated })),
      };
    });
    try {
      const { status, body } = await getCursor('testnet', 'user_alice');
      expect(status).toBe(200);
      expect(body.identity_public_key).toBe(IDENTITY_PUB_A_UNCOMPRESSED_HEX);
      expect(body.account_identity_public_key).toBe(rotated);
    } finally {
      resolveDidMock.mockImplementation(async (userId: string) => didFor(userId));
    }
  });

  test('answers account_identity_public_key: null for a keyless caller, even with no cursor', async () => {
    const { status, body } = await getCursor('testnet', 'user_keylessbob');
    expect(status).toBe(200);
    expect(body.identity_public_key).toBeNull();
    expect(body.account_identity_public_key).toBeNull();
  });

  test('a 503 when Oxy cannot be asked for the current key — never a guessed null', async () => {
    const previous = useDidTransport(async () => new Response('down', { status: 502 }));
    try {
      const { status } = await getCursor('testnet', 'user_alice');
      expect(status).toBe(503);
    } finally {
      useDidTransport(previous);
    }
  });

  test('400s on a missing network query param', async () => {
    const { status, body } = await getCursor(undefined, 'user_alice');
    expect(status).toBe(400);
    expect(body.error?.type).toBe('invalid_request_error');
  });
});

// --- GET /v1/social/me/payments -------------------------------------------

interface PaymentsResponse {
  payments?: {
    address: string;
    direction: 'sent' | 'received';
    // `EnrichmentResult`: never null, degrades to `{ kind: 'unknown' }`.
    counterparty: { kind: string; username?: string; display_name?: string };
    // Optional and ABSENT (not null) for a payment nobody gave a context to.
    source?: { app: string; ref?: string };
    created: number;
  }[];
  error?: { type: string; message: string };
}

async function getPayments(
  network: string | undefined,
  userId: string,
): Promise<{ status: number; body: PaymentsResponse }> {
  const query = network ? `?network=${network}` : '';
  const res = await fetch(`${baseUrl}/v1/social/me/payments${query}`, {
    headers: { 'X-Test-User-Id': userId },
  });
  return { status: res.status, body: (await res.json()) as PaymentsResponse };
}

describe('GET /v1/social/me/payments', () => {
  /**
   * The web build has no key, so it cannot derive its own addresses and cannot
   * use the address-list endpoints. This is the only view it can ask for, and
   * `direction` is the half that cannot come from the address alone.
   */
  test('returns what the caller sent and received, each with its direction', async () => {
    await gatewayDb()
      .insert(socialSendAttributions)
      .values([
        {
          address: 'Tsent000000000000000000000000000000',
          network: 'testnet',
          senderUserId: testProfile('alice').id,
          recipientUserId: testProfile('keylessbob').id,
          derivationIndex: 1,
        },
        {
          address: 'Trecv000000000000000000000000000000',
          network: 'testnet',
          senderUserId: testProfile('keylessbob').id,
          recipientUserId: testProfile('alice').id,
          derivationIndex: 2,
        },
      ]);

    const { status, body } = await getPayments('testnet', testProfile('alice').id);
    expect(status).toBe(200);
    const byAddress = Object.fromEntries((body.payments ?? []).map((p) => [p.address, p]));
    expect(byAddress.Tsent000000000000000000000000000000?.direction).toBe('sent');
    expect(byAddress.Trecv000000000000000000000000000000?.direction).toBe('received');
    expect(byAddress.Tsent000000000000000000000000000000?.counterparty.username).toBe('keylessbob');
  });

  /**
   * The security property, stated as a test: an attribution names two people,
   * so a caller who is neither must not learn that the payment exists.
   */
  test('never returns a payment the caller is not party to', async () => {
    await gatewayDb().insert(socialSendAttributions).values({
      address: 'Tstranger00000000000000000000000000',
      network: 'testnet',
      senderUserId: 'user_someone_else',
      recipientUserId: 'user_another',
      derivationIndex: 3,
    });

    const { body } = await getPayments('testnet', testProfile('alice').id);
    expect((body.payments ?? []).map((p) => p.address)).not.toContain(
      'Tstranger00000000000000000000000000',
    );
  });

  test('rejects an unknown network rather than guessing one', async () => {
    const { status } = await getPayments('dogenet', testProfile('alice').id);
    expect(status).toBe(400);
  });

  /**
   * The recipient's half of "tip a post": the payer's app named what the
   * payment was for at reservation time, and this is where the RECIPIENT — who
   * was never asked — reads it back.
   *
   * Both rows are seeded, because a response that carried the context onto
   * every payment would pass a test that only checked the sourced one.
   */
  test('carries the context on the payment that has one, and omits it on the one that does not', async () => {
    await gatewayDb()
      .insert(socialSendAttributions)
      .values([
        {
          address: 'Ttip0000000000000000000000000000000',
          network: 'testnet',
          senderUserId: testProfile('keylessbob').id,
          recipientUserId: testProfile('alice').id,
          derivationIndex: 1,
          sourceApp: 'mention',
          sourceRef: 'post_abc123',
        },
        {
          address: 'Tplain00000000000000000000000000000',
          network: 'testnet',
          senderUserId: testProfile('keylessbob').id,
          recipientUserId: testProfile('alice').id,
          derivationIndex: 2,
        },
      ]);

    const { status, body } = await getPayments('testnet', testProfile('alice').id);
    expect(status).toBe(200);
    const byAddress = Object.fromEntries((body.payments ?? []).map((p) => [p.address, p]));

    expect(byAddress.Ttip0000000000000000000000000000000?.source).toEqual({
      app: 'mention',
      ref: 'post_abc123',
    });
    // Absent, not null: `SocialPayment.source` is optional, and a client
    // checking `'source' in payment` must not see a context nobody sent.
    const plain = byAddress.Tplain00000000000000000000000000000;
    expect(plain).toBeDefined();
    expect(Object.keys(plain ?? {})).not.toContain('source');
  });

  /**
   * Display-only means display-only. The context rides alongside the payment
   * and changes nothing about it — same address, same direction, same
   * counterparty as the row without one.
   */
  test('the context does not affect the address, direction or counterparty', async () => {
    await gatewayDb()
      .insert(socialSendAttributions)
      .values({
        address: 'Tsourced000000000000000000000000000',
        network: 'testnet',
        senderUserId: testProfile('alice').id,
        recipientUserId: testProfile('keylessbob').id,
        derivationIndex: 1,
        sourceApp: 'mention',
        sourceRef: 'post_xyz',
      });

    const { body } = await getPayments('testnet', testProfile('alice').id);
    const payment = (body.payments ?? [])[0];
    expect(payment?.address).toBe('Tsourced000000000000000000000000000');
    expect(payment?.direction).toBe('sent');
    expect(payment?.counterparty.username).toBe('keylessbob');
  });
});

interface ReceiveAddressesResponse {
  addresses?: {
    address: string;
    derivation_index: number;
    identity_public_key: string | null;
    network: string;
    created: number;
  }[];
  has_more?: boolean;
  sync_cursor?: number;
  error?: { type: string; message: string };
}

async function getReceiveAddresses(
  query: string,
  userId: string,
): Promise<{ status: number; body: ReceiveAddressesResponse }> {
  const res = await fetch(`${baseUrl}/v1/social/me/receive_addresses?${query}`, {
    headers: { 'X-Test-User-Id': userId },
  });
  return { status: res.status, body: (await res.json()) as ReceiveAddressesResponse };
}

describe('GET /v1/social/me/receive_addresses (ADR 0021 D9)', () => {
  test('lists every address handed out for the caller, in index order, with its key', async () => {
    const handed: string[] = [];
    for (const sender of ['user_ra_1', 'user_ra_2', 'user_ra_3']) {
      handed.push(
        must((await postNextAddress('alice', { network: 'testnet' }, sender)).body.address),
      );
    }
    const { status, body } = await getReceiveAddresses('network=testnet', 'user_alice');
    expect(status).toBe(200);
    expect(body.has_more).toBe(false);
    expect(body.sync_cursor).toBe(3);
    expect(body.addresses?.map((a) => a.address)).toEqual(handed);
    expect(body.addresses?.map((a) => a.derivation_index)).toEqual([1, 2, 3]);
    for (const row of must(body.addresses)) {
      expect(row.identity_public_key).toMatch(/^[0-9a-f]{66,130}$/);
      expect(row.network).toBe('testnet');
      expect(row.created).toBeGreaterThan(0);
    }
    // The sender's own list holds none of them: they are alice's.
    const sender = await getReceiveAddresses('network=testnet', 'user_ra_1');
    expect(sender.body.addresses).toEqual([]);
    expect(sender.body.sync_cursor).toBe(0);
  });

  test('pages by the sync cursor and misses nothing handed out after it', async () => {
    for (const sender of ['user_rp_1', 'user_rp_2', 'user_rp_3']) {
      await postNextAddress('alice', { network: 'testnet' }, sender);
    }
    const first = await getReceiveAddresses('network=testnet&limit=2', 'user_alice');
    expect(first.body.addresses?.map((a) => a.derivation_index)).toEqual([1, 2]);
    expect(first.body.has_more).toBe(true);
    expect(first.body.sync_cursor).toBe(2);
    const second = await getReceiveAddresses(
      `network=testnet&limit=2&after=${String(first.body.sync_cursor)}`,
      'user_alice',
    );
    expect(second.body.addresses?.map((a) => a.derivation_index)).toEqual([3]);
    expect(second.body.has_more).toBe(false);
    const done = await getReceiveAddresses(
      `network=testnet&after=${String(second.body.sync_cursor)}`,
      'user_alice',
    );
    expect(done.body.addresses).toEqual([]);
    expect(done.body.sync_cursor).toBe(3);
    await postNextAddress('alice', { network: 'testnet' }, 'user_rp_4');
    const later = await getReceiveAddresses('network=testnet&after=3', 'user_alice');
    expect(later.body.addresses?.map((a) => a.derivation_index)).toEqual([4]);
  });

  test('is scoped per network, and refuses a bad query', async () => {
    await postNextAddress('alice', { network: 'testnet' }, 'user_rn_1');
    const mainnet = await getReceiveAddresses('network=mainnet', 'user_alice');
    expect(mainnet.status).toBe(200);
    expect(mainnet.body.addresses).toEqual([]);
    expect((await getReceiveAddresses('', 'user_alice')).status).toBe(400);
    expect((await getReceiveAddresses('network=testnet&limit=0', 'user_alice')).status).toBe(400);
    expect((await getReceiveAddresses('network=testnet&limit=1001', 'user_alice')).status).toBe(
      400,
    );
    expect((await getReceiveAddresses('network=testnet&after=-1', 'user_alice')).status).toBe(400);
    expect((await getReceiveAddresses('network=testnet&extra=1', 'user_alice')).status).toBe(400);
  });
});
