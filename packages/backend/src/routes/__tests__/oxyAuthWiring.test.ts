import { test, expect, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createEnrichRouter } from "../enrich";
import { createSocialRouter } from "../social";

/**
 * `createEnrichRouter` / `createSocialRouter` both accept an injectable
 * `requireOxyUser` so the rest of the suite can stub it with a fixed
 * `req.userId`. That stub is never exercised here — this file wires BOTH
 * routers with NO `deps` at all, so each falls back to its real production
 * default (`createOxyAuthMiddleware(oxy)`; see `enrich.ts` / `social.ts`),
 * proving the default itself actually rejects an unauthenticated caller
 * rather than the test's own stub silently standing in for it. Mirrors
 * `serviceAuthWiring.test.ts`'s approach for the merchant/service-auth path.
 *
 * No bearer token is ever sent, so `oxy.middleware.auth({ optional: true })`
 * returns `next()` with no `req.userId` set without making any network call
 * (see `OxyServices.utility.js`'s `auth()` — a missing token short-circuits
 * before any session lookup) — no MongoMemoryServer or `oxy` mocking is
 * needed to observe the resulting 401.
 */
let server: Server;
let baseUrl: string;

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use(createEnrichRouter());
  app.use(createSocialRouter());
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("POST /v1/enrich with no Authorization header is rejected (401) under the real requireOxyUser default", async () => {
  const res = await fetch(`${baseUrl}/v1/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses: ["TAddrA"] }),
  });
  expect(res.status).toBe(401);
});

test("POST /v1/social/:username/next_address with no Authorization header is rejected (401) under the real requireOxyUser default", async () => {
  const res = await fetch(`${baseUrl}/v1/social/alice/next_address`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ network: "testnet" }),
  });
  expect(res.status).toBe(401);
});

test("GET /v1/social/me/cursor with no Authorization header is rejected (401) under the real requireOxyUser default", async () => {
  const res = await fetch(`${baseUrl}/v1/social/me/cursor?network=testnet`);
  expect(res.status).toBe(401);
});
