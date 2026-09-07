/**
 * `onIntentChange` after the outbox (ADR 0001 D7).
 *
 * This used to be the whole fan-out — emit, POST the webhook inline, then
 * best-effort write a log row — and these tests pinned that. Two of those three
 * moved: the outbox row is written inside `transitionIntent`'s transaction, and
 * the HTTP call belongs to the dispatcher. What is left here is the part that
 * is not durable and must not be, so what the tests pin is the OTHER half of
 * that split — this function announces, and it enqueues NOTHING.
 *
 * The durable half is covered by `services/__tests__/webhookOutbox.realdb.test.ts`.
 */
import { test, expect } from "bun:test";
import type { Server as SocketServer } from "socket.io";
import { updateIntentState } from "../db/payments/paymentIntentRepository";
import { listDeliveriesForMerchant } from "../db/webhooks/webhookDeliveryRepository";
import { transitionIntent } from "../services/intentTransition";
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "./helpers/gatewayTestDatabase";
import { onIntentChange } from "../server";

useGatewayDatabase();

function fakeIo(): { io: SocketServer; rooms: () => string[] } {
  const rooms: string[] = [];
  const io = {
    to: (room: string) => {
      rooms.push(room);
      return { emit: () => undefined };
    },
  } as unknown as SocketServer;
  return { io, rooms: () => rooms };
}

/**
 * The transition and the enqueue are ONE commit, and this is what proves the
 * enqueue is on that side of the line rather than in the fan-out: the delivery
 * exists after `transitionIntent` and BEFORE `onIntentChange` is called at all.
 *
 * Under the previous design there was no row until after the HTTP call
 * returned, which is precisely the window a crash used to lose the event in.
 */
test("the outbox row exists before onIntentChange runs, not because of it", async () => {
  const merchant = await seedMerchant({
    webhookUrl: "https://merchant.example/hook",
    webhookSecret: "whsec_log",
  });
  const seeded = await seedIntent(merchant);
  const broadcast = await updateIntentState(gatewayDb(), seeded.id, {
    from: seeded.status,
    status: "broadcast",
    txid: "tx_delivery_log",
  });
  if (broadcast.kind !== "updated") throw new Error("intent fixture missing");

  const transition = await transitionIntent(broadcast.row.id, {
    from: "broadcast",
    status: "settled",
    confirmations: 1,
  });
  if (transition.kind !== "updated") throw new Error("transition returned no row");
  const settled = transition.row;

  const beforeAnnounce = (
    await listDeliveriesForMerchant(gatewayDb(), { merchantId: merchant.id, limit: 50 })
  ).data;
  expect(beforeAnnounce).toHaveLength(1);
  expect(beforeAnnounce[0]?.eventType).toBe("payment_intent.settled");
  expect(beforeAnnounce[0]?.lastStatus).toBe("pending");

  const { io, rooms } = fakeIo();
  await onIntentChange(io, settled);

  // Announcing emits, and creates nothing.
  expect(rooms()).toEqual([`intent:${settled.publicId}`]);
  const afterAnnounce = (
    await listDeliveriesForMerchant(gatewayDb(), { merchantId: merchant.id, limit: 50 })
  ).data;
  expect(afterAnnounce).toHaveLength(1);
});

/**
 * Still never throws.
 *
 * `SettlementWatcher.check()` awaits `onChange` inline per intent with no
 * per-iteration try/catch of its own, so a throw here stops the watcher
 * reconciling every intent after this one in the batch. The reason has changed
 * — there is no database write left to fail — and the contract has not.
 */
test("announcing an intent whose merchant has no webhook does not throw", async () => {
  const merchant = await seedMerchant();
  const intent = await seedIntent(merchant);

  const { io } = fakeIo();
  await expect(onIntentChange(io, intent)).resolves.toBeUndefined();
});
