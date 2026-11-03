import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findEventForMerchant } from '../db/events/eventRepository';
import {
  findDeliveryForMerchant,
  listDeliveriesForMerchant,
} from '../db/webhooks/webhookDeliveryRepository';
import type { WebhookDeliveryRow } from '../db/webhooks/webhookDeliveryRepository';
import { findEndpointForMerchant } from '../db/webhooks/webhookEndpointRepository';
import { enqueueDelivery } from '../db/webhooks/webhookOutboxRepository';
import type { SafeFetchFn } from '../services/webhookDispatcher';
import { runWebhookOutboxPass } from '../services/webhookOutbox';
import { toWebhookDeliveryDTO } from '../lib/serialize';
import { sendError, wrap, requireAuthenticated } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  resolveListReference,
  surfaceListQuery,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

export type RedeliverResult =
  | { ok: true; delivery: WebhookDeliveryRow }
  | { ok: false; status: number; message: string };

/**
 * Shared redeliver core — `POST /v1/webhook_deliveries/:id/redeliver`
 * (service-authed, below) and the dashboard's
 * `POST /v1/dashboard/applications/:applicationId/webhook_deliveries/:id/redeliver`
 * run the EXACT same lookup and enqueue against different auth paths.
 *
 * A redelivery is a NEW delivery of the SAME stored event to the SAME
 * endpoint: the body is the event as it was recorded, never rebuilt from the
 * resource as it is now — an event describes a moment. The original row keeps
 * its own history.
 */
export async function redeliverWebhookDelivery(
  merchant: MerchantRow,
  deliveryId: string,
  deps: { safeFetch?: SafeFetchFn | undefined } = {},
): Promise<RedeliverResult> {
  const db = getDb();

  // No id-shape guard before the lookup: the ids are `text`, and the
  // ownership-scoped read answers "unknown" and "not yours" identically.
  const delivery = await findDeliveryForMerchant(db, deliveryId, merchant.id);
  if (!delivery) {
    return { ok: false, status: 404, message: 'webhook delivery not found' };
  }
  const endpoint = await findEndpointForMerchant(db, delivery.endpointPublicId, merchant.id);
  if (!endpoint) {
    return { ok: false, status: 404, message: 'webhook delivery not found' };
  }
  if (endpoint.status !== 'enabled') {
    return {
      ok: false,
      status: 400,
      message: 'the webhook endpoint of this delivery is disabled; enable it before redelivering',
    };
  }

  const enqueuedId = await enqueueDelivery(db, {
    merchantId: merchant.id,
    eventId: delivery.eventId,
    endpointId: endpoint.id,
    url: endpoint.url,
  });

  // One pass INLINE so a person who pressed "redeliver" sees the outcome rather
  // than a row that says `pending`. A transient failure keeps its schedule and
  // the background dispatcher carries on with it.
  await runWebhookOutboxPass(deps.safeFetch ? { safeFetch: deps.safeFetch } : {});

  const redelivery = await findDeliveryForMerchant(db, enqueuedId, merchant.id);
  if (!redelivery) {
    return { ok: false, status: 404, message: 'webhook delivery not found' };
  }
  return { ok: true, delivery: redelivery };
}

const deliveryListFilters = {
  /** Only the deliveries of this event (`evt_…`). */
  event: z.string().min(1).max(255).optional(),
  /** Only the deliveries to this endpoint (`we_…`). */
  webhook_endpoint: z.string().min(1).max(255).optional(),
} as const;

const listDeliveriesQuery = surfaceListQuery(deliveryListFilters);

/**
 * `GET /v1/webhook_deliveries` — the delivery log, newest first, optionally one
 * event's deliveries or one endpoint's. Both filters are PUBLIC ids, resolved
 * inside the merchant's scope: another merchant's id is the same 400 as an
 * unknown one.
 */
export async function answerWebhookDeliveryList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listDeliveriesQuery[surface]);
  if (!query) return;
  const db = getDb();
  const event = await resolveListReference(
    res,
    'event',
    query.event,
    async (publicId) => (await findEventForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!event.ok) return;
  const endpoint = await resolveListReference(
    res,
    'webhook_endpoint',
    query.webhook_endpoint,
    async (publicId) => (await findEndpointForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!endpoint.ok) return;

  await answerList(req, res, {
    query,
    type: 'webhook_delivery',
    merchantId: merchant.id,
    // Delivery ids are `text`, so a cursor of any shape simply matches no row,
    // and the ownership-scoped lookup produces the same 400.
    cursor: async (id) => (await findDeliveryForMerchant(db, id, merchant.id))?.id ?? null,
    fetch: (page) =>
      listDeliveriesForMerchant(db, {
        merchantId: merchant.id,
        page,
        eventId: event.id,
        endpointId: endpoint.id,
      }),
    serialize: toWebhookDeliveryDTO,
  });
}

/** The service-authed delivery log and redelivery. */
export function createWebhookDeliveriesRouter(deps: {
  requireMerchant: RequestHandler;
  safeFetch?: SafeFetchFn;
}): Router {
  const { requireMerchant, safeFetch } = deps;
  const router = Router();

  router.get(
    '/v1/webhook_deliveries',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await answerWebhookDeliveryList(req, res, merchant);
    }),
  );

  router.post(
    '/v1/webhook_deliveries/:id/redeliver',
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;

      const { id: deliveryId } = req.params;
      if (!deliveryId) {
        sendError(res, 400, 'invalid_request_error', 'id is required');
        return;
      }

      const result = await redeliverWebhookDelivery(merchant, deliveryId, { safeFetch });
      if (!result.ok) {
        sendError(res, result.status, 'invalid_request_error', result.message);
        return;
      }
      res.status(200).json(toWebhookDeliveryDTO(result.delivery));
    }),
  );

  return router;
}
