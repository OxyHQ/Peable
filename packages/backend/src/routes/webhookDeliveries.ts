import { Router } from "express";
import type { RequestHandler } from "express";
import { oxyClient } from "@oxy.so/core";
import { getDb } from "../db/postgres";
import { findWebhookTarget } from "../db/merchants/merchantRepository";
import type { MerchantRow } from "../db/merchants/merchantRepository";
import { findIntentByIdForMerchant } from "../db/payments/paymentIntentRepository";
import { findDeliveryForMerchant } from "../db/webhooks/webhookDeliveryRepository";
import type { WebhookDeliveryRow } from "../db/webhooks/webhookDeliveryRepository";
import { enqueueWebhook } from "../db/webhooks/webhookOutboxRepository";
import type { SafeFetchFn } from "../services/webhookDispatcher";
import { runWebhookOutboxPass } from "../services/webhookOutbox";
import { toWebhookDeliveryDTO } from "../lib/serialize";
import { sendError, wrap, requireAuthenticated } from "../lib/http";
import { resolveMerchant } from "./paymentIntents";

export type RedeliverResult =
  | {
      ok: true;
      delivery: WebhookDeliveryRow;
      /**
       * The `pi_…` of the intent the redelivery was about. Carried alongside
       * the row because the row stores the intent's INTERNAL id while
       * `WebhookDelivery.intentId` on the wire is the public one, and this
       * path already loaded the intent to build the event.
       */
       intentPublicId: string;
    }
  | { ok: false; status: number; message: string };

/**
 * Shared redeliver core (F2.5) — factored out so `POST
 * /v1/webhook_deliveries/:id/redeliver` (service-authed, below) and the
 * dashboard's `POST
 * /v1/dashboard/applications/:applicationId/webhook_deliveries/:id/redeliver`
 * (human-authed) run the EXACT same lookup/redelivery/log logic against
 * different auth paths, never two copies to keep in sync.
 */
export async function redeliverWebhookDelivery(
  merchant: MerchantRow,
  deliveryId: string,
  deps: { safeFetch?: SafeFetchFn } = {},
): Promise<RedeliverResult> {
  const db = getDb();

  // No id-shape guard before the lookup. The Mongo path needed one because
  // `_id` had to parse as an ObjectId; these ids are `text`, so an id of any
  // shape simply matches no row — and the ownership-scoped read answers
  // "unknown" and "not yours" identically, which is the property that matters.
  const delivery = await findDeliveryForMerchant(db, deliveryId, merchant.id);
  if (!delivery) {
    return { ok: false, status: 404, message: "webhook delivery not found" };
  }

  // By the INTERNAL id the delivery stores, re-scoped to the merchant: the id
  // came out of a row rather than out of the request, so the scope is restated
  // in the WHERE clause rather than compared after the read.
  const intent = await findIntentByIdForMerchant(db, delivery.paymentIntentId, merchant.id);
  if (!intent) {
    return {
      ok: false,
      status: 404,
      message: "the payment intent for this delivery no longer exists",
    };
  }

  // The signing secret is never on `MerchantRow` — it is a protected column,
  // loaded explicitly and only on a delivery path.
  const target = await findWebhookTarget(db, merchant.id);
  if (!target) {
    return { ok: false, status: 422, message: "merchant has no webhook configured" };
  }

  // A delivery from before this table stored envelopes cannot be replayed: the
  // body was built, POSTed and discarded, so there is nothing to send. Saying
  // so is the only honest answer — the alternative is rebuilding the event from
  // today's intent, which is what this path used to do and what made a replayed
  // `payment_intent.settled` describe a different moment than the one it
  // claimed.
  if (Object.keys(delivery.payload).length === 0) {
    return {
      ok: false,
      status: 422,
      message: "this delivery predates stored envelopes and cannot be replayed",
    };
  }

  // The ORIGINAL envelope, replayed byte-for-byte — not a fresh one built from
  // the intent's state now.
  //
  // This path used to call `buildEvent(delivery.eventType, intent)`, which
  // rebuilt the event from whatever the intent looks like AT REDELIVERY TIME.
  // Replaying a `payment_intent.settled` from last week therefore sent a body
  // describing this week's intent, under an event type asserting a moment that
  // had passed. An event describes a moment; it does not get to change. The
  // stored `payload` is what makes replaying one honest.
  const enqueuedId = await enqueueWebhook(db, {
    merchantId: merchant.id,
    paymentIntentId: intent.id,
    event: delivery.payload as unknown as Parameters<typeof enqueueWebhook>[1]["event"],
    url: target.url,
  });

  // Run one pass INLINE so a person who pressed "redeliver" sees the outcome
  // rather than a row that says `pending`. It is only an early nudge: if the
  // attempt fails transiently the row keeps its schedule and the background
  // dispatcher carries on with it, which is the difference from the old
  // behaviour, where a failed redelivery was simply over.
  await runWebhookOutboxPass(deps.safeFetch ? { safeFetch: deps.safeFetch } : {});

  const redelivery = await findDeliveryForMerchant(db, enqueuedId, merchant.id);
  if (!redelivery) {
    return { ok: false, status: 404, message: "webhook delivery not found" };
  }

  return { ok: true, delivery: redelivery, intentPublicId: intent.publicId };
}

/**
 * Build the webhook-delivery REST router (F2.0 task 4's "reenviar" button).
 * `requireMerchant` follows the same injectable-default pattern as the other
 * routers; `safeFetch` is separately injectable so tests can capture the
 * outbound request without a real network call, mirroring how `createGateway`
 * already injects it for the settlement watcher's own webhook delivery.
 */
export function createWebhookDeliveriesRouter(deps: {
  requireMerchant: RequestHandler;
  safeFetch?: SafeFetchFn;
}): Router {
  const { requireMerchant, safeFetch } = deps;
  const router = Router();

  router.post(
    "/v1/webhook_deliveries/:id/redeliver",
    requireMerchant,
    requireAuthenticated,
    oxyClient.requireScope("payments:write"),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      // `noUncheckedIndexedAccess` types `req.params.id` as possibly
      // `undefined` even though Express guarantees `:id` is present here.
      const { id: deliveryId } = req.params;
      if (!deliveryId) {
        sendError(res, 422, "invalid_request_error", "id is required");
        return;
      }

      const result = await redeliverWebhookDelivery(merchant, deliveryId, { safeFetch });
      if (!result.ok) {
        sendError(res, result.status, "invalid_request_error", result.message);
        return;
      }
      res.status(200).json(toWebhookDeliveryDTO(result.delivery, result.intentPublicId));
    }),
  );

  return router;
}
