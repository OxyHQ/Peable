/**
 * The drain, end to end: a stored provider event becomes payment state and a
 * merchant's webhook, against a real database.
 *
 * This is the half of the card rail that a passing ingress test says nothing
 * about. Every case below is about a decision that is invisible from either
 * side alone — what an event about an unlinked intent does, what a redelivery
 * does, what an event this drain does not understand does — and each of those
 * has a wrong answer that loses money or spins forever.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { insertProviderEvent } from "../../db/providers/providerEventRepository";
import { findProviderEventById } from "../../db/providers/providerEventRepository";
import {
  findIntentByPublicId,
  linkProviderObject,
} from "../../db/payments/paymentIntentRepository";
import { webhookDeliveries } from "../../db/schema";
import { runProviderEventDrainPass } from "../providerEventDrain";
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { POSTGRES_TESTS_ENABLED } from "../../db/testDatabase";

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let counter = 0;

/** Store an event exactly as the ingress would have. */
async function storeEvent(type: string, objectId: string | null): Promise<string> {
  counter += 1;
  const id = await insertProviderEvent(gatewayDb(), {
    provider: "stripe",
    providerEventId: `evt_${String(counter)}`,
    providerAccountId: null,
    type,
    livemode: false,
    apiVersion: "2026-07-29.dahlia",
    objectIds: objectId ? { payment_intent: objectId } : {},
    payload: { id: `evt_${String(counter)}`, object: "event", type },
  });
  if (!id) throw new Error("the event was already stored");
  return id;
}

/** A card intent already linked to a provider object, as after a normal create. */
async function linkedCardIntent(objectId: string) {
  const intent = await seedIntent(merchant, { rail: "card", currency: "EUR", amount: "2500" });
  await linkProviderObject(gatewayDb(), intent.id, "stripe", objectId);
  return intent;
}

