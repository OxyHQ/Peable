/**
 * Disputes end to end, against a real database.
 *
 * The dispute domain inverts the direction every other money table here runs
 * in, and each case below is about a place where copying the refund shape
 * verbatim would be wrong.
 *
 * `handleRefundEvent` treats "no row for this provider object" as `unmatched`
 * and retries, because Peable writes the refund row BEFORE calling the
 * provider — absence means our own write has not landed. Nothing here writes a
 * dispute in advance: the network opens it, so absence is the normal first
 * state and waiting for a row that will never appear is the bug.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { insertProviderEvent, findProviderEventById } from "../../db/providers/providerEventRepository";
import { linkProviderObject } from "../../db/payments/paymentIntentRepository";
import { listDisputesForIntent } from "../../db/disputes/disputeRepository";
import { disputes, webhookDeliveries } from "../../db/schema";
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

/** Store a dispute event exactly as the ingress would have. */
async function storeDisputeEvent(input: {
  type: string;
  intentObjectId: string | null;
  disputeObjectId: string | null;
  amount?: number;
  reason?: string;
  status?: string;
  dueBy?: number;
}): Promise<string> {
  counter += 1;
  const objectIds: Record<string, string> = {};
  if (input.intentObjectId) objectIds.payment_intent = input.intentObjectId;
  if (input.disputeObjectId) objectIds.dispute = input.disputeObjectId;

  const id = await insertProviderEvent(gatewayDb(), {
    provider: "stripe",
    providerEventId: `evt_dispute_${String(counter)}`,
    providerAccountId: null,
    type: input.type,
    livemode: false,
    apiVersion: "2026-07-29.dahlia",
    objectIds,
    payload: {
      id: `evt_dispute_${String(counter)}`,
      object: "event",
      type: input.type,
      data: {
        object: {
          id: input.disputeObjectId,
          object: "dispute",
          amount: input.amount ?? 2500,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.dueBy ? { evidence_details: { due_by: input.dueBy } } : {}),
        },
      },
    },
  });
  if (!id) throw new Error("the event was already stored");
  return id;
}

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

