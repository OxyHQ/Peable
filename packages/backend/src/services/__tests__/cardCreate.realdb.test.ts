/**
 * Minting a CARD intent: the two-step create, against a real database and a
 * fake provider.
 *
 * The order of the two steps is the decision under test, and it is not
 * observable from either step alone. The row is written FIRST so that a process
 * dying mid-call leaves evidence of an attempt that recovery can finish; the
 * reverse order leaves a real charge at the acquirer with no row anywhere, which
 * nothing can find and no reconciliation can start from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

interface ProviderCall {
  readonly fn: string;
  readonly request: Record<string, unknown>;
}

const providerCalls: ProviderCall[] = [];
let createPaymentImpl: (request: Record<string, unknown>) => Promise<unknown>;
let getStatusImpl: (objectId: string) => Promise<unknown>;
let railEnabled = true;

const fakeProvider = {
  id: "stripe" as const,
  createPayment: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "createPayment", request });
    return createPaymentImpl(request);
  },
  getStatus: async (objectId: string) => {
    providerCalls.push({ fn: "getStatus", request: { objectId } });
    return getStatusImpl(objectId);
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

/**
 * The registry, faked — but only while THIS file's tests are running.
 *
 * `mock.module` is process-global in bun: it is not undone by `mock.restore()`,
 * and bun's file order is not alphabetical, so a mock installed at a file's top
 * level is live for files that run both before and after it. Measured: a plain
 * unconditional mock here reached `providerWebhooks.integration.test.ts` and
 * turned seven of its cases red, because its `resolveProvider` handed the
 * ingress a fake whose `verifyEvent` throws — a failure whose cause is in a
 * different file from its symptom, and which only appears in the full suite.
 *
 * Delegating to the real module unless `useFakeRegistry` is set makes the mock
 * inert outside this describe block, in BOTH orderings. Re-mocking in `afterAll`
 * would only fix one of them.
 *
 * The functions are DESTRUCTURED here, not read off the namespace later. A
 * module namespace in bun is live and `mock.module` rewrites it in place, so
 * `realRegistry.resetProviders()` inside the mock resolves to the mock —
 * measured, as a stack overflow. Copying the values before the mock is
 * installed is what actually captures the originals.
 */
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = await import("../providers/registry");
let useFakeRegistry = false;

