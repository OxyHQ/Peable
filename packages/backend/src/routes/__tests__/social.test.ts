import { test, expect, beforeAll, afterAll, beforeEach, describe, mock } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { OxyAuthRequest } from "@oxyhq/core/server";
import { oxyClient as realOxyClient, type User } from "@oxyhq/core";
import type { DidDocument } from "@oxyhq/contracts";
import { socialSendAttributions } from "../../db/schema";
import {
  gatewayDb,
  resetGatewayTables,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";

const IDENTITY_PUB_A_UNCOMPRESSED_HEX =
  "046a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb336b6fbcb60b5b3d4f1551ac45e5ffc4936466e7d98f6c7c0ec736539f74691a6";

const PROFILES: Record<string, { id: string; username: string }> = {
  alice: { id: "user_alice", username: "alice" },
  keylessbob: { id: "user_keylessbob", username: "keylessbob" },
};

function didFor(userId: string): DidDocument {
  const hasKey = userId !== "user_keylessbob";
  return {
    "@context": [],
    id: `did:web:oxy.so:u:${userId}`,
    controller: [],
    verificationMethod: hasKey
      ? [
          {
            id: `did:web:oxy.so:u:${userId}#key-1`,
            type: "EcdsaSecp256k1VerificationKey2019",
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
  if (username === "flaky") {
    throw new Error("network timeout");
  }
  const profile = PROFILES[username];
  if (!profile) {
    // Real `getProfileByUsername` 404s carry `.status` (set by
    // `OxyServices.base.ts`'s `handleError`) — mirror that shape so
    // `isNotFoundError` in the route under test exercises the real check.
    const err = new Error("not found") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  return profile as unknown as User;
});
const resolveDidMock = mock(async (userId: string) => didFor(userId));
// `enrichAddresses` resolves counterparty identity through this one.
const getUsersByIdsMock = mock(async (ids: string[]) =>
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

// `mock.module` replaces `@oxyhq/core` process-wide for the rest of this bun
// test run, including for OTHER test files whose `oxyClient` binding resolves
// after this one applies. Wrap the REAL `oxyClient` in a `Proxy` that only
// intercepts the two methods this route needs and forwards everything else
// (`serviceAuth`, `auth`, ...) to the real instance — `serviceAuthWiring.test.ts`
// and `merchants.test.ts` call those and must keep working regardless of file
// run order. Methods are bound to `target` (the real instance) rather than
// invoked through the proxy so any internal state/private fields they close
// over stay intact.
const mockedOxyClient = new Proxy(realOxyClient, {
  get(target, prop, receiver) {
    if (prop === "getProfileByUsername") return getProfileByUsernameMock;
    if (prop === "resolveDid") return resolveDidMock;
    if (prop === "getUsersByIds") return getUsersByIdsMock;
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

mock.module("@oxyhq/core", () => ({
  oxyClient: mockedOxyClient,
}));

const { createSocialRouter, NEXT_ADDRESS_PAIR_MAX } = await import("../social");

const TEST_SENDER_ID = "user_test_sender";
// Honors an `X-Test-User-Id` override so individual tests can authenticate as
// a caller OTHER than the default sender — needed both for `GET
// /v1/social/me/cursor` (authenticated as the RECIPIENT, not the sender) and
// for the per-(sender,recipient) rate-limit tests (a fresh sender id per
// test keeps them independent of the shared in-memory limiter state, which
// — unlike the database tables — `beforeEach` below does not reset).
const stubRequireOxyUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = req.header("X-Test-User-Id") ?? TEST_SENDER_ID;
  next();
};

let server: Server;
let baseUrl: string;

interface NextAddressResponse {
  address?: string;
  index?: number;
  error?: { type: string; message: string };
}

interface CursorResponse {
  reservedThrough?: number;
  error?: { type: string; message: string };
}

async function postNextAddress(
  username: string,
  body: Record<string, unknown>,
  senderId?: string,
): Promise<{ status: number; body: NextAddressResponse }> {
  const res = await fetch(`${baseUrl}/v1/social/${username}/next_address`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(senderId ? { "X-Test-User-Id": senderId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as NextAddressResponse };
}

async function getCursor(
  network: string | undefined,
  userId: string,
): Promise<{ status: number; body: CursorResponse }> {
  const query = network ? `?network=${network}` : "";
  const res = await fetch(`${baseUrl}/v1/social/me/cursor${query}`, {
    headers: { "X-Test-User-Id": userId },
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

describe("POST /v1/social/:username/next_address", () => {
  test("reserves a fresh address and records the attribution", async () => {
    const { status, body } = await postNextAddress("alice", { network: "testnet" });

    expect(status).toBe(200);
    expect(body.index).toBe(1);
    expect(body.address).toBe("TERWsvgi5BFcdDKgpM1PsHMqenLuGggZqQ");

    // `findAttributionsForViewer` is the only repository read over this table
    // and it scopes to a viewer, which this assertion deliberately does not —
    // so the address lookup goes through drizzle directly, as the Mongo read it
    // replaces did. The stored column is `derivation_index`, spelled `index` in
    // the Mongo document.
    const [attribution] = await gatewayDb()
      .select()
      .from(socialSendAttributions)
      .where(eq(socialSendAttributions.address, body.address ?? ""));
    expect(attribution?.senderUserId).toBe(TEST_SENDER_ID);
    expect(attribution?.recipientUserId).toBe("user_alice");
    expect(attribution?.derivationIndex).toBe(1);
  });

  test("second call for the same recipient reserves the next index", async () => {
    await postNextAddress("alice", { network: "testnet" });
    const { body } = await postNextAddress("alice", { network: "testnet" });
    expect(body.index).toBe(2);
  });

  test("404s for an unknown username", async () => {
    const { status, body } = await postNextAddress("nobody", { network: "testnet" });
    expect(status).toBe(404);
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("409s with type keyless_recipient for a keyless recipient", async () => {
    const { status, body } = await postNextAddress("keylessbob", { network: "testnet" });
    expect(status).toBe(409);
    expect(body.error?.type).toBe("keyless_recipient");
  });

  test("422s on a malformed network field", async () => {
    const { status, body } = await postNextAddress("alice", { network: "regtest" });
    expect(status).toBe(422);
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("502s with type api_error (not 404) when the profile lookup fails upstream", async () => {
    const { status, body } = await postNextAddress("flaky", { network: "testnet" });
    expect(status).toBe(502);
    expect(body.error?.type).toBe("api_error");
  });
});

describe("POST /v1/social/:username/next_address — per-(sender,recipient) anti-grief rate limit", () => {
  test(`the ${NEXT_ADDRESS_PAIR_MAX + 1}th reservation against the same recipient from the same sender is rate-limited`, async () => {
    const sender = "user_grief_sender_a";
    for (let i = 0; i < NEXT_ADDRESS_PAIR_MAX; i++) {
      const { status } = await postNextAddress("alice", { network: "testnet" }, sender);
      expect(status).toBe(200);
    }

    const { status, body } = await postNextAddress("alice", { network: "testnet" }, sender);
    expect(status).toBe(429);
    expect(body.error?.type).toBe("rate_limit_error");
  });

  test("the limit is keyed per (sender, recipient) pair — a different sender against the same recipient is unaffected", async () => {
    const griefer = "user_grief_sender_b";
    for (let i = 0; i < NEXT_ADDRESS_PAIR_MAX; i++) {
      await postNextAddress("alice", { network: "testnet" }, griefer);
    }
    const grieferLimited = await postNextAddress("alice", { network: "testnet" }, griefer);
    expect(grieferLimited.status).toBe(429);

    const otherSender = await postNextAddress(
      "alice",
      { network: "testnet" },
      "user_grief_sender_c",
    );
    expect(otherSender.status).toBe(200);
  });
});

describe("GET /v1/social/me/cursor", () => {
  test("returns reservedThrough: 0 for a caller with no cursor yet", async () => {
    const { status, body } = await getCursor("testnet", "user_cursor_fresh");
    expect(status).toBe(200);
    expect(body.reservedThrough).toBe(0);
  });

  test("returns the highest index ever reserved for the authenticated caller (recipient), not the sender", async () => {
    const sender = "user_cursor_value_sender";
    await postNextAddress("alice", { network: "testnet" }, sender);
    await postNextAddress("alice", { network: "testnet" }, sender);

    const { status, body } = await getCursor("testnet", "user_alice");
    expect(status).toBe(200);
    expect(body.reservedThrough).toBe(2);
  });

  test("is scoped per network — a testnet reservation does not surface under mainnet", async () => {
    const sender = "user_cursor_network_sender";
    await postNextAddress("alice", { network: "testnet" }, sender);

    const { status, body } = await getCursor("mainnet", "user_alice");
    expect(status).toBe(200);
    expect(body.reservedThrough).toBe(0);
  });

  test("422s on a missing network query param", async () => {
    const { status, body } = await getCursor(undefined, "user_alice");
    expect(status).toBe(422);
    expect(body.error?.type).toBe("invalid_request_error");
  });
});

// --- GET /v1/social/me/payments -------------------------------------------

interface PaymentsResponse {
  payments?: {
    address: string;
    direction: "sent" | "received";
    // `EnrichmentResult`: never null, degrades to `{ kind: 'unknown' }`.
    counterparty: { kind: string; username?: string; displayName?: string };
    createdAt: string;
  }[];
  error?: { type: string; message: string };
}

async function getPayments(
  network: string | undefined,
  userId: string,
): Promise<{ status: number; body: PaymentsResponse }> {
  const query = network ? `?network=${network}` : "";
  const res = await fetch(`${baseUrl}/v1/social/me/payments${query}`, {
    headers: { "X-Test-User-Id": userId },
  });
  return { status: res.status, body: (await res.json()) as PaymentsResponse };
}

describe("GET /v1/social/me/payments", () => {
  /**
   * The web build has no key, so it cannot derive its own addresses and cannot
   * use the address-list endpoints. This is the only view it can ask for, and
   * `direction` is the half that cannot come from the address alone.
   */
  test("returns what the caller sent and received, each with its direction", async () => {
    await gatewayDb().insert(socialSendAttributions).values([
      {
        address: "Tsent000000000000000000000000000000",
        network: "testnet",
        senderUserId: testProfile("alice").id,
        recipientUserId: testProfile("keylessbob").id,
        derivationIndex: 1,
      },
      {
        address: "Trecv000000000000000000000000000000",
        network: "testnet",
        senderUserId: testProfile("keylessbob").id,
        recipientUserId: testProfile("alice").id,
        derivationIndex: 2,
      },
    ]);

    const { status, body } = await getPayments("testnet", testProfile("alice").id);
    expect(status).toBe(200);
    const byAddress = Object.fromEntries(
      (body.payments ?? []).map((p) => [p.address, p]),
    );
    expect(byAddress["Tsent000000000000000000000000000000"]?.direction).toBe("sent");
    expect(byAddress["Trecv000000000000000000000000000000"]?.direction).toBe("received");
    expect(byAddress["Tsent000000000000000000000000000000"]?.counterparty.username).toBe(
      "keylessbob",
    );
  });

  /**
   * The security property, stated as a test: an attribution names two people,
   * so a caller who is neither must not learn that the payment exists.
   */
  test("never returns a payment the caller is not party to", async () => {
    await gatewayDb().insert(socialSendAttributions).values({
      address: "Tstranger00000000000000000000000000",
      network: "testnet",
      senderUserId: "user_someone_else",
      recipientUserId: "user_another",
      derivationIndex: 3,
    });

    const { body } = await getPayments("testnet", testProfile("alice").id);
    expect((body.payments ?? []).map((p) => p.address)).not.toContain(
      "Tstranger00000000000000000000000000",
    );
  });

  test("rejects an unknown network rather than guessing one", async () => {
    const { status } = await getPayments("dogenet", testProfile("alice").id);
    expect(status).toBe(422);
  });
});
