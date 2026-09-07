/**
 * A transition decided against a status the intent has already left.
 *
 * ## The race, and why it is not theoretical
 *
 * Every caller of `transitionIntent` reads the intent, hands its status to
 * `applyEvent` to decide a target, and only then writes. Between the read and
 * the write, `expireDueIntents` can claim the same row — it is a set-based
 * `UPDATE … RETURNING` running on its own timer, against exactly the
 * pre-payment statuses those callers are transitioning out of.
 *
 * The write used to be `WHERE id = ?` alone, so the second writer won whatever
 * it had decided from. `ALLOWED` in the shared contract has `expired: []` —
 * terminal — and the database happily took `settled` over `expired` anyway,
 * because the state machine only ever ran in a pure function over a stale read.
 * The merchant was then told twice about one payment, with two outcomes that
 * contradict each other.
 *
 * ## Why this is a realdb file
 *
 * The property under test is a property of the STATEMENT: that
 * `status = <from>` is in the WHERE and that the update matches nothing when it
 * is not. A mocked update returns whatever the test wired and would pass with
 * the predicate deleted — which is the failure this file exists to catch.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  expireDueIntents,
  findIntentById,
  updateIntentState,
} from "../../db/payments/paymentIntentRepository";
import { webhookDeliveries } from "../../db/schema";
import { transitionIntent } from "../intentTransition";
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import type { MerchantRow } from "../../db/merchants/merchantRepository";
import { POSTGRES_TESTS_ENABLED } from "../../db/testDatabase";

const PAST = new Date(Date.now() - 60_000);
/** Generous: these cases are about WHICH row is claimed, never about batching. */
const BATCH = 100;

let merchant: MerchantRow;

async function deliveryTypesFor(intentId: string): Promise<string[]> {
  const rows = await gatewayDb()
    .select({ eventType: webhookDeliveries.eventType })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.paymentIntentId, intentId));
  return rows.map((row) => row.eventType);
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("a transition from a status the intent has left", () => {
  useGatewayDatabase();

  beforeEach(async () => {
    // BOTH halves: `findWebhookTarget` returns null without a url AND a secret,
    // and a null target makes the enqueue a no-op — so the delivery counts
    // below would pass vacuously on a merchant with only one of them.
    merchant = await seedMerchant({
      webhookUrl: "https://merchant.invalid/hook",
      webhookSecret: "whsec_stale_transition",
    });
  });

  /**
   * THE regression, in the order it actually happens: the sweeper commits
   * first, and the settlement that was decided a moment earlier arrives second.
   */
  it("refuses to write over a row the expiry sweeper already claimed", async () => {
    const intent = await seedIntent(merchant, { expiresAt: PAST });
    // What a caller read before deciding. Everything below is that caller
    // finishing its work against a row that has since moved.
    const observed = intent.status;

    const expired = await expireDueIntents(gatewayDb(), new Date(), BATCH);
    expect(expired.map((row) => row.id)).toContain(intent.id);

    const late = await transitionIntent(intent.id, { from: observed, status: "settled" });

    expect(late.kind).toBe("stale");
    expect(late.kind === "stale" ? late.current : undefined).toBe("expired");
    // The row is untouched — `expired` is terminal and stays so.
    expect((await findIntentById(gatewayDb(), intent.id))?.status).toBe("expired");
  });

  /**
   * The half that costs a merchant money to get wrong.
   *
   * A refused transition must enqueue NOTHING. `transitionIntent` writes the
   * outbox row inside the same transaction as the status change (ADR 0001 D7),
   * so an enqueue that survived a refused update would tell the merchant their
   * payment succeeded — moments after telling them it expired, about the same
   * payment, with no way to tell which is true.
   */
  it("enqueues exactly the expiry event, and nothing for the refused write", async () => {
    const intent = await seedIntent(merchant, { expiresAt: PAST });
    const observed = intent.status;

    await expireDueIntents(gatewayDb(), new Date(), BATCH);
    // The sweeper enqueues on its own `tx` via `enqueueIntentWebhook`; this is
    // the state the late writer arrives into.
    const afterSweep = await deliveryTypesFor(intent.id);

    await transitionIntent(intent.id, { from: observed, status: "settled" });

    expect(await deliveryTypesFor(intent.id)).toEqual(afterSweep);
    expect(await deliveryTypesFor(intent.id)).not.toContain("payment_intent.settled");
  });

  /**
   * `missing` is not `stale`, and the difference reaches a caller: a route
   * answers 404 for one and 409 for the other. Collapsing them told a merchant
   * their payment did not exist when it did.
   */
  it("tells a row that moved apart from a row that is not there", async () => {
    const intent = await seedIntent(merchant, { expiresAt: PAST });
    await expireDueIntents(gatewayDb(), new Date(), BATCH);

    expect(await transitionIntent(intent.id, { from: "created", status: "settled" })).toMatchObject({
      kind: "stale",
    });
    expect(
      await transitionIntent("00000000-0000-7000-8000-000000000000", {
        from: "created",
        status: "settled",
      }),
    ).toEqual({ kind: "missing" });
  });

  /**
   * Vacuity floor. Every case above asserts a REFUSAL, and all of them would
   * also pass against a repository that refused every write — including the
   * legitimate ones. This is the one that proves the predicate lets the right
   * write through.
   */
  it("still applies a transition from the status the row actually holds", async () => {
    const intent = await seedIntent(merchant);

    const moved = await updateIntentState(gatewayDb(), intent.id, {
      from: intent.status,
      status: "broadcast",
      txid: "f".repeat(64),
    });

    expect(moved.kind).toBe("updated");
    expect(moved.kind === "updated" ? moved.row.status : undefined).toBe("broadcast");
  });
});
