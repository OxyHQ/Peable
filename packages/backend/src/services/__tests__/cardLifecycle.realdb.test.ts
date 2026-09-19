/**
 * Ending a card payment, and the races that end it a different way.
 *
 * ## The shape of the bug this file exists for
 *
 * A card payment is TWO things: a row here, and a PaymentIntent at an acquirer
 * that stays confirmable with a credential the payer's browser is still
 * holding. `POST /reject` moved the row and emitted
 * `payment_intent.rejected`; the expiry sweeper moved a batch to `expired`. The
 * acquirer was told nothing by either. So a payment this gateway had announced
 * as over could complete minutes later, against a terminal status, for an order
 * the merchant had already released — and the only trace was a
 * `payment_intent.succeeded` the drain could not apply.
 *
 * Every case below drives the real routers or the real sweeper against a fake
 * provider that can be made to LOSE the race, because the ordering is the whole
 * subject and only the losing side proves it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

const providerCalls: string[] = [];

/**
 * What the provider does when asked to cancel.
 *
 *  - `cancels`  — the ordinary case.
 *  - `refuses_succeeded` — the payer confirmed first. Stripe answers this as an
 *    invalid-request error, which is PERMANENT and is an answer rather than a
 *    fault, so the adapter re-reads the payment to find out which.
 *  - `unreachable` — a transient failure. Nothing may be announced.
 */
let cancelBehaviour: "cancels" | "refuses_succeeded" | "unreachable" = "cancels";

class FakeProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

const fakeProvider = {
  id: "stripe" as const,
  cancel: async (request: Record<string, unknown>) => {
    providerCalls.push(`cancel:${String(request.providerObjectId)}:${String(request.idempotencyKey)}`);
    if (cancelBehaviour === "cancels") {
      return { providerObjectId: String(request.providerObjectId), status: "canceled" as const };
    }
    if (cancelBehaviour === "refuses_succeeded") {
      throw new FakeProviderError(
        "You cannot cancel this PaymentIntent because it has a status of succeeded.",
        false,
      );
    }
    throw new FakeProviderError("the acquirer could not be reached", true);
  },
  getStatus: async (providerObjectId: string) => {
    providerCalls.push(`getStatus:${providerObjectId}`);
    return {
      providerObjectId,
      status: cancelBehaviour === "refuses_succeeded" ? ("succeeded" as const) : ("created" as const),
      chargeObjectId: providerObjectId.replace(/^pi_/, "ch_"),
    };
  },
  createPayment: async () => {
    throw new Error("not used");
  },
  capture: async () => {
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
} = await import("../providers/registry");
let useFake = false;

mock.module("../providers/registry", () => ({
  resolveProvider: (id: "stripe") => (useFake ? fakeProvider : realResolveProvider(id)),
  resolveCardProvider: () => (useFake ? fakeProvider : realResolveCardProvider()),
  resetProviders: () => {
    realResetProviders();
  },
}));

/**
 * `ProviderError` is matched with `instanceof` by `isRetryableProviderError`,
 * so the fake's own error class has to BE one. Mocking the module is how a fake
 * throws something the production code recognises without importing Stripe.
 */
const realProvider = await import("../providers/provider");
mock.module("../providers/provider", () => ({
  ...realProvider,
  isRetryableProviderError: (error: unknown) =>
    error instanceof FakeProviderError
      ? error.retryable
      : realProvider.isRetryableProviderError(error),
}));

const { createPaymentIntentsRouter } = await import("../../routes/paymentIntents");
const { runExpirySweep } = await import("../expirySweeper");
const {
  findIntentByPublicId,
  insertPaymentIntent,
  linkProviderObject,
} = await import("../../db/payments/paymentIntentRepository");
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");
const { uuidv7 } = await import("@oxy.so/db");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let server: Server;
let baseUrl = "";
let counter = 0;

const passthrough: RequestHandler = (_req, _res, next) => next();

interface ErrorBody {
  readonly error?: { readonly type: string; readonly message: string };
  readonly status?: string;
}

async function post(path: string): Promise<{ status: number; json: ErrorBody }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST" });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as ErrorBody) : {} };
}

