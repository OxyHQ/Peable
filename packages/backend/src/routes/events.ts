import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findEventByIdForMerchant,
  findEventForMerchant,
  listEventsForMerchant,
  type EventRow,
  type EventTypeFilter,
} from '../db/events/eventRepository';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { serveLiveStream } from '../lib/liveStream';
import { LIVE_TAIL_CHANNELS } from '../services/liveTail';
import { expandObjects, parseExpand } from '../lib/expand';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  resolveListReference,
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
const TYPE_FILTER_PATTERN = /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/;

function toTypeFilter(value: string): EventTypeFilter | undefined {
  if (value === '*') return undefined;
  if (value.endsWith('.*')) return { kind: 'prefix', prefix: value.slice(0, -1) };
  return { kind: 'exact', type: value };
}

const typeFilter = z
  .string()
  .max(100)
  .regex(TYPE_FILTER_PATTERN, 'type is an event type, or a prefix ending in .* (payment_intent.*)')
  .transform(toTypeFilter);

/**
 * The stream's `types`: a comma-separated list of the same filters
 * (`payment_intent.settled,connected_account.*`). Absent, or any `*`, is every
 * event.
 */
const streamQuery = z
  .object({
    types: z
      .string()
      .max(2_000)
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(
        z
          .array(
            z
              .string()
              .max(100)
              .regex(
                TYPE_FILTER_PATTERN,
                'types is a comma-separated list of event types, or prefixes ending in .*',
              ),
          )
          .min(1)
          .max(32),
      )
      .optional(),
  })
  .strict();

function eventMatches(filters: readonly (EventTypeFilter | undefined)[] | null, row: EventRow) {
  if (filters === null) return true;
  return filters.some((filter) =>
    filter === undefined
      ? true
      : filter.kind === 'exact'
        ? row.type === filter.type
        : row.type.startsWith(filter.prefix),
  );
}

const eventListFilters = {
  type: typeFilter.optional(),
  delivery_success: z.enum(['true', 'false']).optional(),
  /** `pi_…`: only the events about that payment — the timeline Orbit shows on a payment. */
  payment_intent: z.string().min(1).max(255).optional(),
} as const;

const listEventsQuery = surfaceListQuery(eventListFilters);
const retrieveEventQuery = surfaceRetrieveQuery();

/**
 * `GET /v1/events`, newest first, filtered by `type`, `created`,
 * `delivery_success` and `payment_intent`.
 */
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
  // Resolved inside the merchant's scope: another merchant's `pi_…` is the same
  // 400 as an unknown one.
  const intent = await resolveListReference(
    res,
    'payment_intent',
    query.payment_intent,
    async (publicId) => (await findIntentForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!intent.ok) return;
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
        paymentIntentId: intent.id,
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

/**
 * `GET /v1/events/stream` — every event of the caller's merchant, as it
 * commits, rendered exactly as `/v1/events` and a webhook delivery render it.
 * Test mode only. `lib/liveStream.ts` has the wire and the bounds; the signal
 * comes from `recordEvent`, inside the transaction that stores the event.
 */
export async function streamEvents(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const query = parseQuery(req, res, streamQuery);
  if (!query) return;
  const filters = query.types ? query.types.map(toTypeFilter) : null;
  const db = getDb();
  await serveLiveStream(req, res, merchant, {
    channel: LIVE_TAIL_CHANNELS.events,
    eventName: 'event',
    load: (id) => findEventByIdForMerchant(db, id, merchant.id),
    resolveCursor: async (publicId) =>
      (await findEventForMerchant(db, publicId, merchant.id))?.id ?? null,
    after: async (internalId, limit) =>
      (
        await listEventsForMerchant(db, {
          merchantId: merchant.id,
          page: { limit, before: internalId },
        })
      ).data.reverse(),
    matches: (row) => eventMatches(filters, row),
    internalId: (row) => row.id,
    publicId: (row) => row.publicId,
    render: toEventDTO,
  });
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
  // Before `/:id`, which would otherwise read `stream` as an event id.
  router.get('/v1/events/stream', ...read, withMerchant(streamEvents));
  router.get('/v1/events/:id', ...read, withMerchant(retrieveEvent));
  return router;
}
