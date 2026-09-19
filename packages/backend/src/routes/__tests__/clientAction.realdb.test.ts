/**
 * Resuming a card payment — the operation the payer never had.
 *
 * The payment-intent DTO deliberately carries no client action: a client secret
 * is a confirmation credential, and putting one on that shape hands it out on
 * every list and every re-read. The cost was that there was no way back to a
 * payment in progress. A payer who refreshed the page, returned from an SCA
 * challenge in a new tab, or came back the next day had nothing to confirm
 * with, and the only way to get one was to create a SECOND payment — which
 * Mercaria's own adapter does: its `resumePayment` re-reads the intent
 * expecting `client_action` and finds nothing there.
 *
 * Two surfaces close it, and the difference between them is the subject of
 * half this file: the merchant's single read carries it, the payer asks for it
 * explicitly, and the polled payer read never does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

let statusToReport = "created";

const fakeProvider = {
  id: "stripe" as const,
  getStatus: async (providerObjectId: string) => ({
    providerObjectId,
    status: statusToReport,
    clientAction: { kind: "client_secret" as const, value: `${providerObjectId}_secret_live` },
  }),
  createPayment: async () => {
    throw new Error("not used");
  },
  capture: async () => {
    throw new Error("not used");
  },
  cancel: async () => {
    throw new Error("not used");
  },
  refund: async () => {
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

const { config } = await import("../../config");
const { createPaymentIntentsRouter } = await import("../paymentIntents");
const { insertPaymentIntent, linkProviderObject, updateIntentState } = await import(
  "../../db/payments/paymentIntentRepository"
);
const { gatewayDb, seedIntent, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");
const { uuidv7 } = await import("@oxy.so/db");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let server: Server;
let baseUrl = "";
let counter = 0;
let publishableRestore: string | undefined;
/** Whether the stubbed credential presents a merchant service token. */
let asMerchant = true;

interface Body {
  readonly object?: string;
  readonly kind?: string;
  readonly value?: string;
  readonly publishableKey?: string;
  readonly client_action?: { readonly value: string; readonly publishableKey?: string };
  readonly error?: { readonly type: string; readonly message: string };
}

async function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Body; cacheControl: string | null }> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Body) : {},
    cacheControl: response.headers.get("cache-control"),
  };
}