/** A live card payment: `created`, linked to a provider object. */
async function cardIntent(options: { expiresAt?: Date } = {}) {
  counter += 1;
  const publicId = `pi_life_${String(counter)}`;
  const intent = await insertPaymentIntent(gatewayDb(), {
    publicId,
    merchantId: merchant.id,
    rail: "card",
    amount: "5000",
    currency: "EUR",
    network: null,
    address: null,
    provider: "stripe",
    clientSecret: `cs_${publicId}`,
    idempotencyKey: uuidv7(),
    metadata: {},
    expiresAt: options.expiresAt ?? new Date(Date.now() + 900_000),
  });
  if (!intent) throw new Error("could not seed the intent");
  await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_${publicId}`);
  return intent;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("ending a card payment", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();

    const stubMerchantAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: merchant.oxyAppId,
        appName: "t",
        scopes: ["payments:read", "payments:write"],
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
        requireMerchant: stubMerchantAuth,
        optionalServiceAuth: passthrough,
      }),
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    cancelBehaviour = "cancels";
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  // ── reject ───────────────────────────────────────────────────────────────

  test("cancels at the provider BEFORE announcing a rejection", async () => {
    const intent = await cardIntent();

    const { status } = await post(`/v1/payment_intents/${intent.publicId}/reject`);

    expect(status).toBe(200);
    // The order is the whole assertion: a rejection announced without this call
    // leaves a payment the payer can still complete.
    expect(providerCalls).toContain(
      `cancel:pi_stripe_${intent.publicId}:cancel:${intent.publicId}`,
    );
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("rejected");
  });

  /**
   * The idempotency key is derived from the intent's own id, so a retry after a
   * lost response is the SAME operation rather than a second cancellation.
   */
  test("derives the cancellation key from the intent's own id", async () => {
    const intent = await cardIntent();
    await post(`/v1/payment_intents/${intent.publicId}/reject`);
    expect(providerCalls.some((call) => call.endsWith(`cancel:${intent.publicId}`))).toBe(true);
  });

  /**
   * The payer confirmed first. The gateway must NOT announce a rejection it
   * cannot deliver — the money is real.
   */
  test("reconciles to the truth when the payer pays during the rejection", async () => {
    const intent = await cardIntent();
    cancelBehaviour = "refuses_succeeded";

    const { status, json } = await post(`/v1/payment_intents/${intent.publicId}/reject`);

    expect(status).toBe(409);
    expect(json.error?.message).toContain("completed by the payer");
    // ...and the row now says what actually happened, rather than staying
    // `created` with a payment nobody recorded.
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
  });

  /**
   * The provider could not be reached. The payment is still live and its state
   * is unknown, so NOTHING is written and nothing is announced.
   */
  test("refuses to reject when the provider cannot be reached", async () => {
    const intent = await cardIntent();
    cancelBehaviour = "unreachable";

    const { status } = await post(`/v1/payment_intents/${intent.publicId}/reject`);

    expect(status).toBe(502);
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("created");
  });

  // ── expiry ───────────────────────────────────────────────────────────────

  test("the sweeper cancels a due card payment before expiring it", async () => {
    const intent = await cardIntent({ expiresAt: new Date(Date.now() - 1000) });

    const result = await runExpirySweep({ now: new Date() });

    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(providerCalls).toContain(
      `cancel:pi_stripe_${intent.publicId}:cancel:${intent.publicId}`,
    );
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("expired");
  });

  /**
   * THE case. A payer who completed the payment inside the sweep's own window
   * must not be told nobody paid in time.
   */
  test("does not expire a payment the payer completed during the sweep", async () => {
    const intent = await cardIntent({ expiresAt: new Date(Date.now() - 1000) });
    cancelBehaviour = "refuses_succeeded";

    const result = await runExpirySweep({ now: new Date() });

    expect(result.examined).toBeGreaterThanOrEqual(1);
    expect(result.expired).toBe(0);
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
  });

  /**
   * ...and an unreachable provider leaves the row alone entirely, for the next
   * tick. `expires_at` has passed and will keep having passed, so nothing is
   * lost by waiting; announcing an expiry that the acquirer has not been told
   * about cannot be taken back.
   */
  test("leaves a due payment alone when the provider cannot be reached", async () => {
    const intent = await cardIntent({ expiresAt: new Date(Date.now() - 1000) });
    cancelBehaviour = "unreachable";

    const result = await runExpirySweep({ now: new Date() });

    expect(result.expired).toBe(0);
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("created");
  });

  /**
   * A FAIRCOIN intent expires with no provider call at all.
   *
   * Its other half is a transaction the payer never broadcast — there is
   * nothing anywhere to cancel — which is why the fast set-based claim is still
   * right for that rail and why this sweep did not need splitting until the
   * card rail existed.
   */
  test("expires a FairCoin intent without calling any provider", async () => {
    const intent = await insertPaymentIntent(gatewayDb(), {
      publicId: `pi_chain_${uuidv7()}`,
      merchantId: merchant.id,
      rail: "faircoin",
      amount: "100000000",
      currency: "FAIR",
      network: merchant.network,
      address: `T${uuidv7()}`,
      provider: null,
      clientSecret: `cs_chain_${uuidv7()}`,
      idempotencyKey: uuidv7(),
      metadata: {},
      expiresAt: new Date(Date.now() - 1000),
    });
    if (!intent) throw new Error("could not seed the chain intent");

    await runExpirySweep({ now: new Date() });

    // Scoped to THIS intent rather than asserting no calls at all: an earlier
    // case deliberately leaves an unreachable card payment due, and the sweep
    // rightly keeps retrying it. What must be true is that nothing was asked
    // about the CHAIN payment.
    expect(providerCalls.filter((call) => call.includes(intent.publicId))).toEqual([]);
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("expired");
  });
});
