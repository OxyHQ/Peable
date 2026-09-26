/**
 * A development credential must not reach a live key — end to end, over HTTP.
 *
 * ## What the gateway already had, and why it was not enough
 *
 * `merchants` is unique on `(oxy_app_id, environment)` and `resolveMerchant`
 * resolves by both, so a development service token and a production one address
 * DIFFERENT merchant rows. That is isolation of data.
 *
 * The provider is not resolved per merchant. `resolveProvider` answers with one
 * process-wide adapter built from one `STRIPE_SECRET_KEY`, and no code between
 * the resolved merchant and that adapter ever compared the two. So on a
 * deployment holding a live key, a `development` credential — the weaker one,
 * which is the entire reason two exist — created LIVE payment intents, refunds,
 * transfers and connected accounts.
 *
 * ## What this file drives
 *
 * The real routers, mounted on a real express app, against a real database,
 * with the config mutated to hold a LIVE key and a provider fake that RECORDS
 * every call. The assertion is two-part and the second half is the one that
 * matters: the request is refused with 403, AND the fake was never called. A
 * refusal that happens after the provider call is not isolation, it is a
 * confusing error message on top of a live charge.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

const providerCalls: string[] = [];

const fakeProvider = {
  id: "stripe" as const,
  createPayment: async () => {
    providerCalls.push("createPayment");
    return { providerObjectId: "pi_live_should_not_exist", status: "created" as const };
  },
  capture: async () => {
    providerCalls.push("capture");
    throw new Error("not used");
  },
  cancel: async () => {
    providerCalls.push("cancel");
    throw new Error("not used");
  },
  refund: async () => {
    providerCalls.push("refund");
    throw new Error("not used");
  },
  getStatus: async () => {
    providerCalls.push("getStatus");
    throw new Error("not used");
  },
  verifyEvent: async () => {
    throw new Error("not used");
  },
  createTransfer: async () => {
    providerCalls.push("createTransfer");
    throw new Error("not used");
  },
  reverseTransfer: async () => {
    providerCalls.push("reverseTransfer");
    throw new Error("not used");
  },
  createAccount: async () => {
    providerCalls.push("createAccount");
    throw new Error("not used");
  },
  accountLink: async () => {
    providerCalls.push("accountLink");
    throw new Error("not used");
  },
  getAccount: async () => {
    providerCalls.push("getAccount");
    throw new Error("not used");
  },
};

/**
 * The registry, faked — but inert outside this file.
 *
 * `mock.module` is process-global in bun and survives `mock.restore()`, and
 * bun's file order is not alphabetical, so an unconditional mock here would
 * hand a fake adapter to every other suite in either direction. The delegation
 * flag is what keeps it local; the same idiom `cardCreate.realdb.test.ts`
 * documents, and for the same measured reason.
 */
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = await import("../../services/providers/registry");
let useFakeRegistry = false;

