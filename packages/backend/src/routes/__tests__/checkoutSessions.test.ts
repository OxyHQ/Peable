import {
  test,
  expect,
  beforeAll,
  afterAll,
  describe,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";
import { merchants, paymentIntents } from "../../db/schema";
import { findIntentByPublicId } from "../../db/payments/paymentIntentRepository";
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  seedSession,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createCheckoutSessionsRouter } from "../checkoutSessions";

const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const APP_ID = "app_checkoutsessions";

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: "t",
    scopes: ["payments:read", "payments:write"],
    credentialId: "c",
    ownerAccountId: "owner",
    environment: "development",
  };
  next();
};

const passthroughRateLimit: RequestHandler = (_req, _res, next) => next();

interface CheckoutSessionResponse {
  id: string;
  object: string;
  paymentIntentId: string;
  clientSecret: string;
  amount: string;
  network: string;
  metadata: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
  url: string;
  error?: { type: string; message: string };
}

interface CheckoutSessionPublicResponse {
  id: string;
  object: string;
  successUrl?: string;
  cancelUrl?: string;
  merchant: { name: string; avatarUrl: string | null; description: string | null };
  paymentIntent: { id: string; clientSecret: string; amount: string };
  error?: { type: string; message: string };
}

let server: Server;
let baseUrl: string;
let merchantId: string;

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * A bare `count(*)` of one merchant's intents. No repository function answers
 * it — nothing in production needs the number — so the two "minted nothing"
 * cases below read it straight off the table.
 */
async function countIntentsForMerchant(id: string): Promise<number> {
  const rows = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(eq(paymentIntents.merchantId, id));
  return rows[0]?.n ?? 0;
}

useGatewayDatabase();

