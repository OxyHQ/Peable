import {
  test,
  expect,
  beforeAll,
  afterAll,
  describe,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { eq, sql } from "drizzle-orm";
import express from "express";
import type { RequestHandler } from "express";
import { uuidv7 } from "@oxy.so/db";
import type { OxyAuthRequest, SafeFetchResult } from "@oxy.so/core/server";
import { webhookDeliveries } from "../../db/schema";
import {
  gatewayDb,
  seedDelivery,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createWebhookDeliveriesRouter } from "../webhookDeliveries";

const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const APP_ID = "app_redeliver";

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: "t",
    scopes: ["payments:write"],
    credentialId: "c",
    ownerAccountId: "owner",
    environment: "development",
  };
  next();
};

let server: Server;
let baseUrl: string;
let merchantId: string;
let intentId: string;
let deliveryId: string;

const capturedFetches: string[] = [];
const fakeSafeFetch = async (url: string): Promise<SafeFetchResult> => {
  capturedFetches.push(url);
  const response = new IncomingMessage(new Socket());
  return { response, status: 200, headers: {}, finalUrl: url };
};

/**
 * A bare `count(*)` of one merchant's deliveries. No repository function
 * answers it — the list path pages rather than counting — so the "persists a
 * NEW delivery row" case reads it straight off the table.
 */
async function countDeliveriesForMerchant(id: string): Promise<number> {
  const rows = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.merchantId, id));
  return rows[0]?.n ?? 0;
}

useGatewayDatabase();

beforeAll(async () => {
  const merchant = await seedMerchant({
    publicId: "merch_test_redeliver_1",
    oxyAppId: APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    webhookUrl: "https://merchant.example/hook",
    webhookSecret: "whsec_redeliver",
  });
  merchantId = merchant.id;

  const intent = await seedIntent(merchant, {
    publicId: "pi_0000000000000000000000f1",
    amount: "100000000",
    network: "testnet",
    address: "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3",
    clientSecret: "pi_0000000000000000000000f1_secret_x",
    idempotencyKey: "idem_redeliver",
    expiresAt: new Date(Date.now() + 60_000),
  });
  // The PUBLIC `pi_…`: `WebhookDelivery.intentId` on the wire carries that, not
  // the internal reference the delivery row stores.
  intentId = intent.publicId;

  const delivery = await seedDelivery(merchant, intent, {
    eventId: "evt_0000000000000000000000f1",
    eventType: "payment_intent.settled",
    url: "https://merchant.example/hook",
    pending: true,
  });
  deliveryId = delivery.id;

  const app = express();
  app.use(express.json());
  app.use(
    createWebhookDeliveriesRouter({
      requireMerchant: stubRequireMerchant,
      safeFetch: fakeSafeFetch,
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

describe("POST /v1/webhook_deliveries/:id/redeliver", () => {
  test("redelivers and persists a NEW delivery row", async () => {
    const before = await countDeliveriesForMerchant(merchantId);
    const res = await fetch(`${baseUrl}/v1/webhook_deliveries/${deliveryId}/redeliver`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivered: boolean; intentId: string };
    expect(body.delivered).toBe(true);
    expect(body.intentId).toBe(intentId);
    expect(capturedFetches.at(-1)).toBe("https://merchant.example/hook");

    const after = await countDeliveriesForMerchant(merchantId);
    expect(after).toBe(before + 1);
  });

  test("unknown delivery id -> 404", async () => {
    // A well-formed id of the shape the table actually mints, so this stays the
    // "exists nowhere" case and the malformed one below stays distinct from it.
    const res = await fetch(
      `${baseUrl}/v1/webhook_deliveries/${uuidv7()}/redeliver`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  test("malformed id (not an ObjectId) -> 404, no CastError 500", async () => {
    const res = await fetch(`${baseUrl}/v1/webhook_deliveries/not-an-object-id/redeliver`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("a delivery belonging to a different merchant -> 404 (never leaks cross-tenant)", async () => {
    const otherMerchant = await seedMerchant({
      publicId: "merch_test_redeliver_other",
      oxyAppId: "app_redeliver_other",
      environment: "development",
      network: "testnet",
      xpub: XPUB,
    });
    const otherIntent = await seedIntent(otherMerchant, {
      publicId: "pi_0000000000000000000000f2",
      amount: "100000000",
      network: "testnet",
      address: "TVdQEadb9Yurh3QCBf1vwjZxNySQvHxFmk",
      clientSecret: "pi_0000000000000000000000f2_secret_y",
      idempotencyKey: "idem_redeliver_other",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const otherDelivery = await seedDelivery(otherMerchant, otherIntent, {
      eventId: "evt_0000000000000000000000f2",
      eventType: "payment_intent.settled",
      url: "https://other.example/hook",
    });

    const res = await fetch(`${baseUrl}/v1/webhook_deliveries/${otherDelivery.id}/redeliver`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("no service app credentials at all -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createWebhookDeliveriesRouter({
        requireMerchant: (_req, _res, next) => next(),
        safeFetch: fakeSafeFetch,
      }),
    );
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noAuthAddress.port}/v1/webhook_deliveries/${deliveryId}/redeliver`,
        { method: "POST" },
      );
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noAuthServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test("a credential without payments:write is rejected (403)", async () => {
    const noScopeRequireMerchant: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: APP_ID,
        appName: "t",
        scopes: ["payments:read"],
        credentialId: "c",
        ownerAccountId: "owner",
        environment: "development",
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(
      createWebhookDeliveriesRouter({
        requireMerchant: noScopeRequireMerchant,
        safeFetch: fakeSafeFetch,
      }),
    );
    const noScopeServer = app.listen(0);
    const noScopeAddress = noScopeServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noScopeAddress.port}/v1/webhook_deliveries/${deliveryId}/redeliver`,
        { method: "POST" },
      );
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noScopeServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
