import {
  test,
  expect,
  beforeAll,
  afterAll,
  describe,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { OxyAuthRequest } from "@oxy.so/core/server";
import { merchants, paymentIntents } from "../../db/schema";
import { findIntentByPublicId } from "../../db/payments/paymentIntentRepository";
import {
  gatewayDb,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createPaymentIntentsRouter } from "../paymentIntents";

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic
// (m/44'/1'/0' neutered) — public-key-only, cannot spend. Index 0 derives the
// address asserted below.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const FIRST_ADDRESS = "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3";
const TEST_APP_ID = "app_test";

// Test stub for the merchant auth middleware: bypass real Oxy service tokens by
// populating `req.serviceApp` directly (exactly what `oxyClient.serviceAuth()`
// would do after verifying a token).
const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: TEST_APP_ID,
    appName: "t",
    scopes: ["payments:read", "payments:write"],
    credentialId: "c",
    ownerAccountId: "owner",
    environment: "development",
  };
  next();
};

// Test stub for the dual-auth GET route's optional service-auth middleware:
// populates `req.serviceApp` ONLY when an `Authorization` header is present
// (exactly what `oxyClient.auth({ optional: true })` does for a valid
// service token), so both the merchant and payer branches are exercisable.
// Carries `payments:read` so the merchant branch's manual scope check
// (`GET /v1/payment_intents/:id`) passes by default; the dedicated
// missing-scope test below builds its own stub without it.
const stubOptionalServiceAuth: RequestHandler = (req, _res, next) => {
  if (req.header("Authorization")) {
    (req as OxyAuthRequest).serviceApp = {
      appId: TEST_APP_ID,
      appName: "t",
      scopes: ["payments:read"],
      credentialId: "c",
      ownerAccountId: "owner",
      environment: "development",
    };
  }
  next();
};

interface IntentResponse {
  id: string;
  object: string;
  status: string;
  amount: string;
  currency: string;
  network: string;
  address: string;
  merchantId: string;
  txid: string | null;
  confirmations: number;
  clientSecret: string;
  metadata: Record<string, string>;
  client_secret?: string;
  error?: { type: string; message: string };
}

let server: Server;
let baseUrl: string;

async function readJson(res: Response): Promise<IntentResponse> {
  return (await res.json()) as IntentResponse;
}

/**
 * `PaymentIntent.countDocuments({ idempotencyKey })`'s port. `idempotency_key`
 * is internal — absent from every repository's selected columns and from the
 * DTO — so a bare count goes through drizzle directly. It throws rather than
 * defaulting when the aggregate returns nothing, so a broken query cannot read
 * as the zero/one both callers assert.
 */
async function countIntentsByIdempotencyKey(idempotencyKey: string): Promise<number> {
  const [row] = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idempotencyKey));
  if (!row) throw new Error("count(*) returned no row");
  return row.n;
}

async function createIntent(
  idempotencyKey: string,
): Promise<{ status: number; body: IntentResponse }> {
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      amount: "150000000",
      network: "testnet",
      metadata: { orderId: "o1" },
    }),
  });
  return { status: res.status, body: await readJson(res) };
}

useGatewayDatabase();

