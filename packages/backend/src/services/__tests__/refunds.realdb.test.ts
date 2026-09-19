/**
 * Refunds, against a real database and a fake provider.
 *
 * This is the one operation in the gateway whose duplicate is unrecoverable: a
 * payer sent their money twice has no reason to report it, and nothing reverses
 * the second automatically. Most of what follows is about that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const providerCalls: { fn: string; request: Record<string, unknown> }[] = [];
let refundCounter = 0;
let refundThrows: Error | null = null;
/**
 * What the provider says about the refund it just made.
 *
 * `succeeded` is the ordinary case and the default. The other two are not
 * exotic — Stripe is explicit that a refund can be pending and that a bank can
 * reject one days later — and until `createRefund` read this field at all, both
 * of them were stored as successes.
 */
let refundState: "succeeded" | "pending" | "failed" = "succeeded";

const fakeProvider = {
  id: "stripe" as const,
  refund: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "refund", request });
    if (refundThrows) throw refundThrows;
    refundCounter += 1;
    return {
      providerObjectId: `re_stripe_${String(refundCounter)}`,
      status: refundState === "succeeded" ? "partially_refunded" : "settled",
      state: refundState,
      ...(refundState === "failed" ? { failureCode: "insufficient_funds" } : {}),
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
} = await import("../providers/registry");
let useFake = false;

mock.module("../providers/registry", () => ({
  resolveProvider: (id: "stripe") => (useFake ? fakeProvider : realResolveProvider(id)),
  resolveCardProvider: () => (useFake ? fakeProvider : realResolveCardProvider()),
  resetProviders: () => {
    realResetProviders();
  },
}));

const {
  createRefund,
  PaymentNotRefundableError,
  RefundExceedsRemainingError,
  remainingRefundable,
} = await import("../refunds/refundService");
const { ProviderError } = await import("../providers/provider");
const { listRefundsForIntent, sumSucceededRefunds } = await import(
  "../../db/refunds/refundRepository"
);
const {
  findIntentByPublicId,
  insertPaymentIntent,
  linkProviderObject,
  updateIntentState,
} = await import("../../db/payments/paymentIntentRepository");
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");
const { uuidv7 } = await import("@oxy.so/db");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let counter = 0;