mock.module("../providers/registry", () => ({
  resolveProvider: (id: "stripe") =>
    useFakeRegistry ? (railEnabled ? fakeProvider : undefined) : realResolveProvider(id),
  resolveCardProvider: () =>
    useFakeRegistry ? (railEnabled ? fakeProvider : undefined) : realResolveCardProvider(),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { createIntent, IdempotencyConflictError, RailUnavailableError } = await import(
  "../createIntent"
);
const { findIntentByProviderObject, findIntentByPublicId } = await import(
  "../../db/payments/paymentIntentRepository"
);
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;

describe.skipIf(!POSTGRES_TESTS_ENABLED)("minting a card intent", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFakeRegistry = true;
    merchant = await seedMerchant();
  });

  beforeEach(() => {
    providerCalls.length = 0;
    railEnabled = true;
    // A FRESH object per call, keyed off the intent id — which is what a real
    // provider does, and what `payment_intents_provider_object_key` requires: a
    // fake returning one constant id makes the SECOND card intent in the file
    // collide, on the constraint rather than on its subject.
    createPaymentImpl = async (request) => ({
      providerObjectId: `pi_stripe_${String(request.intentId)}`,
      status: "created",
      clientAction: { kind: "client_secret", value: `${String(request.intentId)}_secret_x` },
    });
    getStatusImpl = async (objectId) => ({
      providerObjectId: objectId,
      status: "created",
      clientAction: { kind: "client_secret", value: `${objectId}_secret_reread` },
    });
  });

  afterAll(() => {
    // The mock stays installed (it cannot be uninstalled) but goes inert.
    useFakeRegistry = false;
  });

  test("writes the row, then creates at the provider, then links the two", async () => {
    const { intent, clientAction } = await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      idempotencyKey: `k-${Date.now().toString()}-a`,
    });

    expect(intent.rail).toBe("card");
    expect(intent.provider).toBe("stripe");
    // A card intent reserves NO derivation index and carries no chain fields.
    expect(intent.address).toBeNull();
    expect(intent.network).toBeNull();

    const objectId = `pi_stripe_${intent.publicId}`;
    const linked = await findIntentByPublicId(gatewayDb(), intent.publicId);
    expect(linked?.providerObjectId).toBe(objectId);
    expect(await findIntentByProviderObject(gatewayDb(), "stripe", objectId)).not.toBeNull();

    expect(clientAction).toEqual({
      kind: "client_secret",
      value: `${intent.publicId}_secret_x`,
    });
  });

  /**
   * The idempotency key is derived from the intent's PUBLIC id and nothing
   * else. That is what makes recovery safe: a retry after a timeout, a crash or
   * a redeploy presents the same key and the provider returns the object it
   * already made. A random key here turns every lost response into a second
   * charge against a real card.
   */
  test("derives the provider idempotency key from the intent's own id", async () => {
    const { intent } = await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      idempotencyKey: `k-${Date.now().toString()}-b`,
    });

    const call = providerCalls.find((entry) => entry.fn === "createPayment");
    expect(call?.request.idempotencyKey).toBe(`pay:${intent.publicId}`);
    expect(call?.request.intentId).toBe(intent.publicId);
    expect(call?.request.amount).toEqual({ amount: "2500", currency: "EUR" });
  });

  /**
   * A merchant's metadata is the merchant's, it can contain anything, and a
   * provider's metadata is readable by everyone with dashboard access. It does
   * not get forwarded.
   */
  test("does not forward the merchant's metadata to the provider", async () => {
    await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      metadata: { customer_email: "buyer@example.com", note: "Jane Buyer, flat 3" },
      idempotencyKey: `k-${Date.now().toString()}-c`,
    });

    const call = providerCalls.find((entry) => entry.fn === "createPayment");
    expect(call?.request.metadata).toEqual({});
    expect(JSON.stringify(call?.request)).not.toContain("buyer@example.com");
  });

  /**
   * The row survives a provider failure unlinked, and the RETRY FINISHES IT.
   *
   * This is the shape the whole ordering exists to produce: the create threw,
   * so no client action reached the payer, but the intent is on disk with
   * `provider` set and `provider_object_id` NULL — which is exactly what
   * recovery looks for.
   *
   * Recovery is what was missing. This test used to assert the opposite —
   * "still unlinked: the replay re-reads rather than re-creating, and there is
   * no object to read" — which described a dead end rather than a recovery: the
   * retry found the row, got no client action, and the payer was handed a
   * payment they could not pay, permanently, because every further retry took
   * the same branch.
   *
   * Resuming is safe for exactly the reason the row is written first: the
   * provider key is derived from the intent's own public id, so the call either
   * creates the payment or returns the one it already made.
   */
  test("finishes an interrupted create on the retry, under the same provider key", async () => {
    createPaymentImpl = async () => {
      throw new Error("acquirer timeout");
    };
    const key = `k-${Date.now().toString()}-d`;

    await expect(
      createIntent({ merchant, amount: "2500", rail: "card", currency: "EUR", idempotencyKey: key }),
    ).rejects.toThrow("acquirer timeout");

    const unlinked = await findIntentByPublicId(gatewayDb(), `pi_unused`);
    expect(unlinked).toBeNull();

    // The provider is reachable again, and the merchant retries with the key
    // they already used.
    createPaymentImpl = async (request) => ({
      providerObjectId: `pi_stripe_${String(request.intentId)}`,
      status: "created",
      clientAction: { kind: "client_secret", value: `${String(request.intentId)}_secret_resumed` },
    });
    providerCalls.length = 0;

    const { intent, reused, clientAction } = await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      idempotencyKey: key,
    });

    expect(reused).toBe(true);
    expect(intent.provider).toBe("stripe");
    // LINKED now, and the payer has something to do.
    expect(
      (await findIntentByPublicId(gatewayDb(), intent.publicId))?.providerObjectId,
    ).toBe(`pi_stripe_${intent.publicId}`);
    expect(clientAction?.value).toBe(`${intent.publicId}_secret_resumed`);

    // The SAME provider idempotency key the interrupted attempt used, which is
    // what makes the resume a completion rather than a second charge.
    const call = providerCalls.find((entry) => entry.fn === "createPayment");
    expect(call?.request.idempotencyKey).toBe(`pay:${intent.publicId}`);
  });

  /**
   * A reused `Idempotency-Key` describing a DIFFERENT payment is a conflict.
   *
   * Answering 200 with the stored intent would tell the caller their new
   * payment exists, and they would wait for money against an amount nobody
   * asked for. The key addresses one operation; this is a second one.
   */
  test("refuses an Idempotency-Key replayed with a different amount", async () => {
    const key = `k-${Date.now().toString()}-conflict`;
    await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      idempotencyKey: key,
    });

    await expect(
      createIntent({
        merchant,
        amount: "9900",
        rail: "card",
        currency: "EUR",
        idempotencyKey: key,
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  /**
   * An idempotent replay must still hand the payer something to do, or a
   * refreshed checkout page is a dead end. It is READ from the provider rather
   * than remembered: a client secret is a confirmation credential and storing
   * one would put it in every backup and every support query.
   */
  test("re-reads the client action from the provider on an idempotent replay", async () => {
    const key = `k-${Date.now().toString()}-e`;
    const first = await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      idempotencyKey: key,
    });
    expect(first.reused).toBe(false);

    const replay = await createIntent({
      merchant,
      amount: "2500",
      rail: "card",
      currency: "EUR",
      idempotencyKey: key,
    });
    expect(replay.reused).toBe(true);
    expect(replay.clientAction).toEqual({
      kind: "client_secret",
      value: `pi_stripe_${first.intent.publicId}_secret_reread`,
    });
    expect(providerCalls.filter((entry) => entry.fn === "getStatus")).toHaveLength(1);
    // ...and NOT a second charge.
    expect(providerCalls.filter((entry) => entry.fn === "createPayment")).toHaveLength(1);
  });

  /**
   * A rail that is off fails BEFORE anything is written. A row whose
   * `provider` could not be resolved is refused by
   * `payment_intents_card_requires_provider_check` anyway — as a 500 — so
   * catching it here is the difference between a clear 503 and a stack trace.
   */
  test("refuses a card intent, with nothing written, when the rail is not configured", async () => {
    railEnabled = false;
    const key = `k-${Date.now().toString()}-f`;

    await expect(
      createIntent({ merchant, amount: "2500", rail: "card", currency: "EUR", idempotencyKey: key }),
    ).rejects.toThrow(RailUnavailableError);

    expect(providerCalls).toHaveLength(0);
  });

  /** The FairCoin rail is untouched by any of this: no provider, no call. */
  test("mints a faircoin intent with no provider and no provider call", async () => {
    const { intent, clientAction } = await createIntent({
      merchant,
      amount: "100000000",
      rail: "faircoin",
      network: merchant.network,
      idempotencyKey: `k-${Date.now().toString()}-g`,
    });

    expect(intent.provider).toBeNull();
    expect(intent.providerObjectId).toBeNull();
    expect(intent.address).not.toBeNull();
    expect(clientAction).toBeUndefined();
    expect(providerCalls).toHaveLength(0);
  });
});