/** A live card payment, linked to a provider object. */
async function cardIntent() {
  counter += 1;
  const publicId = `pi_ca_${String(counter)}`;
  const intent = await insertPaymentIntent(gatewayDb(), {
    publicId,
    merchantId: merchant.id,
    rail: "card",
    amount: "4200",
    currency: "EUR",
    network: null,
    address: null,
    provider: "stripe",
    clientSecret: `${publicId}_secret_${uuidv7()}`,
    idempotencyKey: uuidv7(),
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
  });
  if (!intent) throw new Error("could not seed the intent");
  await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_${publicId}`);
  return intent;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("resuming a card payment", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();
    publishableRestore = config.stripe.publishableKey;
    (config.stripe as { publishableKey: string | undefined }).publishableKey = "pk_test_abc";

    const stubAuth: RequestHandler = (req, _res, next) => {
      if (asMerchant) {
        (req as OxyAuthRequest).serviceApp = {
          appId: merchant.oxyAppId,
          appName: "t",
          scopes: ["payments:read", "payments:write"],
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
        requireMerchant: stubAuth,
        optionalServiceAuth: stubAuth,
      }),
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    statusToReport = "created";
    asMerchant = true;
  });

  afterAll(async () => {
    (config.stripe as { publishableKey: string | undefined }).publishableKey =
      publishableRestore;
    useFake = false;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test("the merchant asks, and is handed the provider's credential", async () => {
    const intent = await cardIntent();

    const { status, json, cacheControl } = await request(
      "POST",
      `/v1/payment_intents/${intent.publicId}/client_action`,
    );

    expect(status).toBe(200);
    expect(json.object).toBe("client_action");
    expect(json.kind).toBe("client_secret");
    expect(json.value).toBe(`pi_stripe_${intent.publicId}_secret_live`);
    /**
     * The PUBLISHABLE key rides along, and is not baked into the checkout
     * bundle: that page is deployed once and serves whichever gateway it is
     * pointed at, so a compiled-in key would be the wrong mode the first time a
     * test deployment used the same page.
     */
    expect(json.publishableKey).toBe("pk_test_abc");
    // Never cached. The body carries a credential.
    expect(cacheControl).toBe("no-store");
  });

  /**
   * The PAYER asks with the intent's own `client_secret` — the same capability
   * `submit_tx` and the socket `subscribe` already take.
   *
   * The two secrets are different things: Peable's is a capability over the
   * intent, the provider's is a credential over the payment at the acquirer,
   * and nothing derives one from the other.
   */
  test("the payer asks with the intent's client_secret", async () => {
    const intent = await cardIntent();
    asMerchant = false;

    const { status, json } = await request(
      "POST",
      `/v1/payment_intents/${intent.publicId}/client_action`,
      { "X-Peable-Client-Secret": intent.clientSecret },
    );

    expect(status).toBe(200);
    expect(json.value).toBe(`pi_stripe_${intent.publicId}_secret_live`);
  });

  test("a wrong client_secret is refused, and a missing one is unauthenticated", async () => {
    const intent = await cardIntent();
    asMerchant = false;

    const wrong = await request(
      "POST",
      `/v1/payment_intents/${intent.publicId}/client_action`,
      { "X-Peable-Client-Secret": "pi_ca_1_secret_not_this" },
    );
    const missing = await request(
      "POST",
      `/v1/payment_intents/${intent.publicId}/client_action`,
    );

    expect(wrong.status).toBe(403);
    expect(missing.status).toBe(401);
  });

  /**
   * A payment nobody can pay has no next step, and answering one would be worse
   * than answering nothing: a checkout handed a credential renders a card form
   * over a payment that is already settled.
   */
  test("refuses to hand out a credential for a payment that is over", async () => {
    const intent = await cardIntent();
    await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });

    const { status, json } = await request(
      "POST",
      `/v1/payment_intents/${intent.publicId}/client_action`,
    );

    expect(status).toBe(409);
    expect(json.error?.message).toContain("settled");
  });

  /** The FairCoin rail needs no client action; its address is on the intent. */
  test("refuses the operation on a rail that has no client action", async () => {
    const intent = await seedIntent(merchant);

    const { status, json } = await request(
      "POST",
      `/v1/payment_intents/${intent.publicId}/client_action`,
    );

    expect(status).toBe(422);
    expect(json.error?.message).toContain("address");
  });

  // ── the two GET surfaces, which differ deliberately ──────────────────────

  /**
   * The MERCHANT's single read carries it, which is the resume path a
   * server-side integrator already writes.
   */
  test("a merchant's single read carries the client action", async () => {
    const intent = await cardIntent();

    const { status, json, cacheControl } = await request(
      "GET",
      `/v1/payment_intents/${intent.publicId}`,
    );

    expect(status).toBe(200);
    expect(json.client_action?.value).toBe(`pi_stripe_${intent.publicId}_secret_live`);
    expect(cacheControl).toBe("no-store");
  });

  /** ...and stops as soon as the payment can no longer be paid. */
  test("a merchant's read of a finished payment carries none", async () => {
    const intent = await cardIntent();
    await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });

    const { json } = await request("GET", `/v1/payment_intents/${intent.publicId}`);

    expect(json.client_action).toBeUndefined();
  });

  /**
   * The PAYER's read never carries it, and that asymmetry is the point.
   *
   * This is the response a checkout page POLLS. A credential on a polled
   * response is a credential in a browser's cache and in every intermediary's
   * logs; the payer asks for it once, explicitly, through the POST above.
   */
  test("the payer's polled read never carries the client action", async () => {
    const intent = await cardIntent();
    asMerchant = false;

    const { status, json } = await request("GET", `/v1/payment_intents/${intent.publicId}`, {
      "X-Peable-Client-Secret": intent.clientSecret,
    });

    expect(status).toBe(200);
    expect(json.client_action).toBeUndefined();
  });
});
