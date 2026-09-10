import {
  test,
  expect,
  afterEach,
  describe,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import { eq, sql } from "drizzle-orm";
import { MAINNET, deriveKeyFromSeed, mnemonicToSeed } from "@fairco.in/core";
import type { OxyAuthRequest } from "@oxy.so/core/server";
import { merchants } from "../../db/schema";
import {
  gatewayDb,
  resetGatewayTables,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createMerchantsRouter } from "../merchants";
import { findMerchantByAppEnvironment } from "../../db/merchants/merchantRepository";
import { resolveMerchantDisplay } from "../../services/merchantDisplay";

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic
// (m/44'/1'/0' neutered) — public-key-only, cannot spend.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";

// The same mnemonic's MAINNET-network account xpub (distinct BIP32 version
// bytes from XPUB above) — the non-custody derivation firewall inside
// `insertMerchant` enforces that `xpub`'s encoded network matches `network`,
// so the "production on mainnet" registration test needs a real mainnet xpub.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const MAINNET_XPUB = deriveKeyFromSeed(mnemonicToSeed(MNEMONIC), MAINNET)
  .derive(`m/44'/${MAINNET.bip44CoinType}'/0'`)
  .hdKey.publicExtendedKey;

const DEV_APP_ID = "app_merch_dev";
const PROD_APP_ID = "app_merch_prod";

function stubRequireMerchant(appId: string, environment: string): RequestHandler {
  return (req, _res, next) => {
    (req as OxyAuthRequest).serviceApp = {
      appId,
      appName: "t",
      scopes: ["payments:read", "payments:write"],
      credentialId: "c",
      ownerAccountId: "owner",
      environment: environment as OxyAuthRequest["serviceApp"] extends infer T
        ? T extends { environment: infer E }
          ? E
          : never
        : never,
    };
    next();
  };
}

interface MerchantResponse {
  id: string;
  object: string;
  oxyAppId: string;
  environment: string;
  network: string;
  xpub: string;
  webhookUrl?: string;
  requiredConfirmations: number;
  displayName?: string;
  avatarFileId?: string;
  description?: string;
  error?: { type: string; message: string };
}

async function readJson(res: Response): Promise<MerchantResponse> {
  return (await res.json()) as MerchantResponse;
}

/**
 * `Merchant.countDocuments({ oxyAppId })`'s port. A bare count has no
 * repository function — `findMerchantByAppEnvironment` answers a different
 * question — so this goes through drizzle directly. It throws rather than
 * defaulting when the aggregate returns nothing, so a broken query can never
 * read as "zero merchants persisted", which is the fact both callers assert.
 */
async function countMerchants(oxyAppId: string): Promise<number> {
  const [row] = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(merchants)
    .where(eq(merchants.oxyAppId, oxyAppId));
  if (!row) throw new Error("count(*) returned no row");
  return row.n;
}

useGatewayDatabase();

afterEach(async () => {
  await resetGatewayTables();
});

function createApp(appId: string, environment: string): { app: ReturnType<typeof express>; requireMerchant: RequestHandler } {
  const requireMerchant = stubRequireMerchant(appId, environment);
  const app = express();
  app.use(express.json());
  app.use(createMerchantsRouter({ requireMerchant }));
  return { app, requireMerchant };
}

async function listen(app: ReturnType<typeof express>): Promise<{ server: Server; baseUrl: string }> {
  const s = app.listen(0);
  await new Promise<void>((resolve) => s.once("listening", resolve));
  const address = s.address() as AddressInfo;
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("POST /v1/merchants", () => {
  test("a production credential registers a mainnet merchant (201)", async () => {
    const { app } = createApp(PROD_APP_ID, "production");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "mainnet", xpub: MAINNET_XPUB }),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.id).toMatch(/^merch_[0-9a-f]{24}$/);
      expect(body.object).toBe("merchant");
      expect(body.environment).toBe("production");
      expect(body.network).toBe("mainnet");
      expect(body.requiredConfirmations).toBe(1);
    } finally {
      s.close();
    }
  });

  test("a development credential CANNOT register a mainnet merchant (422) — test/live firewall", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "mainnet", xpub: XPUB }),
      });
      expect(res.status).toBe(422);
      const body = await readJson(res);
      expect(body.error?.type).toBe("invalid_request_error");
      const count = await countMerchants(DEV_APP_ID);
      expect(count).toBe(0);
    } finally {
      s.close();
    }
  });

  test("a development credential registers a testnet merchant (201)", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.environment).toBe("development");
      expect(body.network).toBe("testnet");
    } finally {
      s.close();
    }
  });

  test("a private xprv is rejected by the same non-custody firewall the model enforces (422 or 500-free rejection)", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "testnet",
          // Malformed extended key — the non-custody firewall inside
          // `insertMerchant` must reject this before persisting, regardless of
          // exact string; asserting NOT-201 + NOT-persisted is the load-bearing
          // check.
          xpub: "not-a-real-extended-key",
        }),
      });
      expect(res.status).not.toBe(201);
      const count = await countMerchants(DEV_APP_ID);
      expect(count).toBe(0);
    } finally {
      s.close();
    }
  });

  test("registering twice for the same app+environment collides (409)", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const first = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });
      expect(second.status).toBe(409);
    } finally {
      s.close();
    }
  });

  test("no service app credentials at all -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: (_req, _res, next) => next() }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });
      expect(res.status).toBe(401);
    } finally {
      s.close();
    }
  });

  test("a credential without payments:write is rejected (403 INSUFFICIENT_SCOPE)", async () => {
    const noScopeRequireMerchant: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: DEV_APP_ID,
        appName: "t",
        scopes: [],
        credentialId: "c",
        ownerAccountId: "owner",
        environment: "development",
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: noScopeRequireMerchant }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });
      expect(res.status).toBe(403);
    } finally {
      s.close();
    }
  });
});

