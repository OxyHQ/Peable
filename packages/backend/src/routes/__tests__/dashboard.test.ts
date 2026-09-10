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
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import type { RequestHandler } from "express";
import { MAINNET, deriveKeyFromSeed, mnemonicToSeed } from "@fairco.in/core";
import { uuidv7 } from "@oxy.so/db";
import type { OxyAuthRequest, SafeFetchResult } from "@oxy.so/core/server";
import { merchants } from "../../db/schema";
import { findMerchantByAppEnvironment } from "../../db/merchants/merchantRepository";
import type { AppMembershipResult } from "../../services/appMembership";
import {
  gatewayDb,
  seedDelivery,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createDashboardRouter } from "../dashboard";

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic
// (m/44'/1'/0' neutered) — public-key-only, cannot spend. Same fixture used
// across the rest of the suite.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";

// The same mnemonic's MAINNET-network account xpub (distinct BIP32 version
// bytes) — needed for the "production environment registers a mainnet
// merchant" case.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const MAINNET_XPUB = deriveKeyFromSeed(mnemonicToSeed(MNEMONIC), MAINNET)
  .derive(`m/44'/${MAINNET.bip44CoinType}'/0'`)
  .hdKey.publicExtendedKey;

const APP_ID = "app_dashboard_test";
const OTHER_APP_ID = "app_dashboard_other";
const MEMBER_USER_ID = "user_member";
const OUTSIDER_USER_ID = "user_outsider";

/**
 * Stub `requireOxyUser`: bypasses a real Oxy bearer by populating
 * `req.userId`/`req.accessToken` directly from a test header — mirrors
 * `routes/__tests__/social.test.ts`'s `X-Test-User-Id` convention. The
 * "bearer" value only needs to exist (it's forwarded to the stubbed
 * `assertAppMembership` below, never a real oxy-api call).
 */
const stubRequireOxyUser: RequestHandler = (req, _res, next) => {
  const userId = req.header("X-Test-User-Id") ?? MEMBER_USER_ID;
  (req as OxyAuthRequest).userId = userId;
  (req as OxyAuthRequest).accessToken = `token-for-${userId}`;
  next();
};

/**
 * Stub `assertAppMembership`: allowed iff the caller is `MEMBER_USER_ID` —
 * proves the router's 403 gate without a real oxy-api round trip (Proxy-
 * wrapped-real-client isn't applicable here since `assertAppMembership` is
 * itself an injected router dependency, not `@oxy.so/core`).
 */
const stubAssertAppMembership = async (userId: string): Promise<AppMembershipResult> => ({
  allowed: userId === MEMBER_USER_ID,
});

const capturedRedeliverFetches: string[] = [];
const fakeSafeFetch = async (url: string): Promise<SafeFetchResult> => {
  capturedRedeliverFetches.push(url);
  const response = new IncomingMessage(new Socket());
  return { response, status: 200, headers: {}, finalUrl: url };
};

let server: Server;
let baseUrl: string;

/**
 * A bare `count(*)` of the merchants registered for one application, optionally
 * narrowed to one environment. No repository function answers it — nothing in
 * production counts merchants — so the two "registered nothing" cases below
 * read it straight off the table.
 */
async function countMerchantsForApp(appId: string, environment?: string): Promise<number> {
  const conditions = [eq(merchants.oxyAppId, appId)];
  if (environment !== undefined) conditions.push(eq(merchants.environment, environment));
  const rows = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(merchants)
    .where(and(...conditions));
  return rows[0]?.n ?? 0;
}

function authedFetch(
  path: string,
  init: RequestInit & { userId?: string } = {},
): Promise<Response> {
  const { userId, headers, ...rest } = init;
  return fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      "X-Test-User-Id": userId ?? MEMBER_USER_ID,
      ...headers,
    },
  });
}

useGatewayDatabase();

