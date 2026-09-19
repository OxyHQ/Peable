/**
 * Refund events, through the REAL redaction, against a real database.
 *
 * ## Why every payload here is redacted first
 *
 * `provider_events.payload` is written by `ingestProviderDelivery`, which
 * redacts before it stores. A test that hands a handler a raw payload therefore
 * exercises a shape production never sees — and the difference is not cosmetic:
 * the allow-list leaves `"[redacted]"` where a value was dropped, not a hole,
 * so a `typeof x === "number"` guard silently answers false and the handler
 * reads as "the provider sent nothing". That is exactly how the dispute
 * deadline was lost for every dispute, invisibly, with the handler's own test
 * passing.
 *
 * So `storeEvent` below redacts, and these tests fail if a field a handler
 * depends on is not on the allow-list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const providerCalls: string[] = [];

const fakeProvider = {
  id: "stripe" as const,
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
    providerCalls.push("getStatus");
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

const { processProviderEvent } = await import("../providers/eventProcessor");
const { redactProviderPayload } = await import("../providers/redact");
const { insertProviderEvent, findProviderEventById, findUnprocessedProviderEvents } =
  await import("../../db/providers/providerEventRepository");
const {
  insertRefund,
  linkRefundObject,
  listRefundsForIntent,
  markRefundSucceeded,
  sumSucceededRefunds,
} = await import("../../db/refunds/refundRepository");
const {
  findIntentByPublicId,
  insertPaymentIntent,
  linkProviderCharge,
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
let eventCounter = 0;
let intentCounter = 0;

/**
 * Store an event exactly as a verified ingress would have — REDACTED.
 *
 * The one thing this file does differently from a handler unit test, and the
 * reason it can see a field the allow-list drops.
 */
async function storeEvent(
  type: string,
  objectIds: Record<string, string>,
  object: Record<string, unknown>,
): Promise<string> {
  eventCounter += 1;
  const providerEventId = `evt_refund_${String(eventCounter)}`;
  const id = await insertProviderEvent(gatewayDb(), {
    provider: "stripe",
    providerEventId,
    providerAccountId: null,
    type,
    livemode: false,
    apiVersion: "2026-07-29.dahlia",
    objectIds,
    payload: redactProviderPayload({
      id: providerEventId,
      object: "event",
      type,
      livemode: false,
      data: { object },
    }),
  });
  if (!id) throw new Error("the event was already stored");
  return id;
}

/** Drain one stored event through the real processor. */
async function processOne(eventId: string) {
  const pending = await findUnprocessedProviderEvents(gatewayDb(), 50);
  const row = pending.find((entry) => entry.id === eventId);
  if (!row) throw new Error(`event ${eventId} was not pending`);
  return processProviderEvent(row);
}

