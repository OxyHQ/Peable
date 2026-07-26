import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxyhq/core/server";
import { TESTNET, mnemonicToSeed, deriveKeyFromSeed } from "@fairco.in/core";
import { createWalletRouter } from "../wallet";
import { resetGatewayTables, useGatewayDatabase } from "../../__tests__/helpers/gatewayTestDatabase";

useGatewayDatabase();

// Watch-only account xpub for the canonical all-"abandon" + "art" testnet
// mnemonic — the same vector `services/__tests__/derivation.test.ts` pins.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const DEVICE_USER = "user_device_owner";

const stubRequireOxyUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = req.header("X-Test-User-Id") ?? DEVICE_USER;
  next();
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createWalletRouter({ requireOxyUser: stubRequireOxyUser }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await resetGatewayTables();
});

async function publish(body: unknown, userId?: string) {
  const res = await fetch(`${baseUrl}/v1/wallet/me/xpub`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(userId ? { "X-Test-User-Id": userId } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { xpub?: string | null; error?: { type: string; message: string } } };
}

async function read(network: string, userId?: string) {
  const res = await fetch(`${baseUrl}/v1/wallet/me/xpub?network=${network}`, {
    headers: { ...(userId ? { "X-Test-User-Id": userId } : {}) },
  });
  return { status: res.status, body: (await res.json()) as { xpub?: string | null } };
}

describe("wallet xpub", () => {
  test("a published key comes back to the same user", async () => {
    expect((await publish({ network: "testnet", xpub: XPUB })).status).toBe(204);
    expect((await read("testnet")).body.xpub).toBe(XPUB);
  });

  test("answers null before any device has published", async () => {
    const { status, body } = await read("testnet");
    expect(status).toBe(200);
    expect(body.xpub).toBeNull();
  });

  /**
   * THE non-custody property, at the route. An `xprv` would give the gateway
   * the ability to spend a user's funds, and it is refused before it is
   * stored — not at first use, because a key nothing ever derives from would
   * otherwise sit in the database unexamined.
   */
  test("refuses an extended key that can sign", async () => {
    const seed = mnemonicToSeed(MNEMONIC);
    const xprv = deriveKeyFromSeed(seed, TESTNET)
      .derive(`m/44'/${TESTNET.bip44CoinType}'/0'`)
      .hdKey.privateExtendedKey;

    const { status, body } = await publish({ network: "testnet", xpub: xprv });
    expect(status).toBe(422);
    expect(body.error?.message).toContain("watch-only");
    // And nothing was stored.
    expect((await read("testnet")).body.xpub).toBeNull();
  });

  test("rejects a string that is not an extended key", async () => {
    expect((await publish({ network: "testnet", xpub: "nonsense" })).status).toBe(422);
  });

  /**
   * One user must never read another's key. An xpub is a total, permanent view
   * of an account's history — leaking one loses no funds and all privacy.
   */
  test("never hands one user another user's key", async () => {
    await publish({ network: "testnet", xpub: XPUB }, "user_a");
    expect((await read("testnet", "user_b")).body.xpub).toBeNull();
  });
});
