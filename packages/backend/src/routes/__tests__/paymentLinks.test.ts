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
import type { MerchantRow } from "../../db/merchants/merchantRepository";
import { updatePaymentLink } from "../../db/payments/paymentLinkRepository";
import {
  gatewayDb,
  seedLink,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createPaymentLinksRouter } from "../paymentLinks";

const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const APP_ID = "app_paylinks";

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

// No-op stand-in for the real `createOxyRateLimit` instance — the rate-limit
// budget itself is exercised where it's wired (`server.ts`), not per-route.
const passthroughRateLimit: RequestHandler = (_req, _res, next) => next();

interface PaymentLinkResponse {
  id: string;
  object: string;
  amount: string;
  network: string;
  active: boolean;
  metadata: Record<string, string>;
  successUrl?: string;
  url: string;
  error?: { type: string; message: string };
}

interface PublicPaymentLinkResponse {
  id: string;
  object: string;
  amount: string;
  currency: string;
  rail: string;
  network: string;
  active: boolean;
  merchant: { name: string; avatarUrl: string | null; description: string | null };
  error?: { type: string; message: string };
}

interface IntentResponse {
  id: string;
  status: string;
  amount: string;
  network: string;
  address: string;
  merchantId: string;
  metadata: Record<string, string>;
  client_secret?: string;
  error?: { type: string; message: string };
}

