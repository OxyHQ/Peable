import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { oxyClient } from "@oxy.so/core";
import { loadConfig } from "../../config";
import {
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createPaymentIntentsRouter } from "../paymentIntents";

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic —
// public-key-only, cannot spend. Same fixture used across the rest of the suite.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const TEST_SECRET = "gateway-wiring-test-secret";
const APP_ID = "app_wiring";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mints an HS256 JWT byte-identical in shape to what `POST /auth/service-token`
// (OxyHQServices `routes/auth.ts`) produces post-Task-2: `type`, `iss`, `aud`,
// `environment` all present.
function signRealServiceToken(claims: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    type: "service",
    iss: "oxy-auth",
    aud: "oxy-api",
    credentialId: "cred_wiring",
    ownerAccountId: "acct_wiring",
    environment: "development",
    ...claims,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${headerB64}.${payloadB64}.${signature}`;
}

let server: Server;
let baseUrl: string;

useGatewayDatabase();

beforeAll(async () => {
  await seedMerchant({
    publicId: "merch_test0000000000000001",
    oxyAppId: APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
  });

  // `loadConfig` is handed an EXPLICIT env rather than `process.env`, so it
  // does not inherit `DATABASE_URL` — which the Postgres-native config now
  // requires. It is passed through from the ambient environment (the same one
  // this file's `import "../../config"` already loads at module scope) because
  // this test's subject is `serviceJwtSecret` and nothing here opens a pool
  // from this config object.
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    OXY_ACCESS_TOKEN_SECRET: TEST_SECRET,
  });
  const requireMerchant = oxyClient.serviceAuth({ jwtSecret: config.serviceJwtSecret });
  const optionalServiceAuth = oxyClient.auth({ jwtSecret: config.serviceJwtSecret, optional: true });

  const app = express();
  app.use(express.json());
  app.use(createPaymentIntentsRouter({ requireMerchant, optionalServiceAuth }));
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("a genuinely HMAC-signed service token minted with the configured secret is accepted", async () => {
  const token = signRealServiceToken(
    { appId: APP_ID, appName: "wiring-test", scopes: ["payments:write"] },
    TEST_SECRET,
  );
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "wiring-1",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: "1000000", network: "testnet" }),
  });
  expect(res.status).toBe(201);
});

test("a token signed with the WRONG secret is rejected (401) — proves jwtSecret is really wired, not bypassed", async () => {
  const token = signRealServiceToken({ appId: APP_ID, appName: "wiring-test" }, "some-other-secret");
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "wiring-2",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: "1000000", network: "testnet" }),
  });
  expect(res.status).toBe(401);
});

test("no Authorization header at all is rejected (401), the endpoint is not silently open", async () => {
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "wiring-3" },
    body: JSON.stringify({ amount: "1000000", network: "testnet" }),
  });
  expect(res.status).toBe(401);
});
