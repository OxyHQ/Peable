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

const fakeProvider = {
  id: "stripe" as const,
  refund: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "refund", request });
    if (refundThrows) throw refundThrows;
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
const { uuidv7 } = await import("@oxyhq/db");

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
  });

  afterAll(() => {
    useFake = false;
  });

  test("refunds part of a payment and moves it to partially_refunded", async () => {
    const intent = await settledIntent("10000");
    const { refund, created, paymentStatus } = await createRefund({
      merchantId: merchant.id,
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
      intent: first,
      externalRef: "order_two_a",
      amount: "4000",
    });
    const reread = await findIntentByPublicId(gatewayDb(), first.publicId);
    const { paymentStatus } = await createRefund({
      merchantId: merchant.id,
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
      intent,
      externalRef: "order_dup",
      amount: "2500",
    });
    providerCalls.length = 0;
    const second = await createRefund({
      merchantId: merchant.id,
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
      intent,
      externalRef: "order_left_a",
      amount: "8000",
    });
    const reread = await findIntentByPublicId(gatewayDb(), intent.publicId);

    await expect(
      createRefund({
        merchantId: merchant.id,
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
        intent,
        externalRef: "order_retryable",
        amount: "1000",
      }),
    ).rejects.toThrow(ProviderError);

    const rows = await listRefundsForIntent(gatewayDb(), intent.id);
    expect(rows[0]?.status).toBe("pending");
    // ...and pending money has not moved, so it does not reduce the balance.
    expect(await remainingRefundable(intent)).toBe("10000");
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
        intent,
        externalRef: "order_big",
        amount: "9007199254740993",
      }),
    ).rejects.toThrow(RefundExceedsRemainingError);
  });
});