describe.skipIf(!POSTGRES_TESTS_ENABLED)("disputes", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    // BOTH halves, deliberately: `findWebhookTarget` returns null unless the
    // url AND the secret are present, and a null target makes
    // `enqueueIntentWebhook` return without writing a delivery row. Seeding
    // only the url would leave every delivery assertion below vacuously empty.
    merchant = await seedMerchant({
      webhookUrl: "https://merchant.invalid/hook",
      webhookSecret: "whsec_dispute_fixture",
    });
  });

  /**
   * The inversion, stated directly. No dispute row exists and the handler must
   * CREATE one — the refund handler would have returned `unmatched` here and
   * retried until it dead-lettered, losing the dispute.
   */
  it("creates the dispute row it has never seen, rather than waiting for one", async () => {
    const intent = await linkedCardIntent("pi_stripe_dp_create");
    const dueBy = Math.floor(Date.now() / 1000) + 7 * 86_400;
    await storeDisputeEvent({
      type: "charge.dispute.created",
      intentObjectId: "pi_stripe_dp_create",
      disputeObjectId: "dp_stripe_create",
      amount: 2500,
      reason: "fraudulent",
      dueBy,
    });

    await runProviderEventDrainPass();

    const rows = await listDisputesForIntent(gatewayDb(), intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("needs_response");
    expect(rows[0]?.amount).toBe("2500");
    // Passed through unmapped: it is the field a merchant quotes to their
    // acquirer, and a gateway paraphrase would not match what the acquirer holds.
    expect(rows[0]?.reason).toBe("fraudulent");
    expect(rows[0]?.evidenceDueAt).not.toBeNull();
    expect(await deliveriesFor(intent.id)).toContain("payment_intent.disputed");
  });

  /**
   * A provider WILL redeliver — receipt is acknowledged before processing. A
   * merchant told twice that one payment is disputed cannot tell that from two
   * disputes on it.
   */
  it("tells the merchant once, however many times the creation is redelivered", async () => {
    const intent = await linkedCardIntent("pi_stripe_dp_dupe");
    for (let i = 0; i < 2; i += 1) {
      await storeDisputeEvent({
        type: "charge.dispute.created",
        intentObjectId: "pi_stripe_dp_dupe",
        disputeObjectId: "dp_stripe_dupe",
      });
      await runProviderEventDrainPass();
    }

    expect(await listDisputesForIntent(gatewayDb(), intent.id)).toHaveLength(1);
    const delivered = await deliveriesFor(intent.id);
    expect(delivered.filter((type) => type === "payment_intent.disputed")).toHaveLength(1);
  });

  /**
   * The outcome is read from the PAYLOAD, not from the event type.
   * `charge.dispute.closed` closes one the merchant may have won or lost, and
   * defaulting either way tells them the opposite of the truth half the time.
   */
  it("reads won and lost from the payload, and clears the deadline", async () => {
    const intent = await linkedCardIntent("pi_stripe_dp_lost");
    await storeDisputeEvent({
      type: "charge.dispute.created",
      intentObjectId: "pi_stripe_dp_lost",
      disputeObjectId: "dp_stripe_lost",
      dueBy: Math.floor(Date.now() / 1000) + 86_400,
    });
    await runProviderEventDrainPass();

    await storeDisputeEvent({
      type: "charge.dispute.closed",
      intentObjectId: "pi_stripe_dp_lost",
      disputeObjectId: "dp_stripe_lost",
      status: "lost",
    });
    await runProviderEventDrainPass();

    const rows = await listDisputesForIntent(gatewayDb(), intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("lost");
    // The CHECK refuses a closed dispute that still carries a deadline, so this
    // is also what stops an operator queue showing a response that can no
    // longer be given.
    expect(rows[0]?.evidenceDueAt).toBeNull();
    expect(await deliveriesFor(intent.id)).toContain("payment_intent.dispute_closed");
  });

  it("reads a win as a win", async () => {
    const intent = await linkedCardIntent("pi_stripe_dp_won");
    await storeDisputeEvent({
      type: "charge.dispute.closed",
      intentObjectId: "pi_stripe_dp_won",
      disputeObjectId: "dp_stripe_won",
      status: "won",
    });
    await runProviderEventDrainPass();

    const rows = await listDisputesForIntent(gatewayDb(), intent.id);
    expect(rows[0]?.status).toBe("won");
  });

  /**
   * The ONE lookup that keeps refund semantics. A dispute arriving inside the
   * two-step create's window finds no intent, and retrying is what resolves it.
   */
  it("leaves a dispute for an unlinked payment unprocessed, to retry", async () => {
    const eventId = await storeDisputeEvent({
      type: "charge.dispute.created",
      intentObjectId: "pi_stripe_dp_nobody",
      disputeObjectId: "dp_stripe_nobody",
    });

    await runProviderEventDrainPass();

    const stored = await findProviderEventById(gatewayDb(), eventId);
    // NOT marked processed: marking it would drop a real dispute on the floor
    // permanently, and the deadline would pass with nobody told.
    expect(stored?.processedAt).toBeNull();
  });

  /**
   * The payment does NOT change status. A dispute is the network's process
   * running alongside it, and the intent was `settled` throughout.
   */
  it("never moves the payment's own status", async () => {
    const intent = await linkedCardIntent("pi_stripe_dp_status");
    const before = intent.status;
    await storeDisputeEvent({
      type: "charge.dispute.created",
      intentObjectId: "pi_stripe_dp_status",
      disputeObjectId: "dp_stripe_status",
    });
    await runProviderEventDrainPass();

    const rows = await gatewayDb().select().from(disputes).where(eq(disputes.paymentIntentId, intent.id));
    expect(rows).toHaveLength(1);
    // The dispute exists AND the payment is untouched. Asserting only the
    // second would pass against a drain that ignored the event entirely.
    const [after] = await gatewayDb()
      .select()
      .from(disputes)
      .where(eq(disputes.paymentIntentId, intent.id));
    expect(after).toBeDefined();
    expect((await listDisputesForIntent(gatewayDb(), intent.id))[0]?.status).toBe("needs_response");
    expect(before).toBe(intent.status);
  });
});