async function deliveriesFor(intentId: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ eventType: webhookDeliveries.eventType })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.paymentIntentId, intentId));
  return rows.map((row) => row.eventType);
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("the provider event drain", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    // WITH a webhook target, so the transition's outbox write is exercised:
    // settling a payment and not telling the merchant is the failure this whole
    // rail exists to avoid.
    merchant = await seedMerchant({
      webhookUrl: "https://merchant.example/hooks",
      webhookSecret: "whsec_merchant_test",
    });
  });

  beforeEach(() => {
    counter += 1000;
  });

  afterAll(() => {
    // Nothing to stop: this suite drives `runProviderEventDrainPass` by hand
    // rather than starting the interval, so there is no timer to leak.
  });

  it("settles a card payment and enqueues the merchant's event", async () => {
    const intent = await linkedCardIntent("pi_stripe_settle");
    await storeEvent("payment_intent.succeeded", "pi_stripe_settle");

    const result = await runProviderEventDrainPass();
    expect(result.applied).toBeGreaterThanOrEqual(1);

    const after = await findIntentByPublicId(gatewayDb(), intent.publicId);
    expect(after?.status).toBe("settled");
    expect(await deliveriesFor(intent.id)).toContain("payment_intent.settled");
  });

  it("fails a declined payment and tells the merchant", async () => {
    const intent = await linkedCardIntent("pi_stripe_declined");
    await storeEvent("payment_intent.payment_failed", "pi_stripe_declined");

    await runProviderEventDrainPass();

    const after = await findIntentByPublicId(gatewayDb(), intent.publicId);
    expect(after?.status).toBe("failed");
    expect(await deliveriesFor(intent.id)).toContain("payment_intent.failed");
  });

  /**
   * A provider cancellation is a REJECTION, not an expiry. Expiry is this
   * gateway's own clock running out, and conflating the two would put payments
   * the sweeper never touched into its numbers.
   */
  it("treats a provider cancellation as a rejection", async () => {
    const intent = await linkedCardIntent("pi_stripe_canceled");
    await storeEvent("payment_intent.canceled", "pi_stripe_canceled");

    await runProviderEventDrainPass();

    const after = await findIntentByPublicId(gatewayDb(), intent.publicId);
    expect(after?.status).toBe("rejected");
  });

  /**
   * The pre-payment statuses tell a merchant nothing they act on, so they move
   * the intent and enqueue NOTHING. A merchant integrating on Stripe-shaped
   * ergonomics acts on outcomes.
   */
  it("moves the intent to processing without enqueueing an event", async () => {
    const intent = await linkedCardIntent("pi_stripe_processing");
    await storeEvent("payment_intent.processing", "pi_stripe_processing");

    await runProviderEventDrainPass();

    const after = await findIntentByPublicId(gatewayDb(), intent.publicId);
    expect(after?.status).toBe("processing");
    expect(await deliveriesFor(intent.id)).toEqual([]);
  });

  /**
   * A redelivery of an event already applied.
   *
   * Stripe redelivers, and it redelivers events for payments that are long
   * settled. This must be an ordinary no-op — and it must NOT enqueue a second
   * `payment_intent.settled`, or a merchant releasing inventory on that event
   * releases it twice.
   */
  it("absorbs a redelivery without moving the intent or duplicating the event", async () => {
    const intent = await linkedCardIntent("pi_stripe_redeliver");
    await storeEvent("payment_intent.succeeded", "pi_stripe_redeliver");
    await runProviderEventDrainPass();

    const deliveriesAfterFirst = await deliveriesFor(intent.id);
    expect(deliveriesAfterFirst).toEqual(["payment_intent.settled"]);

    // The provider sends it again, under a new event id — which is what a
    // redelivery of an already-2xx'd event looks like when the endpoint is
    // reconfigured, so the dedupe index does not catch it.
    await storeEvent("payment_intent.succeeded", "pi_stripe_redeliver");
    const second = await runProviderEventDrainPass();

    expect(second.noop).toBeGreaterThanOrEqual(1);
    const after = await findIntentByPublicId(gatewayDb(), intent.publicId);
    expect(after?.status).toBe("settled");
    expect(await deliveriesFor(intent.id)).toEqual(["payment_intent.settled"]);
  });

  /**
   * THE case that must not be marked handled.
   *
   * An event about an object no intent claims is overwhelmingly the two-step
   * create's own window — the row exists, `linkProviderObject` has not run yet,
   * and Stripe's event beat it by milliseconds. Marking it processed would drop
   * a real settlement on the floor, permanently, with a green build.
   */
  it("leaves an event for an unlinked payment unprocessed, and applies it once the link lands", async () => {
    const intent = await seedIntent(merchant, {
      rail: "card",
      currency: "EUR",
      amount: "2500",
    });
    const eventId = await storeEvent("payment_intent.succeeded", "pi_stripe_racing");

    const first = await runProviderEventDrainPass();
    expect(first.unmatched).toBeGreaterThanOrEqual(1);

    // Still unprocessed, and therefore still in the drain's set.
    const stored = await findProviderEventById(gatewayDb(), eventId);
    expect(stored?.processedAt).toBeNull();
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("created");

    // The create finishes.
    await linkProviderObject(gatewayDb(), intent.id, "stripe", "pi_stripe_racing");

    const second = await runProviderEventDrainPass();
    expect(second.applied).toBeGreaterThanOrEqual(1);
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).not.toBeNull();
  });

  /**
   * An event type the drain does not act on is HANDLED, not failed.
   *
   * Refunds land here today; disputes no longer do — `charge.dispute.*` is
   * routed and acted on. Marking an unmapped event processed is what keeps it
   * out of the drain's set — the alternative is a row retried on every
   * pass forever, and an operator surface where "unprocessed" stops meaning
   * anything.
   */
  it("marks an unmapped event handled rather than retrying it forever", async () => {
    const eventId = await storeEvent("charge.refunded", "pi_stripe_settle");

    const result = await runProviderEventDrainPass();
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const stored = await findProviderEventById(gatewayDb(), eventId);
    expect(stored?.processedAt).not.toBeNull();
    expect(stored?.processingError).toBeNull();

    // ...and it is out of the drain's set for good. Asserted on THIS row rather
    // than on the pass being empty: the suite database is shared with the other
    // cases here, and two of them deliberately leave unprocessed rows behind.
    await runProviderEventDrainPass();
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).not.toBeNull();
  });

  /**
   * A mapped event with no payment id is a bug HERE — the envelope and the map
   * disagree — so it is recorded on the row rather than silently skipped.
   */
  it("records a failure on a mapped event that names no payment", async () => {
    const eventId = await storeEvent("payment_intent.succeeded", null);

    const result = await runProviderEventDrainPass();
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const stored = await findProviderEventById(gatewayDb(), eventId);
    expect(stored?.processingError).toContain("payment_intent");
    // Unprocessed, so an operator can see it.
    expect(stored?.processedAt).toBeNull();
  });

  /**
   * One poisonous row must not stop the rows behind it. The drain works a
   * batch, and a failure that aborted the pass would let a single bad event
   * hold up every settlement after it.
   */
  it("keeps going past a failure and applies the events behind it", async () => {
    const intent = await linkedCardIntent("pi_stripe_after_poison");
    await storeEvent("payment_intent.succeeded", null);
    await storeEvent("payment_intent.succeeded", "pi_stripe_after_poison");

    const result = await runProviderEventDrainPass();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
  });

  /**
   * Ordering. Two events about one payment arrive as `processing` then
   * `succeeded`; applied in the wrong order the second is an illegal
   * transition. The drain reads oldest-first and works sequentially, which is
   * what makes this hold.
   */
  it("applies two events about one payment in the order they arrived", async () => {
    const intent = await linkedCardIntent("pi_stripe_ordered");
    await storeEvent("payment_intent.processing", "pi_stripe_ordered");
    await storeEvent("payment_intent.succeeded", "pi_stripe_ordered");

    // Asserted on the INTENT, not on the pass's failure count: the shared suite
    // database still holds the deliberately-failing rows the two cases above
    // left, and they are counted by every later pass.
    await runProviderEventDrainPass();
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe("settled");
  });

  /**
   * A card event can never reach a FairCoin payment, and the reason is
   * structural rather than conditional: a faircoin intent carries no provider,
   * so the lookup that finds an intent for a provider object cannot match one.
   */
  it("cannot reach a faircoin intent", async () => {
    const chain = await seedIntent(merchant, { rail: "faircoin" });
    await storeEvent("payment_intent.succeeded", chain.address ?? "unreachable");

    const result = await runProviderEventDrainPass();
    expect(result.applied).toBe(0);
    expect((await findIntentByPublicId(gatewayDb(), chain.publicId))?.status).toBe("created");
  });
});