/** A settled card payment, which is the only state a refund can draw on. */
async function settledIntent(amount: string) {
  counter += 1;
  const intent = await insertPaymentIntent(gatewayDb(), {
    publicId: `pi_refundable_${String(counter)}`,
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
  await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_${String(counter)}`);
  const settled = await updateIntentState(gatewayDb(), intent.id, {
    from: "created",
    status: "settled",
  });
  return settled.kind === "updated" ? settled.row : intent;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("refunds", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant({
      webhookUrl: "https://merchant.example/hooks",
      webhookSecret: "whsec_x",
    });
  });

  beforeEach(() => {
    providerCalls.length = 0;
    refundThrows = null;
    refundState = "succeeded";
  });

  afterAll(() => {
    useFake = false;
  });

  test("refunds part of a payment and moves it to partially_refunded", async () => {
    const intent = await settledIntent("10000");
    const { refund, created, paymentStatus } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_partial",
      amount: "3000",
    });

    expect(created).toBe(true);
    expect(refund.status).toBe("succeeded");
    expect(paymentStatus).toBe("partially_refunded");
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe(
      "partially_refunded",
    );
  });

  test("a refund exhausting the payment moves it to refunded", async () => {
    const intent = await settledIntent("10000");
    const { paymentStatus } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_full",
      amount: "10000",
    });
    expect(paymentStatus).toBe("refunded");
  });

  /**
   * Two partial refunds that together exhaust the payment.
   *
   * The status is recomputed from the SUM of succeeded rows, never incremented,
   * so the second one reaches `refunded` without anyone tracking a running
   * total — and the second call reads the intent as `partially_refunded`, which
   * `LEGAL_SOURCES` allows `refund_full` from and `refund_partial` from not at
   * all.
   */
  test("two partial refunds reach refunded, from the sum rather than a counter", async () => {
    const first = await settledIntent("10000");
    await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent: first,
      externalRef: "order_two_a",
      amount: "4000",
    });
    const reread = await findIntentByPublicId(gatewayDb(), first.publicId);
    const { paymentStatus } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent: reread!,
      externalRef: "order_two_b",
      amount: "6000",
    });

    expect(paymentStatus).toBe("refunded");
    expect(await sumSucceededRefunds(gatewayDb(), first.id)).toBe("10000");
    expect(await listRefundsForIntent(gatewayDb(), first.id)).toHaveLength(2);
  });

  /**
   * THE constraint this whole domain is built around. A retried refund
   * submission converges rather than sending the payer their money again.
   */
  test("a repeated refund converges and does not send money twice", async () => {
    const intent = await settledIntent("10000");
    const first = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_dup",
      amount: "2500",
    });
    providerCalls.length = 0;
    const second = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_dup",
      amount: "2500",
    });

    expect(second.created).toBe(false);
    expect(second.refund.id).toBe(first.refund.id);
    expect(providerCalls.filter((call) => call.fn === "refund")).toHaveLength(0);
  });

  test("refuses more than the payment has left", async () => {
    const intent = await settledIntent("10000");
    await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_left_a",
      amount: "8000",
    });
    const reread = await findIntentByPublicId(gatewayDb(), intent.publicId);

    await expect(
      createRefund({
        merchantId: merchant.id,
        environment: merchant.environment,
        intent: reread!,
        externalRef: "order_left_b",
        amount: "2001",
      }),
    ).rejects.toThrow(RefundExceedsRemainingError);

    expect(await remainingRefundable(reread!)).toBe("2000");
  });

  /**
   * A `failed` refund moved NO money, so it must not consume the payment's
   * remaining balance — counting it would refuse a legitimate retry under a new
   * ref, permanently, for a refund that never happened.
   */
  test("a failed refund does not consume the payment's remaining balance", async () => {
    const intent = await settledIntent("10000");
    refundThrows = new ProviderError({
      provider: "stripe",
      stage: "refund",
      message: "charge already refunded",
      retryable: false,
    });

    const { refund } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_failed",
      amount: "9000",
    });
    expect(refund.status).toBe("failed");

    // The whole amount is still refundable.
    expect(await remainingRefundable(intent)).toBe("10000");
    expect(await sumSucceededRefunds(gatewayDb(), intent.id)).toBe("0");
  });

  /**
   * A RETRYABLE provider failure is rethrown with the row left `pending`.
   * Marking it failed would tell the merchant the payer's money is not coming
   * when the next attempt would have sent it.
   */
  test("rethrows a retryable provider failure and leaves the refund pending", async () => {
    const intent = await settledIntent("10000");
    refundThrows = new ProviderError({
      provider: "stripe",
      stage: "refund",
      message: "the acquirer timed out",
      retryable: true,
    });

    await expect(
      createRefund({
        merchantId: merchant.id,
        environment: merchant.environment,
        intent,
        externalRef: "order_retryable",
        amount: "1000",
      }),
    ).rejects.toThrow(ProviderError);

    const rows = await listRefundsForIntent(gatewayDb(), intent.id);
    expect(rows[0]?.status).toBe("pending");

    /**
     * ...and the pending amount IS reserved against the balance.
     *
     * This assertion used to read `"10000"`, on the reasoning that pending
     * money has not moved. True of the payment's STATUS and wrong for the
     * budget: a refund sitting pending at the provider will most likely land,
     * so two concurrent refunds that each read only the succeeded total would
     * both pass a check only one of them should — and the payer would be sent
     * more than they paid, which nothing reverses automatically and which they
     * have no reason to report.
     *
     * The payment's own status is still derived from succeeded rows only, which
     * the `sumSucceededRefunds` assertion in the failed-refund case above pins.
     */
    expect(await remainingRefundable(intent)).toBe("9000");
    expect(await sumSucceededRefunds(gatewayDb(), intent.id)).toBe("0");
  });

  /**
   * A refund the provider reports as PENDING is not money that came back.
   *
   * `createRefund` used to call `markRefundSucceeded` the moment
   * `provider.refund` returned, ignoring `result.state` — which the adapter has
   * always reported. So a pending refund was stored as succeeded, counted
   * toward the payment's refunded total, and moved the payment to `refunded`.
   * One that then failed left a payment permanently claiming money had gone
   * back that never did.
   */
  test("a pending refund is stored pending and does not move the payment", async () => {
    const intent = await settledIntent("10000");
    refundState = "pending";

    const { refund, paymentStatus } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_pending",
      amount: "4000",
    });

    expect(refund.status).toBe("pending");
    expect(paymentStatus).toBe("settled");
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
    // Nothing has come back...
    expect(await sumSucceededRefunds(gatewayDb(), intent.id)).toBe("0");
    // ...and the amount is reserved, so a second refund cannot exceed the total.
    expect(await remainingRefundable(intent)).toBe("6000");
    /**
     * The provider's id is recorded even though the money has not moved. It is
     * the ONLY handle a later `refund.updated` can be matched on, so a pending
     * refund with no id stored is one whose eventual outcome arrives as
     * `unmatched` and is never applied.
     */
    expect(refund.providerObjectId).not.toBeNull();
  });

  /**
   * A refund the provider reports as FAILED is not money that came back
   * either, and the payment must not move.
   */
  test("a provider-reported failure is stored failed, with its reason", async () => {
    const intent = await settledIntent("10000");
    refundState = "failed";

    const { refund, paymentStatus } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_reported_failure",
      amount: "4000",
    });

    expect(refund.status).toBe("failed");
    expect(refund.failureCode).toBe("insufficient_funds");
    expect(paymentStatus).toBe("settled");
    // A failed refund reserves nothing: the whole amount is still refundable,
    // so a retry under a new reference is not blocked by a refund that never
    // happened.
    expect(await remainingRefundable(intent)).toBe("10000");
  });

  /**
   * An interrupted refund is FINISHED by the retry, not merely described.
   *
   * The row is written before the provider call so a crash between them leaves
   * something recovery can finish. Nothing finished it: the retry found the
   * pending row and returned it, so the merchant got a 200 for money that had
   * not gone anywhere and no path would ever send it.
   *
   * Resuming is safe for the same reason the row is written first — the
   * provider key is derived from the row's own public id, so the call either
   * makes the refund or returns the one it already made.
   */
  test("finishes an interrupted refund on the retry, under the same provider key", async () => {
    const intent = await settledIntent("10000");
    refundThrows = new ProviderError({
      provider: "stripe",
      stage: "refund",
      message: "the acquirer timed out",
      retryable: true,
    });

    await expect(
      createRefund({
        merchantId: merchant.id,
        environment: merchant.environment,
        intent,
        externalRef: "order_resume",
        amount: "3000",
      }),
    ).rejects.toThrow(ProviderError);

    const [pending] = await listRefundsForIntent(gatewayDb(), intent.id);
    if (!pending) throw new Error("the interrupted attempt left no row to resume");
    expect(pending.status).toBe("pending");
    expect(pending.providerObjectId).toBeNull();

    // The provider is reachable again, and the merchant retries the same ref.
    refundThrows = null;
    providerCalls.length = 0;
    const { refund, created } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_resume",
      amount: "3000",
    });

    expect(created).toBe(true);
    expect(refund.status).toBe("succeeded");
    expect(refund.publicId).toBe(pending.publicId);
    // ONE row, not two.
    expect(await listRefundsForIntent(gatewayDb(), intent.id)).toHaveLength(1);
    // ...and the SAME provider key the interrupted attempt used, which is what
    // makes the resume a completion rather than a second refund.
    const call = providerCalls.find((entry) => entry.fn === "refund");
    expect(call?.request.idempotencyKey).toBe(`re:${refund.publicId}`);
  });

  /**
   * A FINISHED refund is history, and history does not change because it was
   * asked about again — even when the remaining balance no longer accommodates
   * it, which it will not, since this very refund consumed it.
   */
  test("a completed refund is answered from history, with no second call", async () => {
    const intent = await settledIntent("10000");
    const first = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_history",
      amount: "10000",
    });
    providerCalls.length = 0;

    const replay = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_history",
      amount: "10000",
    });

    expect(replay.created).toBe(false);
    expect(replay.refund.id).toBe(first.refund.id);
    expect(providerCalls.filter((entry) => entry.fn === "refund")).toHaveLength(0);
  });

  test("refuses to refund a payment that never settled", async () => {
    counter += 1;
    const intent = await insertPaymentIntent(gatewayDb(), {
      publicId: `pi_unsettled_${String(counter)}`,
      merchantId: merchant.id,
      rail: "card",
      amount: "10000",
      currency: "EUR",
      network: null,
      address: null,
      provider: "stripe",
      clientSecret: "cs_x",
      idempotencyKey: uuidv7(),
      metadata: {},
      expiresAt: new Date(Date.now() + 900_000),
    });

    await expect(
      createRefund({
        merchantId: merchant.id,
        environment: merchant.environment,
        intent: intent!,
        externalRef: "order_unsettled",
        amount: "1000",
      }),
    ).rejects.toThrow(PaymentNotRefundableError);
  });

  /**
   * The idempotency key handed to the provider is derived from the gateway's
   * own refund id — never random. A random key turns every retry of a refund
   * whose response was lost into a second real refund.
   */
  test("derives the provider idempotency key from the gateway's refund id", async () => {
    const intent = await settledIntent("10000");
    const { refund } = await createRefund({
      merchantId: merchant.id,
      environment: merchant.environment,
      intent,
      externalRef: "order_key",
      amount: "1000",
    });

    const call = providerCalls.find((entry) => entry.fn === "refund");
    expect(call?.request.idempotencyKey).toBe(`re:${refund.publicId}`);
    expect(call?.request.amount).toEqual({ amount: "1000", currency: "EUR" });
  });

  /**
   * `BigInt`, not `Number`: these are unbounded canonical integer strings, and
   * a float comparison starts rounding above `Number.MAX_SAFE_INTEGER` — which
   * a minor-unit currency reaches, and where letting one unit through matters
   * most.
   */
  test("compares a refund against the remaining balance without rounding", async () => {
    // `Number` rounds both of these to the same float, so a float comparison
    // says the over-refund is not larger and lets it through.
    const intent = await settledIntent("9007199254740992");
    await expect(
      createRefund({
        merchantId: merchant.id,
        environment: merchant.environment,
        intent,
        externalRef: "order_big",
        amount: "9007199254740993",
      }),
    ).rejects.toThrow(RefundExceedsRemainingError);
  });
});
