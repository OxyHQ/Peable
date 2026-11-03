import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findEventForMerchant,
  listEventsForMerchant,
  type EventTypeFilter,
} from '../db/events/eventRepository';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { toEventDTO } from '../lib/serialize';
import { requireAuthenticated, sendError, wrap } from '../lib/http';
import { resolveMerchant } from './paymentIntents';

/**
 * `/v1/events` (ADR 0014 D4) — every event of the last 30 days, rendered
 * exactly as its webhook deliveries carried it. Read-only: events are written
 * by the changes they record, never by a request for one.
 */

/**
 * `type=payment_intent.settled` (exact) or `type=payment_intent.*` (a dotted
 * prefix). `*` alone is no filter. Lowercase dotted names only, so the value is
 * never a LIKE pattern of the caller's choosing.
 */
const typeFilter = z
  .string()
  .max(100)
  .regex(
    /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/,
    'type is an event type, or a prefix ending in .* (payment_intent.*)',
  )
  .transform((value): EventTypeFilter | undefined => {
    if (value === '*') return undefined;
    if (value.endsWith('.*')) return { kind: 'prefix', prefix: value.slice(0, -1) };
    return { kind: 'exact', type: value };
  });

const eventListFilters = {
  type: typeFilter.optional(),
  delivery_success: z.enum(['true', 'false']).optional(),
} as const;

const listEventsQuery = surfaceListQuery(eventListFilters);
const retrieveEventQuery = surfaceRetrieveQuery();

/** `GET /v1/events`, newest first, filtered by `type`, `created` and `delivery_success`. */
export async function answerEventList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listEventsQuery[surface]);
  if (!query) return;
  const db = getDb();
  const deliverySuccess = query.delivery_success;
  await answerList(req, res, {
    query,
    type: 'event',
    merchantId: merchant.id,
    cursor: async (publicId) => (await findEventForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listEventsForMerchant(db, {
        merchantId: merchant.id,
        page,
        type: query.type,
        deliverySuccess: deliverySuccess === undefined ? undefined : deliverySuccess === 'true',
      }),
    serialize: toEventDTO,
  });
}

/** `GET /v1/events/:id` — 404 once the event is older than 30 days. */
export async function retrieveEvent(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return;
  }
  const query = parseQuery(req, res, retrieveEventQuery[surface]);
  if (!query) return;
  const expand = parseExpand(res, 'event', query.expand, { list: false });
  if (!expand) return;
  const event = await findEventForMerchant(getDb(), id, merchant.id);
  if (!event) {
    sendError(res, 404, 'invalid_request_error', 'event not found', 'resource_missing');
    return;
  }
  const dto = toEventDTO(event);
  await expandObjects([dto], 'event', expand, merchant.id);
  res.status(200).json(dto);
}

/** The service-authed `/v1/events` router. */
export function createEventsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const { requireMerchant } = deps;
  const router = Router();
  const read = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const withMerchant = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await handler(req, res, merchant);
    });
  router.get('/v1/events', ...read, withMerchant(answerEventList));
  router.get('/v1/events/:id', ...read, withMerchant(retrieveEvent));
  return router;
}
