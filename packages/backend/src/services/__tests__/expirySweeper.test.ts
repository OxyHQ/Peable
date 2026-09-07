import { test, expect, describe } from "bun:test";
import { PAYMENT_INTENT_STATUSES } from "@peable.to/shared-types";
import type { PaymentIntentStatus } from "@peable.to/shared-types";
import {
  EXPIRABLE_STATUSES,
  expireDueIntents,
  findIntentByPublicId,
  updateIntentState,
} from "../../db/payments/paymentIntentRepository";
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import { applyEvent } from "../intentState";
import { runExpirySweep } from "../expirySweeper";
import type { MerchantRow } from "../../db/merchants/merchantRepository";

const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
/** Generous: every case here is about WHICH rows are claimed, not batching. */
const BATCH = 100;
const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 60 * 60_000);

useGatewayDatabase();

async function merchant(publicId: string, oxyAppId: string): Promise<MerchantRow> {
  return seedMerchant({
    publicId,
    oxyAppId,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
  });
}

describe("EXPIRABLE_STATUSES agrees with the transition table", () => {
  // The constant is a hand-written list used by a set-based UPDATE, so it
  // cannot call `applyEvent` per row. This re-derives it from `applyEvent`
  // instead: if shared-types' ALLOWED table ever gains or loses an `expired`
  // edge, the constant goes red here rather than silently sweeping the wrong
  // rows — or, worse, expiring an intent with money in flight.
  //
  // `expired` itself is excluded, and that exclusion is load-bearing:
  // `applyEvent` is idempotent when current === target, so it returns
  // `"expired"` rather than throwing for an already-expired intent. A set-based
  // sweeper that trusted `applyEvent` alone would re-claim those rows on every
  // tick and re-fire `payment_intent.expired` forever.
  const derived = (PAYMENT_INTENT_STATUSES as PaymentIntentStatus[]).filter(
    (status) => {
      if (status === "expired") return false;
      try {
        return applyEvent(status, "expire") === "expired";
      } catch {
        return false;
      }
    },
  );

  test("the constant is exactly the set of statuses that may expire", () => {
    expect([...EXPIRABLE_STATUSES].sort()).toEqual([...derived].sort());
  });

  test("in-flight statuses are never expirable", () => {
    expect(EXPIRABLE_STATUSES).not.toContain("broadcast");
    expect(EXPIRABLE_STATUSES).not.toContain("confirming");
  });
});

describe("expireDueIntents", () => {
  test("expires a due intent and leaves a not-yet-due one alone", async () => {
    const m = await merchant("merch_expiry00000000000001", "app_expiry_1");
    const due = await seedIntent(m, { expiresAt: PAST });
    const notDue = await seedIntent(m, { expiresAt: FUTURE });

    const claimed = await expireDueIntents(gatewayDb(), new Date(), BATCH);

    expect(claimed.map((row) => row.publicId)).toEqual([due.publicId]);
    expect((await findIntentByPublicId(gatewayDb(), due.publicId))?.status).toBe("expired");
    expect((await findIntentByPublicId(gatewayDb(), notDue.publicId))?.status).toBe("created");
  });

  test("never expires an intent with money in flight, however overdue", async () => {
    const m = await merchant("merch_expiry00000000000002", "app_expiry_2");
    const inFlight = await seedIntent(m, { expiresAt: PAST });
    // `payment_intents_broadcast_requires_txid_check` needs both in one write.
    await updateIntentState(gatewayDb(), inFlight.id, {
      status: "broadcast",
      txid: "d".repeat(64),
    });

    const claimed = await expireDueIntents(gatewayDb(), new Date(), BATCH);

    expect(claimed).toHaveLength(0);
    expect((await findIntentByPublicId(gatewayDb(), inFlight.publicId))?.status).toBe(
      "broadcast",
    );
  });

  test("two concurrent sweepers never claim the same intent twice", async () => {
    const m = await merchant("merch_expiry00000000000003", "app_expiry_3");
    const overdue = await Promise.all(
      Array.from({ length: 8 }, () => seedIntent(m, { expiresAt: PAST })),
    );
    const now = new Date();

    // The real failure this guards: two ECS tasks sweep on their own timers. A
    // SELECT-then-UPDATE would hand both the same rows and fire the merchant's
    // `payment_intent.expired` webhook twice for one intent.
    const [a, b] = await Promise.all([
      expireDueIntents(gatewayDb(), now, BATCH),
      expireDueIntents(gatewayDb(), now, BATCH),
    ]);

    const claimedIds = [...a, ...b].map((row) => row.publicId);
    expect(claimedIds).toHaveLength(overdue.length);
    expect(new Set(claimedIds).size).toBe(overdue.length);
  });
});

describe("runExpirySweep", () => {
  test("expires every intent it claimed, and nothing else", async () => {
    const m = await merchant("merch_expiry00000000000004", "app_expiry_4");
    const due = await seedIntent(m, { expiresAt: PAST });
    const notDue = await seedIntent(m, { expiresAt: FUTURE });

    await runExpirySweep({ now: new Date() });

    // Asserted on the PERSISTED rows rather than on a callback, because the
    // sweep no longer announces through one: the merchant's event is a durable
    // outbox row written in the claiming transaction, and the socket frame goes
    // out after the commit. `expirySweeper.realdb.test.ts` covers the outbox
    // half; this covers which rows moved.
    expect((await findIntentByPublicId(gatewayDb(), due.publicId))?.status).toBe("expired");
    expect((await findIntentByPublicId(gatewayDb(), notDue.publicId))?.status).toBe("created");
  });

  test("a second sweep claims nothing, since the rows are already terminal", async () => {
    const m = await merchant("merch_expiry00000000000005", "app_expiry_5");
    await seedIntent(m, { expiresAt: PAST });

    await runExpirySweep({ now: new Date() });
    const second = await runExpirySweep({ now: new Date() });

    // The property that stops `payment_intent.expired` firing on every tick
    // forever: `expired` is not in `EXPIRABLE_STATUSES`, so a swept row is not
    // re-claimed. `applyEvent` alone would not give this — it is idempotent
    // when current === target and answers `"expired"` rather than throwing.
    expect(second).toEqual({ examined: 0, expired: 0 });
  });

  test("the injected clock decides what is due", async () => {
    const m = await merchant("merch_expiry00000000000006", "app_expiry_6");
    const later = await seedIntent(m, { expiresAt: FUTURE });

    await runExpirySweep({ now: new Date() });
    expect((await findIntentByPublicId(gatewayDb(), later.publicId))?.status).toBe("created");

    await runExpirySweep({ now: new Date(FUTURE.getTime() + 1_000) });
    expect((await findIntentByPublicId(gatewayDb(), later.publicId))?.status).toBe("expired");
  });

  test("honours its batch size, so a backlog drains rather than landing at once", async () => {
    const m = await merchant("merch_expiry00000000000007", "app_expiry_7");
    await Promise.all(Array.from({ length: 5 }, () => seedIntent(m, { expiresAt: PAST })));

    // The bound neither implementation of this sweeper had. Unbounded, the
    // first sweep after a backlog builds holds every row lock until it commits
    // and enqueues the whole backlog of webhooks in one burst.
    const first = await runExpirySweep({ now: new Date(), batchSize: 2 });
    expect(first.expired).toBe(2);
  });
});