mock.module("../../services/providers/registry", () => ({
  resolveProvider: (id: "stripe") => (useFakeRegistry ? fakeProvider : realResolveProvider(id)),
  resolveCardProvider: () => (useFakeRegistry ? fakeProvider : realResolveCardProvider()),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { config } = await import("../../config");
const { createPaymentIntentsRouter } = await import("../paymentIntents");
const { createRefundsRouter } = await import("../refunds");
const { createTransfersRouter } = await import("../transfers");
const { createConnectedAccountsRouter } = await import("../connectedAccounts");
const { createCheckoutSessionsRouter } = await import("../checkoutSessions");
const { seedIntent, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");

const APP_ID = "app_environment_isolation";

/** Every request in this file arrives with a DEVELOPMENT credential. */
const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: "t",
    scopes: ["payments:read", "payments:write"],
    credentialId: "c",
    ownerAccountId: "owner",
    environment: "development",
    tier: "external",
  };
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();

let server: Server;
let baseUrl: string;
let liveModeRestore: boolean;

interface ErrorBody {
  readonly error?: { readonly type: string; readonly message: string };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ErrorBody };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)(
  "a development credential on a live deployment",
  () => {
    useGatewayDatabase();

    beforeAll(async () => {
      useFakeRegistry = true;
      // The deployment now holds a LIVE key. Mutated rather than set through
      // the environment because `config.ts` snapshots `process.env` once at
      // import time and `bun test` runs every file in one process.
      liveModeRestore = config.stripe.livemode;
      (config.stripe as { livemode: boolean }).livemode = true;

      const merchant = await seedMerchant({
        oxyAppId: APP_ID,
        environment: "development",
      });
      // A settled card payment for the refund and transfer paths to name.
      await seedIntent(merchant, {
        publicId: "pi_env_isolation",
        rail: "card",
        currency: "EUR",
        amount: "5000",
      });

      const app = express();
      app.use(express.json());
      app.use(
        createPaymentIntentsRouter({
          requireMerchant: stubRequireMerchant,
          optionalServiceAuth: passthrough,
        }),
      );
      app.use(createRefundsRouter({ requireMerchant: stubRequireMerchant }));
      app.use(createTransfersRouter({ requireMerchant: stubRequireMerchant }));
      app.use(createConnectedAccountsRouter({ requireMerchant: stubRequireMerchant }));
      app.use(
        createCheckoutSessionsRouter({
          requireMerchant: stubRequireMerchant,
          publicRateLimit: passthrough,
        }),
      );
      server = app.listen(0);
      baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      providerCalls.length = 0;
    });

    afterAll(async () => {
      (config.stripe as { livemode: boolean }).livemode = liveModeRestore;
      useFakeRegistry = false;
      await new Promise<void>((resolve) => server.close(() => {
        resolve();
      }));
    });

    test("cannot create a card payment intent", async () => {
      const { status, body } = await post(
        "/v1/payment_intents",
        { amount: "5000", rail: "card", currency: "EUR" },
        { "Idempotency-Key": "env-iso-1" },
      );
      expect(status).toBe(403);
      expect(body.error?.type).toBe("permission_error");
      expect(body.error?.message).toContain("live mode");
      expect(providerCalls).toEqual([]);
    });

    test("cannot create a card checkout session", async () => {
      const { status } = await post("/v1/checkout_sessions", {
        amount: "5000",
        rail: "card",
        currency: "EUR",
      });
      expect(status).toBe(403);
      expect(providerCalls).toEqual([]);
    });

    test("cannot open a connected account", async () => {
      // The least recoverable of the five: a connected account cannot be
      // deleted, so one opened in live mode by a development credential leaves
      // a real Express account behind, emailing a real person about
      // requirements, forever.
      const { status } = await post("/v1/connected_accounts", {
        externalRef: "seller-1",
        country: "ES",
        businessType: "individual",
      });
      expect(status).toBe(403);
      expect(providerCalls).toEqual([]);
    });

    test("cannot refund", async () => {
      const { status } = await post("/v1/refunds", {
        paymentIntentId: "pi_env_isolation",
        externalRef: "refund-1",
        amount: "100",
      });
      expect(status).toBe(403);
      expect(providerCalls).toEqual([]);
    });

    test("cannot settle a seller out of a payment", async () => {
      const { status } = await post("/v1/transfers", {
        paymentIntentId: "pi_env_isolation",
        connectedAccountRef: "seller-1",
        externalRef: "order-1",
        amount: "100",
      });
      expect(status).toBe(403);
      expect(providerCalls).toEqual([]);
    });

    /**
     * A FAIRCOIN intent is not refused, and that is the point of the guard
     * being on the card path rather than on the router.
     *
     * The chain rail has no provider, no key and no mode — a testnet payment is
     * already a different network, enforced by the merchant's own `network`
     * column. Refusing it here would break every FairCoin merchant on a
     * deployment that happens to hold a live Stripe key.
     */
    test("but a FairCoin intent still mints", async () => {
      const { status } = await post(
        "/v1/payment_intents",
        { amount: "100000000", network: "testnet" },
        { "Idempotency-Key": "env-iso-faircoin" },
      );
      expect(status).toBe(201);
      expect(providerCalls).toEqual([]);
    });
  },
);