describe("GET /v1/merchants/me", () => {
  test("returns the caller's own merchant", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const create = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });
      const created = await readJson(create);

      const res = await fetch(`${url}/v1/merchants/me`);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.id).toBe(created.id);
    } finally {
      s.close();
    }
  });

  test("no merchant registered for this app+environment yet -> 403", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants/me`);
      expect(res.status).toBe(403);
    } finally {
      s.close();
    }
  });

  test("no service app credentials at all -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: (_req, _res, next) => next() }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants/me`);
      expect(res.status).toBe(401);
    } finally {
      s.close();
    }
  });
});

describe("PATCH /v1/merchants/me", () => {
  test("updates webhookUrl and requiredConfirmations", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });

      const res = await fetch(`${url}/v1/merchants/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: "https://merchant.example/new-hook",
          requiredConfirmations: 3,
        }),
      });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.webhookUrl).toBe("https://merchant.example/new-hook");
      expect(body.requiredConfirmations).toBe(3);
      // xpub/network/environment are immutable via this route.
      expect(body.network).toBe("testnet");
    } finally {
      s.close();
    }
  });

  test("xpub is not a field this route accepts — an attempted xpub change is silently ignored", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB }),
      });

      const res = await fetch(`${url}/v1/merchants/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiredConfirmations: 2, xpub: "attempted-change" }),
      });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.xpub).toBe(XPUB);
    } finally {
      s.close();
    }
  });

  test("no service app credentials at all -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(createMerchantsRouter({ requireMerchant: (_req, _res, next) => next() }));
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiredConfirmations: 2 }),
      });
      expect(res.status).toBe(401);
    } finally {
      s.close();
    }
  });
});

describe("merchant branding", () => {
  // Before these fields had a write path, `merchants.display_name`,
  // `avatar_file_id` and `description` were read by `resolveMerchantDisplay`
  // and `enrichAddresses` but written by nothing, so EVERY merchant rendered
  // to a payer as the "Peable merchant" fallback with no logo.
  test("registration persists the branding fields and returns them", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "testnet",
          xpub: XPUB,
          displayName: "Mercaria",
          avatarFileId: "file_mercaria_logo",
          description: "Fair goods, fairly paid for.",
        }),
      });
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.displayName).toBe("Mercaria");
      expect(body.avatarFileId).toBe("file_mercaria_logo");
      expect(body.description).toBe("Fair goods, fairly paid for.");
    } finally {
      s.close();
    }
  });

  test("the payer-facing display resolves to the merchant's own name", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "testnet",
          xpub: XPUB,
          displayName: "Mercaria",
        }),
      });

      const row = await findMerchantByAppEnvironment(gatewayDb(), DEV_APP_ID, "development");
      if (!row) throw new Error("merchant was not registered");
      const display = await resolveMerchantDisplay(row);

      // This string is what the hosted checkout page shows the payer.
      expect(display.name).toBe("Mercaria");
    } finally {
      s.close();
    }
  });

  test("PATCH updates branding, and an explicit null clears it", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB, displayName: "Old" }),
      });

      const patched = await fetch(`${url}/v1/merchants/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "New", description: null }),
      });
      expect(patched.status).toBe(200);
      const body = await readJson(patched);
      expect(body.displayName).toBe("New");
      expect(body.description).toBeUndefined();
    } finally {
      s.close();
    }
  });

  test("an absent branding field leaves the stored value alone", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: "testnet", xpub: XPUB, displayName: "Kept" }),
      });

      // Patching an unrelated field must not blank the name — `null` clears,
      // absent means "leave alone", the same contract webhookUrl already has.
      const patched = await fetch(`${url}/v1/merchants/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiredConfirmations: 3 }),
      });
      const body = await readJson(patched);
      expect(body.displayName).toBe("Kept");
      expect(body.requiredConfirmations).toBe(3);
    } finally {
      s.close();
    }
  });

  test("an over-long displayName is refused (422)", async () => {
    const { app } = createApp(DEV_APP_ID, "development");
    const { server: s, baseUrl: url } = await listen(app);
    try {
      // The columns are bare `text()` with no CHECK, so the route schema is the
      // only thing standing between a merchant and an unbounded write.
      const res = await fetch(`${url}/v1/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "testnet",
          xpub: XPUB,
          displayName: "x".repeat(200),
        }),
      });
      expect(res.status).toBe(422);
    } finally {
      s.close();
    }
  });
});