beforeAll(async () => {
  await seedMerchant({
    publicId: "merch_test0000000000000001",
    oxyAppId: TEST_APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    webhookUrl: "https://example.test/webhook",
    webhookSecret: "whsec_test",
  });

  const app = express();
  app.use(express.json());
  app.use(
    createPaymentIntentsRouter({
      requireMerchant: stubRequireMerchant,
      optionalServiceAuth: stubOptionalServiceAuth,
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

describe("POST /v1/payment_intents", () => {
  test("creates an intent (201) with a pi_ id, derived address and client_secret", async () => {
    // Order-independence: this is the only test in the file that asserts an
    // EXACT derived address (`FIRST_ADDRESS` = index 0 of `XPUB`). The
    // merchant's `nextDerivationIndex` is shared, monotonically-incrementing
    // state that every other intent-creating test also advances, so under
    // `--randomize` a sibling test can reserve index 0 first. Pin the
    // merchant back to a known derivation state right before reserving so
    // this test's outcome never depends on what ran before it.
    await gatewayDb()
      .update(merchants)
      .set({ nextDerivationIndex: 0 })
      .where(
        and(
          eq(merchants.oxyAppId, TEST_APP_ID),
          eq(merchants.environment, "development"),
        ),
      );

    const { status, body } = await createIntent("idem-create-1");

    expect(status).toBe(201);
    expect(body.id).toMatch(/^pi_[0-9a-f]{24}$/);
    expect(body.object).toBe("payment_intent");
    expect(body.status).toBe("created");
    expect(body.amount).toBe("150000000");
    expect(body.currency).toBe("FAIR");
    expect(body.network).toBe("testnet");
    expect(body.address).toBe(FIRST_ADDRESS);
    expect(body.metadata.orderId).toBe("o1");
    expect(body.txid).toBeNull();
    expect(typeof body.client_secret).toBe("string");
    expect(body.client_secret?.startsWith(`${body.id}_secret_`)).toBe(true);
    expect(body.client_secret).toBe(body.clientSecret);
  });

  test("replaying the same Idempotency-Key returns the SAME intent, not a new one", async () => {
    const first = await createIntent("idem-replay");
    const second = await createIntent("idem-replay");

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.address).toBe(first.body.address);

    const count = await countIntentsByIdempotencyKey("idem-replay");
    expect(count).toBe(1);
  });

  test("missing Idempotency-Key → 400", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "150000000", network: "testnet" }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error?.type).toBe("invalid_request_error");
  });

  test("a non-integer amount → 422", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-bad-amount",
      },
      body: JSON.stringify({ amount: "1.5", network: "testnet" }),
    });
    expect(res.status).toBe(422);
  });

  test("network mismatched against the merchant's own network -> 422, no address ever derived", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-network-mismatch",
      },
      body: JSON.stringify({ amount: "150000000", network: "mainnet" }),
    });
    expect(res.status).toBe(422);
    const body = await readJson(res);
    expect(body.error?.type).toBe("invalid_request_error");

    const count = await countIntentsByIdempotencyKey("idem-network-mismatch");
    expect(count).toBe(0);
  });

  test("no service app credentials at all -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: (_req, _res, next) => next(),
        optionalServiceAuth: stubOptionalServiceAuth,
      }),
    );
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noAuthAddress.port}/v1/payment_intents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-create-noauth",
          },
          body: JSON.stringify({ amount: "150000000", network: "testnet" }),
        },
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
        appId: TEST_APP_ID,
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
      createPaymentIntentsRouter({
        requireMerchant: noScopeRequireMerchant,
        optionalServiceAuth: stubOptionalServiceAuth,
      }),
    );
    const noScopeServer = app.listen(0);
    const noScopeAddress = noScopeServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noScopeAddress.port}/v1/payment_intents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-create-noscope",
          },
          body: JSON.stringify({ amount: "150000000", network: "testnet" }),
        },
      );
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noScopeServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("GET /v1/payment_intents/:id", () => {
  test("returns the merchant's own intent (merchant-authed)", async () => {
    const created = await createIntent("idem-get");
    const res = await fetch(`${baseUrl}/v1/payment_intents/${created.body.id}`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.id).toBe(created.body.id);
    expect(body.address).toBe(created.body.address);
  });

  test("merchant-authed, unknown id -> 404", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_intents/pi_does_not_exist`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(res.status).toBe(404);
  });

  test("payer-authed via ?client_secret= query param (no Authorization header)", async () => {
    const created = await createIntent("idem-get-payer-query");
    const res = await fetch(
      `${baseUrl}/v1/payment_intents/${created.body.id}?client_secret=${created.body.client_secret}`,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.id).toBe(created.body.id);
  });

  test("payer-authed via X-Peable-Client-Secret header (no Authorization header)", async () => {
    const created = await createIntent("idem-get-payer-header");
    const res = await fetch(`${baseUrl}/v1/payment_intents/${created.body.id}`, {
      headers: { "X-Peable-Client-Secret": created.body.client_secret ?? "" },
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.id).toBe(created.body.id);
  });

  test("payer path, wrong client_secret -> 403", async () => {
    const created = await createIntent("idem-get-payer-wrong");
    const res = await fetch(
      `${baseUrl}/v1/payment_intents/${created.body.id}?client_secret=pi_wrong_secret`,
    );
    expect(res.status).toBe(403);
  });

  test("no Authorization header and no client_secret -> 401", async () => {
    const created = await createIntent("idem-get-neither");
    const res = await fetch(`${baseUrl}/v1/payment_intents/${created.body.id}`);
    expect(res.status).toBe(401);
  });

  test("merchant-authed WITHOUT payments:read -> 403 (F2.0 gateway-review finding)", async () => {
    const created = await createIntent("idem-get-noscope");
    const noReadScopeOptionalServiceAuth: RequestHandler = (req, _res, next) => {
      if (req.header("Authorization")) {
        (req as OxyAuthRequest).serviceApp = {
          appId: TEST_APP_ID,
          appName: "t",
          scopes: ["payments:write"],
          credentialId: "c",
          ownerAccountId: "owner",
          environment: "development",
        };
      }
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubRequireMerchant,
        optionalServiceAuth: noReadScopeOptionalServiceAuth,
      }),
    );
    const noScopeServer = app.listen(0);
    const noScopeAddress = noScopeServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noScopeAddress.port}/v1/payment_intents/${created.body.id}`,
        { headers: { Authorization: "Bearer test" } },
      );
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noScopeServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  // The payer branch (no Authorization header, authorized by `client_secret`
  // alone) has no service token to scope-check — "payer-authed via
  // ?client_secret=" above already proves it stays 200 regardless of the
  // merchant branch's new `payments:read` gate.
});

