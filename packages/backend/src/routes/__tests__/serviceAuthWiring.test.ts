import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { OxyServices } from "@oxy.so/core";
import {
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { createPaymentIntentsRouter } from "../paymentIntents";

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic —
// public-key-only, cannot spend. Same fixture used across the rest of the suite.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const APP_ID = "app_wiring";
const KID = "wiring-test-key";

// Oxy signs service tokens with Ed25519 under a published kid (oxy ADR 0012).
// This stands in for oxy-api: it serves the public half at the SAME path the
// SDK derives from its base URL, and mints with the private half.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// A second key, never published: a token it signs must not verify.
const { privateKey: strangerKey } = generateKeyPairSync("ed25519");

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function servicePayload(claims: Record<string, unknown>): string {
  return b64url(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      type: "service",
      iss: "oxy-auth",
      aud: "oxy-api",
      credentialId: "cred_wiring",
      ownerAccountId: "acct_wiring",
      environment: "development",
      ...claims,
    }),
  );
}

// Shaped like what `POST /auth/service-token` mints: EdDSA, `typ`, `kid`.
function signServiceToken(
  claims: Record<string, unknown>,
  key: typeof privateKey = privateKey,
): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: KID }));
  const payload = servicePayload(claims);
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

// The retired shape: HS256 over a shared secret. Nothing in Peable holds that
// secret any more, and no secret should make one of these acceptable.
function signLegacyHs256Token(claims: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = servicePayload(claims);
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

let jwksServer: Server;
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

  const jwks = express();
  jwks.get("/.well-known/jwks.json", (_req, res) => {
    res.json({ keys: [{ ...publicKey.export({ format: "jwk" }), use: "sig", alg: "EdDSA", kid: KID }] });
  });
  jwksServer = jwks.listen(0);
  const oxyApi = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;

  // The same calls `server.ts` makes, with no options: verification is the
  // JWKS at the client's base URL and nothing else. A fresh client rather than
  // the `oxyClient` singleton, so its key cache is this file's alone.
  const oxy = new OxyServices({ baseURL: oxyApi });
  const requireMerchant = oxy.serviceAuth();
  const optionalServiceAuth = oxy.auth({ optional: true });

  const app = express();
  app.use(express.json());
  app.use(createPaymentIntentsRouter({ requireMerchant, optionalServiceAuth }));
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const s of [server, jwksServer]) {
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("an EdDSA service token signed by a key in Oxy's JWKS is accepted", async () => {
  const token = signServiceToken({ appId: APP_ID, appName: "wiring-test", scopes: ["payments:write"] });
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

test("a token signed by a key NOT in the JWKS is rejected (401) — proves verification is really wired, not bypassed", async () => {
  const token = signServiceToken({ appId: APP_ID, appName: "wiring-test" }, strangerKey);
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

test("a retired HS256 service token is refused, whatever secret signed it", async () => {
  const token = signLegacyHs256Token(
    { appId: APP_ID, appName: "wiring-test", scopes: ["payments:write"] },
    "any-shared-secret",
  );
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "wiring-4",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: "1000000", network: "testnet" }),
  });
  // 403 on core 1.x (no legacy secret configured), 401 on core 2.x (no HS256
  // branch at all). Either way the request never reaches the handler.
  expect([401, 403]).toContain(res.status);
});

test("no Authorization header at all is rejected (401), the endpoint is not silently open", async () => {
  const res = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "wiring-3" },
    body: JSON.stringify({ amount: "1000000", network: "testnet" }),
  });
  expect(res.status).toBe(401);
});
