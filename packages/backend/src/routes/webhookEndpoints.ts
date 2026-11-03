import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  METADATA_LIMIT_MESSAGE,
  PEABLE_API_VERSION,
  createWebhookEndpointParams,
  expandOnlyQuery,
  listWebhookEndpointsQuery,
  rollWebhookEndpointSecretParams,
  updateWebhookEndpointParams,
} from '@peable.to/contracts';
import { requireScope } from '../lib/scope';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  deleteEndpoint,
  findEndpointForMerchant,
  insertEndpoint,
  listEndpointsForMerchant,
  rollEndpointSecret,
  updateEndpoint,
} from '../db/webhooks/webhookEndpointRepository';
import { findDeliveryForMerchant } from '../db/webhooks/webhookDeliveryRepository';
import { recordTestEvent } from '../services/events';
import { generateWebhookSecret, webhookUrlProblem } from '../services/webhookEndpoints';
import type { SafeFetchFn } from '../services/webhookDispatcher';
import { runWebhookOutboxPass } from '../services/webhookOutbox';
import { expandObjects, parseExpand } from '../lib/expand';
import { idempotent } from '../lib/idempotency';
import { newId } from '../lib/ids';
import { answerList, dashboardQuery, parseQuery, type QuerySurface } from '../lib/list';
import {
  toWebhookDeliveryDTO,
  toWebhookEndpointDTO,
  toWebhookEndpointWithSecretDTO,
} from '../lib/serialize';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { resolveMerchant } from './paymentIntents';

/**
 * `/v1/webhook_endpoints` (ADR 0014 D4) — where a merchant's events are sent.
 *
 * The handlers below are exported as CORES taking the merchant, so the
 * service-authed routes here and the dashboard's
 * `/v1/dashboard/applications/:applicationId/webhook_endpoints*` run the same
 * validation, the same writes and the same answers against different auth.
 *
 * Every request schema is the contract's (`@peable.to/contracts`
 * `webhookEndpointRoutes`).
 */

const listQueries = {
  api: listWebhookEndpointsQuery,
  dashboard: dashboardQuery(listWebhookEndpointsQuery),
} as const;
const retrieveQueries = {
  api: expandOnlyQuery,
  dashboard: dashboardQuery(expandOnlyQuery),
} as const;

function idParam(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

function sendNotFound(res: Response): void {
  sendError(res, 404, 'invalid_request_error', 'webhook endpoint not found', 'resource_missing');
}

/** Refuse a URL no delivery could reach, naming `url`. Returns whether it was refused. */
function refuseUrl(res: Response, url: string, merchant: MerchantRow): boolean {
  const problem = webhookUrlProblem(url, merchant.livemode);
  if (problem === null) return false;
  sendError(res, 400, 'invalid_request_error', problem, 'url_invalid', 'url');
  return true;
}

/**
 * `POST /v1/webhook_endpoints` — the response is the ONLY one that shows the
 * secret. Behind the `idempotent` layer a retry with the same key replays this
 * answer, secret included, for 24 hours: a caller whose connection dropped
 * after the create still learns the secret of the endpoint it made, instead of
 * making a second one.
 */
export async function createWebhookEndpoint(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createWebhookEndpointParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (refuseUrl(res, body.url, merchant)) return;

  const secret = generateWebhookSecret();
  const created = await insertEndpoint(getDb(), {
    publicId: newId('we'),
    merchantId: merchant.id,
    url: body.url,
    description: body.description,
    enabledEvents: body.enabled_events,
    metadata: body.metadata ?? {},
    apiVersion: PEABLE_API_VERSION,
    secret,
  });
  if (created === 'limit_reached') {
    sendError(
      res,
      400,
      'invalid_request_error',
      'this merchant already has the maximum number of webhook endpoints',
      'webhook_endpoint_limit_reached',
    );
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(toWebhookEndpointWithSecretDTO(created, secret));
}

/** `GET /v1/webhook_endpoints/:id`. Never the secret. */
export async function retrieveWebhookEndpoint(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const query = parseQuery(req, res, retrieveQueries[surface]);
  if (!query) return;
  const expand = parseExpand(res, 'webhook_endpoint', query.expand, { list: false });
  if (!expand) return;
  const endpoint = await findEndpointForMerchant(getDb(), id, merchant.id);
  if (!endpoint) {
    sendNotFound(res);
    return;
  }
  const dto = toWebhookEndpointDTO(endpoint);
  await expandObjects([dto], 'webhook_endpoint', expand, merchant.id);
  res.status(200).json(dto);
}

/** `GET /v1/webhook_endpoints`, newest first. */
export async function answerWebhookEndpointList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listQueries[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'webhook_endpoint',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findEndpointForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) => listEndpointsForMerchant(db, { merchantId: merchant.id, page }),
    serialize: (row) => toWebhookEndpointDTO(row),
  });
}