describe("POST /v1/payment_intents/:id/submit_tx (payer path)", () => {
  test("the right client_secret sets txid and moves to broadcast", async () => {
    const created = await createIntent("idem-submit-ok");
    const res = await fetch(
      `${baseUrl}/v1/payment_intents/${created.body.id}/submit_tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_secret: created.body.client_secret,
          txid: "a".repeat(64),
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.txid).toBe("a".repeat(64));
    expect(body.status).toBe("broadcast");
  });

  test("a wrong client_secret → 403 and does not mutate the intent", async () => {
    const created = await createIntent("idem-submit-bad");
    const res = await fetch(
      `${baseUrl}/v1/payment_intents/${created.body.id}/submit_tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_secret: "pi_wrong_secret",
          txid: "b".repeat(64),
        }),
      },
    );
    expect(res.status).toBe(403);

    // `created.body.id` is the WIRE id (`pi_…`), which Postgres stores as
    // `public_id` — the internal primary key is a uuid no response carries.
    const reloaded = await findIntentByPublicId(gatewayDb(), created.body.id);
    expect(reloaded?.txid).toBeNull();
    expect(reloaded?.status).toBe("created");
  });
});

describe("POST /v1/payment_intents/:id/reject", () => {
  test("moves the intent to rejected", async () => {
    const created = await createIntent("idem-reject");
    const res = await fetch(
      `${baseUrl}/v1/payment_intents/${created.body.id}/reject`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe("rejected");
  });

  test("no service app credentials at all -> 401", async () => {
    const created = await createIntent("idem-reject-noauth");
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: (_req, _res, next) => next(),
        optionalServiceAuth: stubOptionalServiceAuth,
      }),
    );
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noAuthAddress.port}/v1/payment_intents/${created.body.id}/reject`,
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
    const created = await createIntent("idem-reject-noscope");
    const noScopeRequireMerchant: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: TEST_APP_ID,
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
      createPaymentIntentsRouter({
        requireMerchant: noScopeRequireMerchant,
        optionalServiceAuth: stubOptionalServiceAuth,
      }),
    );
    const noScopeServer = app.listen(0);
    const noScopeAddress = noScopeServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noScopeAddress.port}/v1/payment_intents/${created.body.id}/reject`,
        { method: "POST" },
      );
      expect(res.status).toBe(403);

      // The WIRE id again — `public_id` in Postgres, not the primary key.
      const reloaded = await findIntentByPublicId(gatewayDb(), created.body.id);
      expect(reloaded?.status).toBe("created");
    } finally {
      await new Promise<void>((resolve, reject) => {
        noScopeServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("GET /v1/payment_intents (list)", () => {
  test("lists the merchant's own intents, newest first, respecting limit", async () => {
    await createIntent("idem-list-1");
    await createIntent("idem-list-2");
    await createIntent("idem-list-3");

    const res = await fetch(`${baseUrl}/v1/payment_intents?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: IntentResponse[]; has_more: boolean };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
    expect(body.has_more).toBe(true);
  });

  test("filters by status", async () => {
    const created = await createIntent("idem-list-status");
    await fetch(`${baseUrl}/v1/payment_intents/${created.body.id}/reject`, { method: "POST" });

    const res = await fetch(`${baseUrl}/v1/payment_intents?status=rejected`);
    const body = (await res.json()) as { data: IntentResponse[] };
    expect(body.data.every((intent) => intent.status === "rejected")).toBe(true);
    expect(body.data.some((intent) => intent.id === created.body.id)).toBe(true);
  });

  test("paginates via starting_after", async () => {
    const first = await createIntent("idem-page-1");
    const second = await createIntent("idem-page-2");

    const page1 = await fetch(`${baseUrl}/v1/payment_intents?limit=1`);
    const page1Body = (await page1.json()) as { data: IntentResponse[] };
    expect(page1Body.data[0]?.id).toBe(second.body.id);

    const page2 = await fetch(
      `${baseUrl}/v1/payment_intents?limit=1&starting_after=${page1Body.data[0]?.id}`,
    );
    const page2Body = (await page2.json()) as { data: IntentResponse[] };
    // Newest-first primary-key sort + a `<`-on-the-primary-key cursor:
    // `second` was created immediately after `first` with no interleaving
    // creates, so the next row strictly older than `second` is `first` itself.
    // The key is a uuid v7, whose ordering is only millisecond-resolved — two
    // rows minted inside one millisecond sort arbitrarily — and each create
    // here is a separate HTTP round trip, so they never share one.
    expect(page2Body.data[0]?.id).toBe(first.body.id);
  });

  test("an unknown starting_after -> 422", async () => {
    const res = await fetch(`${baseUrl}/v1/payment_intents?starting_after=pi_does_not_exist`);
    expect(res.status).toBe(422);
  });

  test("no service app credentials at all -> 401", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: (_req, _res, next) => next(),
        optionalServiceAuth: stubOptionalServiceAuth,
      }),
    );
    const noAuthServer = app.listen(0);
    const noAuthAddress = noAuthServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${noAuthAddress.port}/v1/payment_intents`,
      );
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        noAuthServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