beforeAll(async () => {
  await seedMerchant({
    publicId: "merch_dash_dev",
    oxyAppId: APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    webhookUrl: "https://merchant.example/hook",
    webhookSecret: "whsec_dash_test",
  });
  await seedMerchant({
    publicId: "merch_dash_prod",
    oxyAppId: APP_ID,
    environment: "production",
    network: "mainnet",
    xpub: MAINNET_XPUB,
  });

  const app = express();
  app.use(express.json());
  app.use(
    createDashboardRouter({
      requireOxyUser: stubRequireOxyUser,
      assertAppMembership: stubAssertAppMembership,
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

describe("GET /v1/dashboard/applications/:applicationId/merchant", () => {
  test("a member reads their development merchant", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/merchant?environment=development`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { environment: string; network: string };
    expect(body.environment).toBe("development");
    expect(body.network).toBe("testnet");
  });

  test("the SAME app+member reads a DIFFERENT merchant under production — environment scoping", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/merchant?environment=production`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { environment: string; network: string };
    expect(body.environment).toBe("production");
    expect(body.network).toBe("mainnet");
  });

  test("staging has no merchant registered -> 404", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/merchant?environment=staging`,
    );
    expect(res.status).toBe(404);
  });

  test("a non-member is denied (403), regardless of the merchant existing", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/merchant?environment=development`,
      { userId: OUTSIDER_USER_ID },
    );
    expect(res.status).toBe(403);
  });

  test("a non-member of THIS app is still denied even for an app that doesn't exist — never leaks which (404 vs 403)", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${OTHER_APP_ID}/merchant?environment=development`,
      { userId: OUTSIDER_USER_ID },
    );
    expect(res.status).toBe(403);
  });

  test("missing environment query param -> 422", async () => {
    const res = await authedFetch(`/v1/dashboard/applications/${APP_ID}/merchant`);
    expect(res.status).toBe(422);
  });

  test("an invalid environment value -> 422", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/merchant?environment=regtest`,
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /v1/dashboard/applications/:applicationId/merchant", () => {
  // Each test below registers against its OWN dedicated application id
  // (the stubbed `assertAppMembership` allows any applicationId for
  // `MEMBER_USER_ID`, so this costs nothing) — Merchant docs are looked up by
  // `(oxyAppId, environment)`, so sharing one id across tests would make
  // outcomes depend on execution order (`bun test --randomize`). Never share
  // a registration target across tests in this block.

  test("a development session cannot register a mainnet merchant (422) — test/live firewall", async () => {
    const appId = "app_dash_post_firewall";
    const res = await authedFetch(
      `/v1/dashboard/applications/${appId}/merchant?environment=development`,
      { method: "POST", body: JSON.stringify({ network: "mainnet", xpub: MAINNET_XPUB }) },
    );
    expect(res.status).toBe(422);
    const count = await countMerchantsForApp(appId);
    expect(count).toBe(0);
  });

  test("a development session registers a testnet merchant (201)", async () => {
    const appId = "app_dash_post_register";
    const res = await authedFetch(
      `/v1/dashboard/applications/${appId}/merchant?environment=development`,
      { method: "POST", body: JSON.stringify({ network: "testnet", xpub: XPUB }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { environment: string; network: string };
    expect(body.environment).toBe("development");
    expect(body.network).toBe("testnet");
  });

  test("registering twice for the same application+environment collides (409)", async () => {
    const appId = "app_dash_post_duplicate";
    const first = await authedFetch(
      `/v1/dashboard/applications/${appId}/merchant?environment=development`,
      { method: "POST", body: JSON.stringify({ network: "testnet", xpub: XPUB }) },
    );
    expect(first.status).toBe(201);

    const second = await authedFetch(
      `/v1/dashboard/applications/${appId}/merchant?environment=development`,
      { method: "POST", body: JSON.stringify({ network: "testnet", xpub: XPUB }) },
    );
    expect(second.status).toBe(409);
  });

  test("a non-member cannot register a merchant (403), before any firewall/create logic runs", async () => {
    const appId = "app_dash_post_nonmember";
    const res = await authedFetch(
      `/v1/dashboard/applications/${appId}/merchant?environment=staging`,
      { method: "POST", body: JSON.stringify({ network: "testnet", xpub: XPUB }), userId: OUTSIDER_USER_ID },
    );
    expect(res.status).toBe(403);
    const count = await countMerchantsForApp(appId, "staging");
    expect(count).toBe(0);
  });
});

describe("PATCH /v1/dashboard/applications/:applicationId/merchant", () => {
  test("updates webhookUrl and requiredConfirmations, never xpub", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/merchant?environment=development`,
      {
        method: "PATCH",
        body: JSON.stringify({
          webhookUrl: "https://merchant.example/rotated-hook",
          requiredConfirmations: 4,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      webhookUrl: string;
      requiredConfirmations: number;
      xpub: string;
    };
    expect(body.webhookUrl).toBe("https://merchant.example/rotated-hook");
    expect(body.requiredConfirmations).toBe(4);
    expect(body.xpub).toBe(XPUB);
  });
});

describe("GET /v1/dashboard/applications/:applicationId/payment_intents", () => {
  test("lists only the environment-scoped merchant's intents", async () => {
    const devMerchant = await findMerchantByAppEnvironment(
      gatewayDb(),
      APP_ID,
      "development",
    );
    expect(devMerchant).toBeTruthy();
    // Unreachable once the assertion above has passed; it is what narrows the
    // type for the seed call, which `expect(...).toBeTruthy()` does not do.
    if (!devMerchant) throw new Error("no development merchant");
    await seedIntent(devMerchant, {
      publicId: "pi_dash_list_1",
      amount: "1000000",
      network: "testnet",
      address: "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3",
      clientSecret: "pi_dash_list_1_secret",
      idempotencyKey: "idem_dash_list_1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/payment_intents?environment=development`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[]; has_more: boolean };
    expect(body.data.some((intent) => intent.id === "pi_dash_list_1")).toBe(true);

    // The SAME app's `production` merchant sees none of the `development`
    // merchant's intents — proves environment scoping isn't just cosmetic.
    const prodRes = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/payment_intents?environment=production`,
    );
    const prodBody = (await prodRes.json()) as { data: { id: string }[] };
    expect(prodBody.data.some((intent) => intent.id === "pi_dash_list_1")).toBe(false);
  });

  test("a non-member is denied (403)", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/payment_intents?environment=development`,
      { userId: OUTSIDER_USER_ID },
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/dashboard/applications/:applicationId/payment_intents/:id", () => {
  test("returns the single intent scoped to the resolved merchant", async () => {
    // A dedicated intent, NOT the sibling `payment_intents` list describe
    // block's fixture — each describe block owns its own data so outcomes
    // never depend on which block ran first (`bun test --randomize`).
    const devMerchant = await findMerchantByAppEnvironment(
      gatewayDb(),
      APP_ID,
      "development",
    );
    expect(devMerchant).toBeTruthy();
    // Unreachable once the assertion above has passed; it is what narrows the
    // type for the seed call, which `expect(...).toBeTruthy()` does not do.
    if (!devMerchant) throw new Error("no development merchant");
    await seedIntent(devMerchant, {
      publicId: "pi_dash_detail_1",
      amount: "2000000",
      network: "testnet",
      address: "TVdQEadb9Yurh3QCBf1vwjZxNySQvHxFmk",
      clientSecret: "pi_dash_detail_1_secret",
      idempotencyKey: "idem_dash_detail_1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/payment_intents/pi_dash_detail_1?environment=development`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("pi_dash_detail_1");
  });

  test("unknown id -> 404", async () => {
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/payment_intents/pi_does_not_exist?environment=development`,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/dashboard/applications/:applicationId/webhook_deliveries + redeliver", () => {
  test("lists deliveries and redelivers one", async () => {
    // A dedicated intent, NOT a sibling describe block's fixture — see the
    // order-independence note above.
    const devMerchant = await findMerchantByAppEnvironment(
      gatewayDb(),
      APP_ID,
      "development",
    );
    expect(devMerchant).toBeTruthy();
    // Unreachable once the assertion above has passed; it is what narrows the
    // type for the seed calls, which `expect(...).toBeTruthy()` does not do.
    if (!devMerchant) throw new Error("no development merchant");
    const intent = await seedIntent(devMerchant, {
      publicId: "pi_dash_webhook_1",
      amount: "3000000",
      network: "testnet",
      address: "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3",
      clientSecret: "pi_dash_webhook_1_secret",
      idempotencyKey: "idem_dash_webhook_1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const delivery = await seedDelivery(devMerchant, intent, {
      eventId: "evt_dash_0000000000000001",
      eventType: "payment_intent.settled",
      url: "https://merchant.example/hook",
      pending: true,
    });

    const listRes = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/webhook_deliveries?environment=development`,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { id: string }[] };
    expect(listBody.data.some((d) => d.id === delivery.id)).toBe(true);

    const redeliverRes = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/webhook_deliveries/${delivery.id}/redeliver?environment=development`,
      { method: "POST" },
    );
    expect(redeliverRes.status).toBe(200);
    const redeliverBody = (await redeliverRes.json()) as { delivered: boolean };
    expect(redeliverBody.delivered).toBe(true);
    // Redeliver targets the merchant's CURRENT `webhookUrl` (not whatever the
    // fixture set it to initially) — read it fresh rather than asserting a
    // literal, since an earlier PATCH test in this file may have rotated it
    // (order-independence: this must pass regardless of sibling test order).
    const currentMerchant = await findMerchantByAppEnvironment(
      gatewayDb(),
      APP_ID,
      "development",
    );
    // `?? undefined`: `webhook_url` is a nullable COLUMN where the Mongoose
    // field was an optional one, so the expected value's TYPE widened by `null`
    // while its value did not — an unset webhook compares unequal to the
    // captured URL exactly as it did before.
    expect(capturedRedeliverFetches.at(-1)).toBe(currentMerchant?.webhookUrl ?? undefined);
  });

  test("redelivering an unknown delivery id -> 404", async () => {
    // A well-formed id of the shape the table actually mints, so this stays the
    // "exists nowhere" case rather than a malformed-input one.
    const res = await authedFetch(
      `/v1/dashboard/applications/${APP_ID}/webhook_deliveries/${uuidv7()}/redeliver?environment=development`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

describe("no service app credentials at all", () => {
  test("real requireOxyUser default rejects an unauthenticated caller (401)", async () => {
    const app = express();
    app.use(express.json());
    app.use(createDashboardRouter());
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noAuthAddress.port}/v1/dashboard/applications/${APP_ID}/merchant?environment=development`,
      );
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noAuthServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
