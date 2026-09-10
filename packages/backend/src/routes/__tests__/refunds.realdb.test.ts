/**
 * The refund API over HTTP.
 *
 * The service suite covers the arithmetic; this covers what the route adds —
 * merchant scoping, the body it refuses, and the two status codes that tell a
 * merchant whether they just refunded a payer twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

let refundCounter = 0;
const providerCalls: string[] = [];

const fakeProvider = {
  id: "stripe" as const,
  refund: async () => {
    providerCalls.push("refund");
    refundCounter += 1;
    return {
      providerObjectId: `re_stripe_${String(refundCounter)}`,
      status: "partially_refunded",
      state: "succeeded",
    };
  },
  createPayment: async () => {
    throw new Error("not used");
  },
  capture: async () => {
    throw new Error("not used");
  },
  cancel: async () => {
    throw new Error("not used");
  },
  getStatus: async () => {
    throw new Error("not used");
  },
  verifyEvent: async () => {
    throw new Error("not used");
  },
};

const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = await import("../../services/providers/registry");
let useFake = false;

mock.module("../../services/providers/registry", () => ({
  resolveProvider: (id: "stripe") => (useFake ? fakeProvider : realResolveProvider(id)),
  resolveCardProvider: () => (useFake ? fakeProvider : realResolveCardProvider()),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { createRefundsRouter } = await import("../refunds");
const { insertPaymentIntent, linkProviderObject, updateIntentState } = await import(
  "../../db/payments/paymentIntentRepository"
);
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");
const { uuidv7 } = await import("@oxy.so/db");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let otherMerchant: Merchant;
let server: Server | undefined;
let baseUrl = "";
let actingApp = "";
let counter = 0;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function settledIntent(amount: string): Promise<string> {
  counter += 1;
  const publicId = `pi_route_refund_${String(counter)}`;
  const intent = await insertPaymentIntent(gatewayDb(), {
    publicId,
    merchantId: merchant.id,
    rail: "card",
    amount,
    currency: "EUR",
    network: null,
    address: null,
    provider: "stripe",
    clientSecret: "cs_x",
    idempotencyKey: uuidv7(),
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
  });
  if (!intent) throw new Error("could not seed the intent");
  await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_route_${String(counter)}`);
  await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });
  return publicId;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("the refund API", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();
    otherMerchant = await seedMerchant();
    actingApp = merchant.oxyAppId;

    const stubMerchantAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: actingApp,
        appName: "t",
        scopes: ["payments:read", "payments:write"],
        credentialId: "c",
        ownerAccountId: "acct_refunds",
        environment: "development",
      };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createRefundsRouter({ requireMerchant: stubMerchantAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    actingApp = merchant.oxyAppId;
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        resolve();
      });
    });
  });

  test("refunds a payment and reports the public ids only", async () => {
    const pi = await settledIntent("10000");
    const { status, json } = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_r1",
      amount: "2500",
    });

    expect(status).toBe(201);
    expect(json.object).toBe("refund");
    expect(json.paymentIntentId).toBe(pi);
    expect(json.status).toBe("succeeded");
    // The provider's own refund id is not the merchant's business.
    expect(JSON.stringify(json)).not.toContain("re_stripe");
  });

  /**
   * A merchant retrying a refund needs to know whether they just sent the payer
   * money twice. They did not, and the 200 says so.
   */
  test("a repeated refund answers 200 and calls the provider once", async () => {
    const pi = await settledIntent("10000");
    const first = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_dup",
      amount: "2500",
    });
    providerCalls.length = 0;
    const second = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_dup",
      amount: "2500",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * The retry answers from HISTORY. Checking the remaining balance first would
   * refuse it — because this very refund is what consumed the balance.
   */
  test("answers a retry even though the balance no longer accommodates it", async () => {
    const pi = await settledIntent("1000");
    const first = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_exhaust",
      amount: "1000",
    });
    expect(first.status).toBe(201);

    const retry = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_exhaust",
      amount: "1000",
    });
    expect(retry.status).toBe(200);
    expect(retry.json.id).toBe(first.json.id);
  });

  /**
   * `'0'` is a canonical integer string and passes the shared predicate, so it
   * is refused separately — a zero refund would consume the merchant's
   * `externalRef` and make the REAL refund for that order impossible to create.
   */
  test("refuses a zero refund, which the amount predicate alone would accept", async () => {
    const pi = await settledIntent("10000");
    const { status, json } = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_zero",
      amount: "0",
    });
    expect(status).toBe(422);
    expect(String((json.error as Record<string, string>).message)).toContain("not a refund");
  });

  test("refuses an amount that is not a canonical base-unit integer", async () => {
    const pi = await settledIntent("10000");
    for (const amount of ["10.50", "-1", "01", ""]) {
      const { status } = await call("POST", "/v1/refunds", {
        paymentIntentId: pi,
        externalRef: `order_bad_${amount || "empty"}`,
        amount,
      });
      expect([amount, status]).toEqual([amount, 422]);
    }
  });

  test("refuses more than the payment has left", async () => {
    const pi = await settledIntent("1000");
    const { status } = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_over",
      amount: "1001",
    });
    expect(status).toBe(422);
  });

  /**
   * The remaining figure is offered so a merchant does not compute it by
   * summing the list — and get it wrong by counting a `pending` or `failed`
   * refund that moved no money.
   */
  test("lists the refunds and what is still refundable", async () => {
    const pi = await settledIntent("10000");
    await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_list",
      amount: "4000",
    });

    const { status, json } = await call("GET", `/v1/payment_intents/${pi}/refunds`);
    expect(status).toBe(200);
    expect((json.data as unknown[]).length).toBe(1);
    expect(json.remainingRefundable).toBe("6000");
  });

  test("does not refund, read or list across merchants", async () => {
    const pi = await settledIntent("10000");
    actingApp = otherMerchant.oxyAppId;

    const refund = await call("POST", "/v1/refunds", {
      paymentIntentId: pi,
      externalRef: "order_cross",
      amount: "100",
    });
    const list = await call("GET", `/v1/payment_intents/${pi}/refunds`);

    // ONE 404 for both "does not exist" and "is not yours": distinguishing them
    // tells a caller whether another merchant's `pi_…` is real.
    expect(refund.status).toBe(404);
    expect(list.status).toBe(404);
  });
});
