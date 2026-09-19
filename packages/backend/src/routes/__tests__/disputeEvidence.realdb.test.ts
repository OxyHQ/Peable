/**
 * Answering a dispute — the write this surface did not have.
 *
 * `routes/disputes.ts` was read-only and said why: the provider port had no
 * `submitDisputeEvidence`, and a route that accepted a merchant's defence and
 * did nothing with it would be worse than none, because they would believe they
 * had responded. That was right while the port was missing, and it left a
 * merchant able to read `evidenceDueAt`, watch it pass, and lose a dispute this
 * gateway had told them about and given them no way to answer.
 *
 * Three properties matter more than the happy path and each has a case below:
 * the submission is ONE SHOT, the evidence is never stored, and a deadline that
 * has passed is refused here rather than at the acquirer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

interface ProviderCall {
  readonly fn: string;
  readonly request: Record<string, unknown>;
}
const providerCalls: ProviderCall[] = [];
let submitThrows: Error | null = null;

const fakeProvider = {
  id: "stripe" as const,
  submitDisputeEvidence: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "submitDisputeEvidence", request });
    if (submitThrows) throw submitThrows;
    return { providerObjectId: String(request.providerObjectId), status: "under_review" };
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

const { createDisputesRouter } = await import("../disputes");
const { upsertDispute, findDisputeByProviderObject } = await import(
  "../../db/disputes/disputeRepository"
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
  readonly id?: string;
  readonly object?: string;
  readonly status?: string;
  readonly evidenceSubmittedAt?: string | null;
  readonly evidenceDueAt?: string | null;
  readonly error?: { readonly type: string; readonly message: string };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Body }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Body) : {} };
}

/** A dispute in the one state that accepts a response. */
async function openDispute(options: { dueAt?: Date | null; status?: "needs_response" | "won" } = {}) {
  counter += 1;
  const intent = await seedIntent(merchant, { rail: "card", currency: "EUR", amount: "5000" });
  const { dispute } = await upsertDispute(gatewayDb(), {
    merchantId: merchant.id,
    paymentIntentId: intent.id,
    provider: "stripe",
    providerObjectId: `dp_stripe_${String(counter)}`,
    amount: "5000",
    currency: "EUR",
    status: options.status ?? "needs_response",
    reason: "fraudulent",
    evidenceDueAt:
      options.dueAt === undefined
        ? new Date(Date.now() + 7 * 86_400_000)
        : options.dueAt,
  });
  return dispute;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("answering a dispute", () => {
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
      };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createDisputesRouter({ requireMerchant: stubAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    submitThrows = null;
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test("forwards the merchant's response and records that it was given", async () => {
    const dispute = await openDispute();

    const { status, json } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      productDescription: "A blue enamel mug, 350ml",
      shippingTrackingNumber: "TRACK-1",
      uncategorizedText: "The buyer collected this in person on the 3rd.",
    });

    expect(status).toBe(201);
    expect(json.object).toBe("dispute");
    expect(json.evidenceSubmittedAt).not.toBeNull();

    const call = providerCalls.find((entry) => entry.fn === "submitDisputeEvidence");
    expect(call?.request.providerObjectId).toBe(dispute.providerObjectId);
    // Derived from the dispute's own id, so a retry after a lost response is
    // the same submission rather than a second one.
    expect(call?.request.idempotencyKey).toBe(`dpev:${dispute.publicId}`);
  });

  /**
   * THE property. Submitting is one-way at the network, so a second call must
   * not send a second response — it answers 200 with the dispute as it stands.
   */
  test("submits once, however many times it is asked", async () => {
    const dispute = await openDispute();
    const body = { uncategorizedText: "The goods were delivered and signed for." };

    const first = await post(`/v1/disputes/${dispute.publicId}/evidence`, body);
    providerCalls.length = 0;
    const second = await post(`/v1/disputes/${dispute.publicId}/evidence`, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.evidenceSubmittedAt).toBe(first.json.evidenceSubmittedAt);
    // Nothing reached the provider the second time.
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * The evidence is NEVER stored.
   *
   * It carries a customer's name, their email, a billing address and
   * correspondence — the richest personal-data payload this system handles, and
   * `redactProviderPayload` exists because this gateway does not keep that
   * class of data. What is recorded is THAT a response was given and when.
   */
  test("keeps none of the evidence, only the fact that it was submitted", async () => {
    const dispute = await openDispute();
    await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      customerName: "Jane Buyer",
      customerEmailAddress: "jane@example.com",
      billingAddress: "3 Flat Street, Springfield",
      uncategorizedText: "She collected it herself.",
    });

    const stored = await findDisputeByProviderObject(
      gatewayDb(),
      "stripe",
      dispute.providerObjectId,
    );
    expect(stored?.evidenceSubmittedAt).toBeInstanceOf(Date);

    // The whole row, serialized — none of the merchant's words are in it.
    const asText = JSON.stringify(stored);
    expect(asText).not.toContain("Jane Buyer");
    expect(asText).not.toContain("jane@example.com");
    expect(asText).not.toContain("Springfield");
    expect(asText).not.toContain("collected it herself");
  });

  /**
   * A deadline that has passed is refused HERE.
   *
   * The merchant needs to know it was the clock and not their request — and a
   * late submission is the one failure on this surface no retry fixes, so
   * finding out from the acquirer's error message is finding out too late.
   */
  test("refuses a response after the deadline, without calling the provider", async () => {
    const dispute = await openDispute({ dueAt: new Date(Date.now() - 1000) });

    const { status, json } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      uncategorizedText: "Late.",
    });

    expect(status).toBe(409);
    expect(json.error?.message).toContain("deadline");
    expect(providerCalls).toHaveLength(0);
  });

  /** A decided dispute accepts nothing. */
  test("refuses a response to a dispute that is already closed", async () => {
    const dispute = await openDispute({ status: "won", dueAt: null });

    const { status } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      uncategorizedText: "Anything.",
    });

    expect(status).toBe(409);
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * An EMPTY response would be submitted, final, and would say nothing — the
   * worst possible use of a one-shot action.
   */
  test("refuses a response with nothing in it", async () => {
    const dispute = await openDispute();

    const { status } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {});

    expect(status).toBe(409);
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * An unknown field is REFUSED rather than dropped.
   *
   * A merchant who sent `trackingNumber` instead of `shippingTrackingNumber`
   * would otherwise submit — finally — a response missing the field they were
   * relying on, and find out when the dispute is decided.
   */
  test("refuses a field name the network would not recognise", async () => {
    const dispute = await openDispute();

    const { status } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      trackingNumber: "TRACK-2",
    });

    expect(status).toBe(422);
    expect(providerCalls).toHaveLength(0);
  });

  /** Another merchant's dispute is a 404, exactly like one that does not exist. */
  test("does not answer across merchants", async () => {
    const other = await seedMerchant();
    const intent = await seedIntent(other, { rail: "card", currency: "EUR", amount: "5000" });
    counter += 1;
    const { dispute } = await upsertDispute(gatewayDb(), {
      merchantId: other.id,
      paymentIntentId: intent.id,
      provider: "stripe",
      providerObjectId: `dp_stripe_other_${String(counter)}`,
      amount: "5000",
      currency: "EUR",
      status: "needs_response",
      evidenceDueAt: new Date(Date.now() + 86_400_000),
    });

    const { status } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      uncategorizedText: "Not mine to answer.",
    });

    expect(status).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });

  /**
   * A provider failure leaves the dispute UNANSWERED, so the merchant can try
   * again while the deadline is still running.
   */
  test("does not record a submission the provider refused", async () => {
    const dispute = await openDispute();
    const { ProviderError } = await import("../../services/providers/provider");
    submitThrows = new ProviderError({
      provider: "stripe",
      stage: "dispute",
      message: "the acquirer could not be reached",
      retryable: true,
    });

    const { status } = await post(`/v1/disputes/${dispute.publicId}/evidence`, {
      uncategorizedText: "Delivered and signed for.",
    });

    expect(status).toBe(502);
    const stored = await findDisputeByProviderObject(
      gatewayDb(),
      "stripe",
      dispute.providerObjectId,
    );
    // Still unanswered — the row records a FACT at the network, not an attempt,
    // so a failed call must not claim the merchant responded.
    expect(stored?.evidenceSubmittedAt).toBeNull();
  });
});