beforeAll(async () => {
  const merchant = await seedMerchant({
    publicId: "merch_test_cs_1",
    oxyAppId: APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
  });
  // `displayName` is not an `insertMerchant`/`seedMerchant` parameter — it has
  // no registration route, only a column — and the public session DTO renders
  // it. Set directly so the assertion that reads it back stays as it was.
  await gatewayDb()
    .update(merchants)
    .set({ displayName: "Sessions Co" })
    .where(eq(merchants.id, merchant.id));
  merchantId = merchant.id;

  const app = express();
  app.use(express.json());
  app.use(
    createCheckoutSessionsRouter({
      requireMerchant: stubRequireMerchant,
      publicRateLimit: passthroughRateLimit,
    }),
  );
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("POST /v1/checkout_sessions", () => {
  test("wraps a real intent and returns its client_secret", async () => {
    const res = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "400000000",
        network: "testnet",
        metadata: { orderId: "o_cs_1" },
        successUrl: "https://merchant.example/success",
        cancelUrl: "https://merchant.example/cancel",
      }),
    });
    expect(res.status).toBe(201);
    const body = await readJson<CheckoutSessionResponse>(res);
    expect(body.id).toMatch(/^cs_[0-9a-f]+$/);
    expect(body.object).toBe("checkout_session");
    expect(body.paymentIntentId).toMatch(/^pi_[0-9a-f]+$/);
    expect(body.clientSecret).toStartWith(`${body.paymentIntentId}_secret_`);
    expect(body.amount).toBe("400000000");
    expect(body.metadata).toEqual({ orderId: "o_cs_1" });
    expect(body.url).toBe(`https://checkout.peable.to/c/${body.id}`);

    const intent = await findIntentByPublicId(gatewayDb(), body.paymentIntentId);
    expect(intent).not.toBeNull();
    expect(intent?.clientSecret).toBe(body.clientSecret);
  });

  test("a network that doesn't match the merchant's configured network -> 422, no intent minted", async () => {
    const before = await countIntentsForMerchant(merchantId);
    const res = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "100000000", network: "mainnet" }),
    });
    expect(res.status).toBe(422);
    const body = await readJson<CheckoutSessionResponse>(res);
    expect(body.error?.type).toBe("invalid_request_error");
    const after = await countIntentsForMerchant(merchantId);
    expect(after).toBe(before);
  });

  test("no service app credentials -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createCheckoutSessionsRouter({
        requireMerchant: (_req, _res, next) => next(),
        publicRateLimit: passthroughRateLimit,
      }),
    );
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${noAuthAddress.port}/v1/checkout_sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: "100000000", network: "testnet" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noAuthServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("GET /v1/checkout_sessions/:id (merchant retrieve)", () => {
  test("retrieves a created session with its client_secret", async () => {
    const createRes = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "60000000", network: "testnet" }),
    });
    const created = await readJson<CheckoutSessionResponse>(createRes);

    const getRes = await fetch(`${baseUrl}/v1/checkout_sessions/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await readJson<CheckoutSessionResponse>(getRes);
    expect(fetched.id).toBe(created.id);
    expect(fetched.clientSecret).toBe(created.clientSecret);
  });

  test("unknown id -> 404", async () => {
    const res = await fetch(`${baseUrl}/v1/checkout_sessions/cs_doesnotexist`);
    expect(res.status).toBe(404);
  });

  test("a session belonging to a different merchant -> 404 (never leaks cross-tenant)", async () => {
    const otherMerchant = await seedMerchant({
      publicId: "merch_test_cs_other",
      oxyAppId: "app_cs_other",
      environment: "development",
      network: "testnet",
      xpub: XPUB,
    });
    const otherIntent = await seedIntent(otherMerchant, {
      publicId: "pi_0000000000000000000000c1",
      amount: "10000000",
      network: "testnet",
      address: "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3",
      clientSecret: "pi_0000000000000000000000c1_secret_z",
      idempotencyKey: "idem_cs_other",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const otherSession = await seedSession(otherMerchant, otherIntent, {
      publicId: "cs_other_owner",
      amount: "10000000",
      metadata: {},
    });

    const res = await fetch(`${baseUrl}/v1/checkout_sessions/${otherSession.publicId}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/checkout_sessions/:id/public", () => {
  test("without a client_secret -> 401, never leaks merchant/intent", async () => {
    const createRes = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "70000000", network: "testnet" }),
    });
    const created = await readJson<CheckoutSessionResponse>(createRes);

    const res = await fetch(`${baseUrl}/v1/checkout_sessions/${created.id}/public`);
    expect(res.status).toBe(401);
  });

  test("with the WRONG client_secret -> 403", async () => {
    const createRes = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "70000000", network: "testnet" }),
    });
    const created = await readJson<CheckoutSessionResponse>(createRes);

    const res = await fetch(
      `${baseUrl}/v1/checkout_sessions/${created.id}/public?client_secret=wrong_secret`,
    );
    expect(res.status).toBe(403);
  });

  test("with the RIGHT client_secret -> 200, returns merchant display + the intent snapshot", async () => {
    const createRes = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "88000000",
        network: "testnet",
        successUrl: "https://merchant.example/success",
      }),
    });
    const created = await readJson<CheckoutSessionResponse>(createRes);

    const res = await fetch(
      `${baseUrl}/v1/checkout_sessions/${created.id}/public?client_secret=${created.clientSecret}`,
    );
    expect(res.status).toBe(200);
    const body = await readJson<CheckoutSessionPublicResponse>(res);
    expect(body.id).toBe(created.id);
    expect(body.successUrl).toBe("https://merchant.example/success");
    expect(body.merchant.name).toBe("Sessions Co");
    expect(body.paymentIntent.id).toBe(created.paymentIntentId);
    expect(body.paymentIntent.clientSecret).toBe(created.clientSecret);
    expect(body.paymentIntent.amount).toBe("88000000");
  });

  test("accepts the client_secret via the X-Peable-Client-Secret header too", async () => {
    const createRes = await fetch(`${baseUrl}/v1/checkout_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "12000000", network: "testnet" }),
    });
    const created = await readJson<CheckoutSessionResponse>(createRes);

    const res = await fetch(`${baseUrl}/v1/checkout_sessions/${created.id}/public`, {
      headers: { "X-Peable-Client-Secret": created.clientSecret },
    });
    expect(res.status).toBe(200);
  });

  test("unknown session id -> 404 even with a well-formed secret param", async () => {
    const res = await fetch(
      `${baseUrl}/v1/checkout_sessions/cs_doesnotexist/public?client_secret=whatever`,
    );
    expect(res.status).toBe(404);
  });
});