let server: Server;
let baseUrl: string;
let merchant: MerchantRow;
let merchantId: string;

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * A bare `count(*)` of one merchant's intents. No repository function answers
 * it — nothing in production needs the number — so the "mints nothing" case
 * below reads it straight off the table.
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
  merchant = await seedMerchant({
    publicId: "merch_test_paylinks_1",
    oxyAppId: APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
  });
  // `displayName` is not an `insertMerchant`/`seedMerchant` parameter — it has
  // no registration route, only a column — and the public link DTO renders it.
  // Set directly so the assertion that reads it back stays as it was.
  await gatewayDb()
    .update(merchants)
    .set({ displayName: "Paylinks Co" })
    .where(eq(merchants.id, merchant.id));
  merchantId = merchant.id;

  const app = express();
  app.use(express.json());
  app.use(
    createPaymentLinksRouter({
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

describe("POST /v1/payment_links", () => {
  test("creates a link (201) with a link_ id and a checkout.peable.to URL", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "200000000",
        network: "testnet",
        metadata: { sku: "sku_1" },
        successUrl: "https://merchant.example/thanks",
      }),
    });
    expect(res.status).toBe(201);
    const body = await readJson<PaymentLinkResponse>(res);
    expect(body.id).toMatch(/^link_[0-9a-f]+$/);
    expect(body.object).toBe("payment_link");
    expect(body.amount).toBe("200000000");
    expect(body.active).toBe(true);
    expect(body.metadata).toEqual({ sku: "sku_1" });
    expect(body.successUrl).toBe("https://merchant.example/thanks");
    expect(body.url).toBe(`https://checkout.peable.to/l/${body.id}`);
  });

  test("a network that doesn't match the merchant's configured network -> 422", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "100000000", network: "mainnet" }),
    });
    expect(res.status).toBe(422);
    const body = await readJson<PaymentLinkResponse>(res);
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("no service app credentials -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentLinksRouter({
        requireMerchant: (_req, _res, next) => next(),
        publicRateLimit: passthroughRateLimit,
      }),
    );
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${noAuthAddress.port}/v1/payment_links`, {
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

  test("a credential without payments:write -> 403", async () => {
    const readOnly: RequestHandler = (req, _res, next) => {
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
      createPaymentLinksRouter({
        requireMerchant: readOnly,
        publicRateLimit: passthroughRateLimit,
      }),
    );
    const readOnlyServer = app.listen(0);
    const readOnlyAddress = readOnlyServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${readOnlyAddress.port}/v1/payment_links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: "100000000", network: "testnet" }),
      });
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        readOnlyServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("GET/PATCH /v1/payment_links (merchant CRUD)", () => {
  test("list -> retrieve -> patch round trip", async () => {
    const createRes = await fetch(`${baseUrl}/v1/payment_links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "50000000", network: "testnet" }),
    });
    const created = await readJson<PaymentLinkResponse>(createRes);

    const listRes = await fetch(`${baseUrl}/v1/payment_links`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { object: string; data: PaymentLinkResponse[] };
    expect(list.object).toBe("list");
    expect(list.data.some((link) => link.id === created.id)).toBe(true);

    const getRes = await fetch(`${baseUrl}/v1/payment_links/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await readJson<PaymentLinkResponse>(getRes);
    expect(fetched.id).toBe(created.id);

    const patchRes = await fetch(`${baseUrl}/v1/payment_links/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false, metadata: { note: "paused" } }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await readJson<PaymentLinkResponse>(patchRes);
    expect(patched.active).toBe(false);
    expect(patched.metadata).toEqual({ note: "paused" });
    // amount/network are never accepted by PATCH — immutable once shared.
    expect(patched.amount).toBe(created.amount);
  });

  test("PATCH ignores amount/network even if sent (whitelist, not just unvalidated passthrough)", async () => {
    const createRes = await fetch(`${baseUrl}/v1/payment_links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "77000000", network: "testnet" }),
    });
    const created = await readJson<PaymentLinkResponse>(createRes);

    const patchRes = await fetch(`${baseUrl}/v1/payment_links/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "999999999", network: "mainnet" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await readJson<PaymentLinkResponse>(patchRes);
    expect(patched.amount).toBe("77000000");
    expect(patched.network).toBe("testnet");
  });

  test("unknown id -> 404", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_links/link_doesnotexist`);
    expect(res.status).toBe(404);
  });

  test("a link belonging to a different merchant -> 404 (never leaks cross-tenant)", async () => {
    const otherMerchant = await seedMerchant({
      publicId: "merch_test_paylinks_other",
      oxyAppId: "app_paylinks_other",
      environment: "development",
      network: "testnet",
      xpub: XPUB,
    });
    const otherLink = await seedLink(otherMerchant, {
      publicId: "link_other_owner",
      amount: "10000000",
      network: "testnet",
      metadata: {},
    });
    const res = await fetch(`${baseUrl}/v1/payment_links/${otherLink.publicId}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/payment_links/:id/public", () => {
  test("returns merchant display, never metadata/successUrl/internal ids", async () => {
    const link = await seedLink(merchant, {
      publicId: "link_public_display",
      amount: "300000000",
      network: "testnet",
      metadata: { secretNote: "should not leak" },
      successUrl: "https://merchant.example/private-thanks",
    });

    const res = await fetch(`${baseUrl}/v1/payment_links/${link.publicId}/public`);
    expect(res.status).toBe(200);
    const body = await readJson<PublicPaymentLinkResponse>(res);
    expect(body).toEqual({
      id: "link_public_display",
      object: "payment_link",
      amount: "300000000",
      // `currency` and `rail` are new on this DTO (ADR 0001 D4/D1) and belong
      // in an exact-shape assertion: a payer page that renders an amount
      // without knowing its currency is the bug this test's `toEqual` exists
      // to catch.
      currency: "FAIR",
      rail: "faircoin",
      network: "testnet",
      active: true,
      merchant: {
        name: "Paylinks Co",
        avatarUrl: null,
        description: null,
      },
    });
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("successUrl");
  });

  test("an inactive link still resolves (200, active:false) so the page can show a disabled state", async () => {
    const link = await seedLink(merchant, {
      publicId: "link_public_inactive",
      amount: "10000000",
      network: "testnet",
      metadata: {},
    });
    // `active` takes its column default of true on insert — `insertPaymentLink`
    // deliberately has no parameter for it — so the disabled state is applied
    // through the same patch a merchant would use.
    await updatePaymentLink(gatewayDb(), link.publicId, merchant.id, { active: false });

    const res = await fetch(`${baseUrl}/v1/payment_links/${link.publicId}/public`);
    expect(res.status).toBe(200);
    const body = await readJson<PublicPaymentLinkResponse>(res);
    expect(body.active).toBe(false);
  });

  test("unknown link id -> 404", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_links/link_doesnotexist/public`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/payment_links/:id/payment_intent", () => {
  test("mints a fresh intent bound to the link's merchant + amount + network, ignoring any caller override", async () => {
    const link = await seedLink(merchant, {
      publicId: "link_mint_ok",
      amount: "123000000",
      network: "testnet",
      metadata: { orderId: "o_mint" },
    });

    const res = await fetch(`${baseUrl}/v1/payment_links/${link.publicId}/payment_intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A public caller may never override amount/network/merchant — these
      // must be silently ignored, not merely rejected.
      body: JSON.stringify({ amount: "1", network: "mainnet", merchantId: "merch_other" }),
    });
    expect(res.status).toBe(201);
    const body = await readJson<IntentResponse>(res);
    expect(body.amount).toBe("123000000");
    expect(body.network).toBe("testnet");
    expect(body.merchantId).toBe(merchantId);
    expect(body.metadata).toEqual({ orderId: "o_mint" });
    expect(body.status).toBe("created");
    expect(typeof body.address).toBe("string");
    expect(body.client_secret).toStartWith(`${body.id}_secret_`);
  });

  test("each mint call creates a DISTINCT intent (server always mints fresh; reuse-if-open is a page-layer concern)", async () => {
    const link = await seedLink(merchant, {
      publicId: "link_mint_fresh_each_time",
      amount: "5000000",
      network: "testnet",
      metadata: {},
    });

    const first = await readJson<IntentResponse>(
      await fetch(`${baseUrl}/v1/payment_links/${link.publicId}/payment_intent`, { method: "POST" }),
    );
    const second = await readJson<IntentResponse>(
      await fetch(`${baseUrl}/v1/payment_links/${link.publicId}/payment_intent`, { method: "POST" }),
    );
    expect(first.id).not.toBe(second.id);
  });

  test("an inactive link -> 422, mints nothing", async () => {
    const link = await seedLink(merchant, {
      publicId: "link_mint_inactive",
      amount: "5000000",
      network: "testnet",
      metadata: {},
    });
    // See `link_public_inactive` above: `active` is a column default on insert,
    // so the disabled state comes from the patch path.
    await updatePaymentLink(gatewayDb(), link.publicId, merchant.id, { active: false });

    const before = await countIntentsForMerchant(merchantId);
    const res = await fetch(`${baseUrl}/v1/payment_links/${link.publicId}/payment_intent`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    const after = await countIntentsForMerchant(merchantId);
    expect(after).toBe(before);
  });

  test("unknown link id -> 404", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_links/link_doesnotexist/payment_intent`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