/** `POST /v1/webhook_endpoints/:id` — url, events, disabled, description, metadata. */
export async function updateWebhookEndpoint(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = updateWebhookEndpointParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  if (body.url !== undefined && refuseUrl(res, body.url, merchant)) return;

  const updated = await updateEndpoint(getDb(), id, merchant.id, {
    url: body.url,
    enabledEvents: body.enabled_events,
    disabled: body.disabled,
    description: body.description === undefined ? undefined : body.description || null,
    metadata: body.metadata,
  });
  if (updated === 'missing') {
    sendNotFound(res);
    return;
  }
  if (updated === 'limit_exceeded') {
    sendError(
      res,
      400,
      'invalid_request_error',
      METADATA_LIMIT_MESSAGE,
      'parameter_invalid',
      'metadata',
    );
    return;
  }
  res.status(200).json(toWebhookEndpointDTO(updated));
}

/**
 * `DELETE /v1/webhook_endpoints/:id`. Its deliveries go with it, pending ones
 * included: nothing is sent to a deleted endpoint.
 */
export async function deleteWebhookEndpoint(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const deleted = await deleteEndpoint(getDb(), id, merchant.id);
  if (!deleted) {
    sendNotFound(res);
    return;
  }
  res.status(200).json({ id, object: 'webhook_endpoint', deleted: true });
}

/**
 * `POST /v1/webhook_endpoints/:id/roll_secret` — mint a new secret and show it
 * once. With `expires_in_seconds` (≤ 24h) the old secret keeps signing beside
 * it until then, so every delivery in the window carries two `v1=` and a
 * receiver verifying with either accepts it; without, the old one stops now.
 */
export async function rollWebhookEndpointSecret(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = rollWebhookEndpointSecretParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const seconds = parsed.data.expires_in_seconds ?? 0;
  const secret = generateWebhookSecret();
  const rolled = await rollEndpointSecret(getDb(), id, merchant.id, {
    secret,
    previousExpiresAt: seconds > 0 ? new Date(Date.now() + seconds * 1000) : null,
  });
  if (!rolled) {
    sendNotFound(res);
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(toWebhookEndpointWithSecretDTO(rolled, secret));
}

/**
 * Send a synthetic `webhook_endpoint.test` event to ONE endpoint, now, and
 * answer the delivery as it stands after one inline attempt — Orbit's "send
 * test event". A disabled endpoint is refused: the test would say nothing
 * about an endpoint Peable is not sending to.
 */
export async function sendWebhookEndpointTest(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  deps: { safeFetch?: SafeFetchFn | undefined } = {},
): Promise<void> {
  const id = idParam(req, res);
  if (!id) return;
  const db = getDb();
  const endpoint = await findEndpointForMerchant(db, id, merchant.id);
  if (!endpoint) {
    sendNotFound(res);
    return;
  }
  if (endpoint.status !== 'enabled') {
    sendError(
      res,
      400,
      'invalid_request_error',
      'this webhook endpoint is disabled; enable it before sending a test event',
      'webhook_endpoint_disabled',
    );
    return;
  }
  const { deliveryId } = await db.transaction((tx) =>
    recordTestEvent(tx, endpoint, toWebhookEndpointDTO(endpoint)),
  );
  // One pass inline so the person who pressed the button sees the outcome. A
  // transient failure keeps its schedule; the dispatcher carries on with it.
  await runWebhookOutboxPass(deps.safeFetch ? { safeFetch: deps.safeFetch } : {});
  const delivery = await findDeliveryForMerchant(db, deliveryId, merchant.id);
  if (!delivery) throw new Error(`test delivery ${deliveryId} vanished after enqueue`);
  res.status(200).json(toWebhookDeliveryDTO(delivery));
}

/** The service-authed `/v1/webhook_endpoints` router. */
export function createWebhookEndpointsRouter(deps: {
  requireMerchant: RequestHandler;
  safeFetch?: SafeFetchFn | undefined;
}): Router {
  const { requireMerchant, safeFetch } = deps;
  const router = Router();
  const read = [requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const write = [requireMerchant, requireAuthenticated, requireScope('payments:write')];

  const withMerchant = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await handler(req, res, merchant);
    });

  router.post('/v1/webhook_endpoints', ...write, idempotent, withMerchant(createWebhookEndpoint));
  router.get('/v1/webhook_endpoints', ...read, withMerchant(answerWebhookEndpointList));
  router.get('/v1/webhook_endpoints/:id', ...read, withMerchant(retrieveWebhookEndpoint));
  router.post(
    '/v1/webhook_endpoints/:id',
    ...write,
    idempotent,
    withMerchant(updateWebhookEndpoint),
  );
  router.delete('/v1/webhook_endpoints/:id', ...write, withMerchant(deleteWebhookEndpoint));
  router.post(
    '/v1/webhook_endpoints/:id/roll_secret',
    ...write,
    idempotent,
    withMerchant(rollWebhookEndpointSecret),
  );
  // Orbit's "send test event", for an integration (and `peable trigger
  // webhook_endpoint.test`): the same core the dashboard route runs.
  router.post(
    '/v1/webhook_endpoints/:id/test',
    ...write,
    idempotent,
    withMerchant((req, res, merchant) =>
      sendWebhookEndpointTest(req, res, merchant, { safeFetch }),
    ),
  );
  return router;
}