/** A settled card payment with a charge recorded against it. */
async function settledIntent(amount: string) {
  intentCounter += 1;
  const suffix = String(intentCounter);
  const intent = await insertPaymentIntent(gatewayDb(), {
    publicId: `pi_revt_${suffix}`,
    merchantId: merchant.id,
    rail: "card",
    amount,
    currency: "EUR",
    network: null,
    address: null,
    provider: "stripe",
    clientSecret: `cs_revt_${suffix}`,
    idempotencyKey: uuidv7(),
    metadata: {},
    expiresAt: new Date(Date.now() + 900_000),
  });
  if (!intent) throw new Error("could not seed the intent");
  await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_revt_${suffix}`);
  await linkProviderCharge(gatewayDb(), intent.id, "stripe", `ch_stripe_revt_${suffix}`);
  await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });
  return { intent, suffix };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("refund events", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();
  });

  beforeEach(() => {
    providerCalls.length = 0;
  });

  afterAll(() => {
    useFake = false;
  });

  /**
   * A refund that FAILED after the provider had accepted it.
   *
   * `refund.failed` was not in the drain's event set at all, so a bank
   * rejecting a refund days later reached this gateway, was stored, and did
   * nothing: the row stayed `succeeded`, the payment stayed `refunded`, and the
   * merchant's books said money had gone back that was still with them.
   */
  test("a refund.failed moves the row and the payment back", async () => {
    const { intent, suffix } = await settledIntent("10000");
    const inserted = await insertRefund(gatewayDb(), {
      publicId: `re_fail_${suffix}`,
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      externalRef: `order_fail_${suffix}`,
      amount: "10000",
      currency: "EUR",
      provider: "stripe",
    });
    if (!inserted) throw new Error("could not seed the refund");
    await markRefundSucceeded(gatewayDb(), inserted.id, `re_stripe_fail_${suffix}`);
    // The payment is `refunded`, because the refund succeeded. Re-read first:
    // `settledIntent` returns the row as INSERTED (`created`), and
    // `applyRefundToIntent` decides the transition from the status it is handed.
    const settled = await findIntentByPublicId(gatewayDb(), intent.publicId);
    const { applyRefundToIntent } = await import("../refunds/refundService");
    expect(await applyRefundToIntent(settled!)).toBe("refunded");

    const eventId = await storeEvent(
      "refund.failed",
      { refund: `re_stripe_fail_${suffix}`, payment_intent: `pi_stripe_revt_${suffix}` },
      {
        id: `re_stripe_fail_${suffix}`,
        object: "refund",
        amount: 10000,
        status: "failed",
        failure_reason: "insufficient_funds",
      },
    );

    const outcome = await processOne(eventId);
    expect(outcome.kind).toBe("applied");

    const rows = await listRefundsForIntent(gatewayDb(), intent.id);
    expect(rows[0]?.status).toBe("failed");
    /**
     * The REASON survived redaction.
     *
     * `failure_reason` was not on the allow-list, so it stored as
     * `"[redacted]"` — a failed refund whose cause was unreadable in the one
     * table a support query looks at.
     */
    expect(rows[0]?.failureCode).toBe("insufficient_funds");
    expect(await sumSucceededRefunds(gatewayDb(), intent.id)).toBe("0");

    /**
     * ...and the PAYMENT stops claiming it was refunded.
     *
     * `refunded` used to be terminal in the transition table, so this was
     * unreachable: a payment whose only refund failed would say `refunded`
     * forever while the money was still with the merchant, with no legal
     * transition able to correct it. `refund_voided` is that transition, and
     * the target is recomputed from the sum rather than stepped.
     */
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
  });

  /**
   * A refund the provider reported as PENDING, later confirmed.
   *
   * The handler used to ignore the event's own status and simply re-sum the
   * rows — which for a pending refund means re-summing zero, forever. The
   * refund's outcome never reached the row and the payment never moved.
   */
  test("a refund.updated carrying succeeded settles the pending row", async () => {
    const { intent, suffix } = await settledIntent("10000");
    const inserted = await insertRefund(gatewayDb(), {
      publicId: `re_pend_${suffix}`,
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      externalRef: `order_pend_${suffix}`,
      amount: "4000",
      currency: "EUR",
      provider: "stripe",
    });
    if (!inserted) throw new Error("could not seed the refund");
    // Pending, with the provider's id recorded — which is the ONLY handle this
    // event can be matched on.
    await linkRefundObject(gatewayDb(), inserted.id, `re_stripe_pend_${suffix}`);

    const eventId = await storeEvent(
      "refund.updated",
      { refund: `re_stripe_pend_${suffix}`, payment_intent: `pi_stripe_revt_${suffix}` },
      { id: `re_stripe_pend_${suffix}`, object: "refund", amount: 4000, status: "succeeded" },
    );

    const outcome = await processOne(eventId);
    expect(outcome).toEqual({
      kind: "applied",
      intentId: intent.id,
      status: "partially_refunded",
    });
    expect((await listRefundsForIntent(gatewayDb(), intent.id))[0]?.status).toBe("succeeded");
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe(
      "partially_refunded",
    );
  });

  /**
   * An out-of-order delivery must not walk a settled refund back.
   *
   * The provider acknowledges receipt before processing, so redeliveries and
   * reorderings are ordinary. `applyRefundState` only moves a row that is still
   * `pending`, which is what makes a late `pending` harmless.
   */
  test("a stale pending arriving after the success changes nothing", async () => {
    const { intent, suffix } = await settledIntent("10000");
    const inserted = await insertRefund(gatewayDb(), {
      publicId: `re_stale_${suffix}`,
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      externalRef: `order_stale_${suffix}`,
      amount: "5000",
      currency: "EUR",
      provider: "stripe",
    });
    if (!inserted) throw new Error("could not seed the refund");
    await markRefundSucceeded(gatewayDb(), inserted.id, `re_stripe_stale_${suffix}`);

    const eventId = await storeEvent(
      "refund.updated",
      { refund: `re_stripe_stale_${suffix}`, payment_intent: `pi_stripe_revt_${suffix}` },
      { id: `re_stripe_stale_${suffix}`, object: "refund", amount: 5000, status: "pending" },
    );

    await processOne(eventId);

    expect((await listRefundsForIntent(gatewayDb(), intent.id))[0]?.status).toBe("succeeded");
    expect(await sumSucceededRefunds(gatewayDb(), intent.id)).toBe("5000");
  });

  /**
   * A refund made ENTIRELY outside Peable — from the acquirer's dashboard.
   *
   * This used to be `unmatched` forever. The reasoning was that inventing a
   * merchant `external_ref` for a refund the merchant never made would put an
   * amount in this database that nothing chose — right about the reference and
   * wrong about the refund: the payer's money was back and the gateway still
   * called the payment `settled`, which is the disagreement a merchant
   * reconciles against and cannot explain.
   */
  test("imports a refund created at the provider, with no merchant reference", async () => {
    const { intent, suffix } = await settledIntent("10000");

    const eventId = await storeEvent(
      "refund.created",
      { refund: `re_stripe_import_${suffix}`, payment_intent: `pi_stripe_revt_${suffix}` },
      {
        id: `re_stripe_import_${suffix}`,
        object: "refund",
        amount: 2500,
        status: "succeeded",
      },
    );

    const outcome = await processOne(eventId);
    expect(outcome.kind).toBe("applied");

    const rows = await listRefundsForIntent(gatewayDb(), intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe("2500");
    expect(rows[0]?.status).toBe("succeeded");
    // No merchant reference, and `origin` says why rather than leaving a reader
    // to infer it from a null.
    expect(rows[0]?.externalRef).toBeNull();
    expect(rows[0]?.origin).toBe("provider");
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe(
      "partially_refunded",
    );
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).not.toBeNull();
  });

  /**
   * ...and a REDELIVERY of that import does not create a second row.
   *
   * The provider acknowledges receipt before processing, so it will redeliver.
   * The convergence is `refunds_provider_object_key` — the network's own id,
   * which is the only identity an imported refund has.
   */
  test("a redelivered import converges on the row it already made", async () => {
    const { intent, suffix } = await settledIntent("10000");
    const object = {
      id: `re_stripe_twice_${suffix}`,
      object: "refund",
      amount: 1000,
      status: "succeeded",
    };
    const ids = {
      refund: `re_stripe_twice_${suffix}`,
      payment_intent: `pi_stripe_revt_${suffix}`,
    };

    await processOne(await storeEvent("refund.created", ids, object));
    await processOne(await storeEvent("refund.updated", ids, object));

    expect(await listRefundsForIntent(gatewayDb(), intent.id)).toHaveLength(1);
    expect(await sumSucceededRefunds(gatewayDb(), intent.id)).toBe("1000");
  });

  /**
   * An import matched by the CHARGE rather than by the payment.
   *
   * A dispute-driven refund names the charge, and matching a `ch_…` against
   * `provider_object_id` finds nothing — silently, as an `unmatched` event
   * somebody eventually has to explain. `payment_intents.provider_charge_id`
   * and `findIntentByProviderCharge` are what make the lookup answerable.
   */
  test("imports a refund that names only the charge", async () => {
    const { intent, suffix } = await settledIntent("10000");

    const eventId = await storeEvent(
      "refund.created",
      { refund: `re_stripe_bycharge_${suffix}`, charge: `ch_stripe_revt_${suffix}` },
      {
        id: `re_stripe_bycharge_${suffix}`,
        object: "refund",
        amount: 3000,
        status: "succeeded",
      },
    );

    const outcome = await processOne(eventId);
    expect(outcome.kind).toBe("applied");
    const rows = await listRefundsForIntent(gatewayDb(), intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("provider");
  });

  /**
   * A refund naming a payment this gateway has never seen stays UNMATCHED.
   *
   * Not an error and not processed: the likeliest cause is our own two-step
   * create's window, which the next drain pass resolves. The other cause — a
   * refund on a payment belonging to a different integration on the same
   * provider account — resolves the same way from here: it stays, visibly, for
   * an operator.
   */
  test("leaves a refund for an unknown payment unmatched", async () => {
    const eventId = await storeEvent(
      "refund.created",
      { refund: "re_stripe_orphan", payment_intent: "pi_stripe_never_seen" },
      { id: "re_stripe_orphan", object: "refund", amount: 100, status: "succeeded" },
    );

    expect(await processOne(eventId)).toEqual({ kind: "unmatched" });
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).toBeNull();
  });
});
