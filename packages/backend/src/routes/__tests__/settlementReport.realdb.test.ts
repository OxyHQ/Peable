/**
 * What a payment came to — and the distinction the whole shape exists for.
 *
 * Issue #70 §13 names it: *"Representar `unknown/pending` frente a cero
 * conocido"*. A settlement report that renders a not-yet-known fee as `0` is
 * one a merchant reconciles against and cannot explain, and zero is a number
 * somebody will subtract. Every case below is about a figure being `null` with
 * a `status` rather than a number nobody measured.
 *
 * What this does NOT do is attribute the cost to an entity. A fee paid by the
 * operator of a deployment is not automatically an expense of the marketplace
 * running on it, and that decision is still open — reporting the fact does not
 * prejudge it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

let settlementResponse: Record<string, unknown> = {};
let getSettlementThrows: Error | null = null;
const providerCalls: string[] = [];

const fakeProvider = {
  id: "stripe" as const,
  getSettlement: async (chargeObjectId: string) => {
    providerCalls.push(`getSettlement:${chargeObjectId}`);
    if (getSettlementThrows) throw getSettlementThrows;
    return settlementResponse;
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
  refund: async () => {
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
const { linkProviderCharge, linkProviderObject } = await import(
  "../../db/payments/paymentIntentRepository"
);
const { gatewayDb, seedIntent, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let server: Server;
let baseUrl = "";
let counter = 0;

interface Body {
  readonly object?: string;
  readonly paymentIntentId?: string;
  readonly status?: string;
  readonly gross?: string | null;
  readonly fee?: string | null;
  readonly net?: string | null;
  readonly currency?: string | null;
  readonly availableOn?: string | null;
  readonly exchangeRate?: number | null;
}

async function get(path: string): Promise<{ status: number; json: Body }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Body };
}

/** A card payment with a charge recorded against it. */
async function chargedIntent() {
  counter += 1;
  const intent = await seedIntent(merchant, {
    publicId: `pi_settle_${String(counter)}`,
    rail: "card",
    currency: "EUR",
    amount: "10000",
  });
  await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_${intent.publicId}`);
  await linkProviderCharge(gatewayDb(), intent.id, "stripe", `ch_stripe_${intent.publicId}`);
  return intent;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("reporting what a payment came to", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();

    const stubAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: merchant.oxyAppId,
        appName: "t",
        scopes: ["payments:read", "payments:write"],
        credentialId: "c",
        ownerAccountId: "owner",
        environment: "development",
        tier: "external",
      };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createRefundsRouter({ requireMerchant: stubAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    getSettlementThrows = null;
    settlementResponse = {
      status: "available",
      gross: "10000",
      fee: "204",
      net: "9796",
      currency: "EUR",
      availableOn: "2026-09-26T00:00:00.000Z",
      exchangeRate: null,
    };
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test("reports gross, fee and net when the provider has settled it", async () => {
    const intent = await chargedIntent();

    const { status, json } = await get(
      `/v1/payment_intents/${intent.publicId}/settlement`,
    );

    expect(status).toBe(200);
    expect(json.object).toBe("settlement");
    expect(json.paymentIntentId).toBe(intent.publicId);
    expect(json.status).toBe("available");
    expect(json.fee).toBe("204");
    expect(json.net).toBe("9796");
    expect(json.availableOn).toBe("2026-09-26T00:00:00.000Z");
    // The CHARGE, not the payment: fees attach to the charge.
    expect(providerCalls).toContain(`getSettlement:ch_stripe_${intent.publicId}`);
  });

  /**
   * A settlement that exists and is not final says `pending` — with the figures
   * it does have, because they are known even though they may still move.
   */
  test("says pending rather than final when the provider has not settled it", async () => {
    settlementResponse = { ...settlementResponse, status: "pending" };
    const intent = await chargedIntent();

    const { json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(json.status).toBe("pending");
    expect(json.fee).toBe("204");
  });

  /**
   * THE case. A payment with no charge has no balance transaction — it has not
   * been captured, or the two-step create never linked. Every figure is `null`
   * and the status says why.
   */
  test("says unknown, not zero, when there is nothing to report", async () => {
    const intent = await seedIntent(merchant, {
      publicId: `pi_uncharged_${String(Date.now())}`,
      rail: "card",
      currency: "EUR",
      amount: "10000",
    });

    const { json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(json.status).toBe("unknown");
    expect(json.gross).toBeNull();
    expect(json.fee).toBeNull();
    expect(json.net).toBeNull();
    expect(json.currency).toBeNull();
    // Never asked the provider — there is no charge to ask about.
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * The FairCoin rail takes no fee and has no acquirer balance. Reporting `0`
   * would be a claim about a settlement that does not work that way at all.
   */
  test("says unknown for a rail that has no settlement", async () => {
    const intent = await seedIntent(merchant);

    const { json } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(json.status).toBe("unknown");
    expect(json.fee).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * A provider that cannot be reached knows the answer; we do not. `unknown` is
   * the honest response, and it keeps a reconciliation read from failing
   * because of an outage elsewhere.
   */
  test("says unknown rather than failing when the provider is unreachable", async () => {
    const intent = await chargedIntent();
    getSettlementThrows = new Error("the acquirer could not be reached");

    const { status, json } = await get(
      `/v1/payment_intents/${intent.publicId}/settlement`,
    );

    expect(status).toBe(200);
    expect(json.status).toBe("unknown");
    expect(json.net).toBeNull();
  });

  test("does not report another merchant's payment", async () => {
    const other = await seedMerchant();
    const intent = await seedIntent(other, { rail: "card", currency: "EUR" });

    const { status } = await get(`/v1/payment_intents/${intent.publicId}/settlement`);

    expect(status).toBe(404);
  });
});
