/**
 * Terminal (ADR 0024) — Stripe's surface: locations (CRUD + list), readers
 * (register, retrieve, update, delete, list, `process_payment_intent`,
 * `cancel_action`), connection tokens, and the simulated reader's
 * `present_payment_method` test helper.
 *
 * Every handler is a core `(req, res, merchant[, surface])` shared by the
 * service-authed routes below and Orbit's dashboard
 * ({@link mountTerminalDashboardRoutes}), where reads are `read` and every
 * write is `money`: registering hardware and taking a card move money.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  createTerminalConnectionTokenParams,
  createTerminalLocationParams,
  createTerminalReaderParams,
  listTerminalLocationsQuery,
  listTerminalReadersQuery,
  METADATA_LIMIT_MESSAGE,
  presentPaymentMethodParams,
  processPaymentIntentParams,
  retrieveTerminalReaderQuery,
  terminalReaderActionParams,
  updateTerminalLocationParams,
  updateTerminalReaderParams,
} from '@peable.to/contracts';
import { z } from 'zod';
import { CURRENCY_CODES, type Address } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findIntentById, findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import {
  findTerminalLocationForMerchant,
  findTerminalReaderForMerchant,
  listTerminalLocationsForMerchant,
  listTerminalReadersForMerchant,
  type TerminalLocationRow,
  type TerminalReaderRow,
} from '../db/terminal/terminalRepository';
import {
  cancelReaderAction,
  createConnectionToken,
  createLocation,
  presentPaymentMethod,
  processPaymentIntent,
  reconcileReader,
  registerReader,
  removeLocation,
  removeReader,
  TerminalParameterError,
  TerminalPaymentNotReadyError,
  TerminalStateError,
  TerminalUnavailableError,
  updateLocation,
  updateReader,
} from '../services/terminal/terminal';
import { ProviderError } from '../services/providers/provider';
import { toTerminalLocationDTO, toTerminalReaderDTO } from '../lib/serializeTerminal';
import {
  requireAuthenticated,
  requireScope,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent, runIdempotent } from '../lib/idempotency';
import { requestContextMiddleware } from '../lib/requestContext';
import { expandObjects, parseExpand } from '../lib/expand';
import { refuseLivemode } from '../lib/liveStream';
import { sendMoneyRefusal } from '../lib/moneyHttp';
import { toPaymentIntentDTO } from '../lib/serialize';
import { createIntent, IntentParameterError, RailUnavailableError } from '../services/createIntent';
import {
  answerList,
  dashboardQuery,
  parseQuery,
  type QuerySurface,
  resolveListReference,
} from '../lib/list';
import type { DashboardGate } from './dashboardAccess';
import { resolveMerchant } from './paymentIntents';

const listLocationsQueries = {
  api: listTerminalLocationsQuery,
  dashboard: dashboardQuery(listTerminalLocationsQuery),
} as const;
const listReadersQueries = {
  api: listTerminalReadersQuery,
  dashboard: dashboardQuery(listTerminalReadersQuery),
} as const;
const retrieveReaderQueries = {
  api: retrieveTerminalReaderQuery,
  dashboard: dashboardQuery(retrieveTerminalReaderQuery),
} as const;

/** Answer a service error, or rethrow what is not one. */
function sendTerminalError(res: Response, error: unknown): void {
  if (error instanceof TerminalUnavailableError) {
    sendError(res, 503, 'api_error', error.message, 'terminal_unavailable');
    return;
  }
  if (error instanceof TerminalPaymentNotReadyError) {
    sendError(res, 503, 'api_error', error.message);
    return;
  }
  if (error instanceof TerminalStateError) {
    sendError(res, 409, 'invalid_request_error', error.message, error.code);
    return;
  }
  if (error instanceof TerminalParameterError) {
    sendError(res, 400, 'invalid_request_error', error.message, error.code, error.param);
    return;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return;
  }
  throw error;
}

function sendMetadataLimit(res: Response): void {
  sendError(
    res,
    400,
    'invalid_request_error',
    METADATA_LIMIT_MESSAGE,
    'parameter_invalid',
    'metadata',
  );
}

/** The wire address a location stores: every field present, `null` when not given. */
function toAddress(address: {
  readonly line1?: string | undefined;
  readonly line2?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly postal_code?: string | undefined;
  readonly country: string;
}): Address {
  return {
    line1: address.line1 ?? null,
    line2: address.line2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postal_code: address.postal_code ?? null,
    country: address.country,
  };
}

async function loadLocation(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<TerminalLocationRow | null> {
  const { id } = req.params;
  // ONE 404 for "does not exist" and "is not yours", scoped in the predicate.
  const row = id ? await findTerminalLocationForMerchant(getDb(), id, merchant.id) : null;
  if (!row) {
    sendError(res, 404, 'invalid_request_error', 'location not found', 'resource_missing', 'id');
  }
  return row;
}

async function loadReader(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<TerminalReaderRow | null> {
  const { id } = req.params;
  const row = id ? await findTerminalReaderForMerchant(getDb(), id, merchant.id) : null;
  if (!row) {
    sendError(res, 404, 'invalid_request_error', 'reader not found', 'resource_missing', 'id');
  }
  return row;
}

async function answerReader(
  res: Response,
  merchant: MerchantRow,
  row: TerminalReaderRow,
  references: readonly string[] | undefined,
  status = 200,
): Promise<void> {
  const expand = parseExpand(res, 'terminal.reader', references, { list: false });
  if (!expand) return;
  const dto = toTerminalReaderDTO(row);
  await expandObjects([dto], 'terminal.reader', expand, merchant.id);
  res.status(status).json(dto);
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** `POST /v1/terminal/locations`. */
export async function createLocationCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createTerminalLocationParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  try {
    const row = await createLocation(merchant, {
      displayName: parsed.data.display_name,
      address: toAddress(parsed.data.address),
      metadata: parsed.data.metadata ?? {},
    });
    res.status(201).json(toTerminalLocationDTO(row));
  } catch (error) {
    sendTerminalError(res, error);
  }
}

/** `GET /v1/terminal/locations`. */
export async function answerLocationList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listLocationsQueries[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'terminal.location',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findTerminalLocationForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) => listTerminalLocationsForMerchant(db, { merchantId: merchant.id, page }),
    serialize: toTerminalLocationDTO,
  });
}

/** `GET /v1/terminal/locations/:id`. */
export async function retrieveLocationCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const row = await loadLocation(req, res, merchant);
  if (row) res.status(200).json(toTerminalLocationDTO(row));
}

/** `POST /v1/terminal/locations/:id`. */
export async function updateLocationCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateTerminalLocationParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await loadLocation(req, res, merchant);
  if (!row) return;
  try {
    const updated = await updateLocation(row, {
      displayName: parsed.data.display_name,
      address: parsed.data.address === undefined ? undefined : toAddress(parsed.data.address),
      metadata: parsed.data.metadata,
    });
    if (updated === 'limit_exceeded') {
      sendMetadataLimit(res);
      return;
    }
    res.status(200).json(toTerminalLocationDTO(updated));
  } catch (error) {
    sendTerminalError(res, error);
  }
}

/** `DELETE /v1/terminal/locations/:id`. */
export async function deleteLocationCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const row = await loadLocation(req, res, merchant);
  if (!row) return;
  try {
    await removeLocation(row);
    res.status(200).json({ id: row.publicId, object: 'terminal.location', deleted: true });
  } catch (error) {
    sendTerminalError(res, error);
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** `POST /v1/terminal/readers`. */
export async function createReaderCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createTerminalReaderParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  if (!parseExpand(res, 'terminal.reader', parsed.data.expand, { list: false })) return;
  const location = await findTerminalLocationForMerchant(
    getDb(),
    parsed.data.location,
    merchant.id,
  );
  if (!location) {
    sendError(
      res,
      400,
      'invalid_request_error',
      `no such location: '${parsed.data.location}'`,
      'resource_missing',
      'location',
    );
    return;
  }
  try {
    const row = await registerReader(merchant, location, {
      registrationCode: parsed.data.registration_code,
      label: parsed.data.label,
      metadata: parsed.data.metadata ?? {},
    });
    await answerReader(res, merchant, row, parsed.data.expand, 201);
  } catch (error) {
    sendTerminalError(res, error);
  }
}

/** `GET /v1/terminal/readers`. */
export async function answerReaderList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listReadersQueries[surface]);
  if (!query) return;
  const db = getDb();
  const location = await resolveListReference(
    res,
    'location',
    query.location,
    async (publicId) =>
      (await findTerminalLocationForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!location.ok) return;
  await answerList(req, res, {
    query,
    type: 'terminal.reader',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findTerminalReaderForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listTerminalReadersForMerchant(db, {
        merchantId: merchant.id,
        locationId: location.id,
        status: query.status,
        page,
      }),
    serialize: toTerminalReaderDTO,
  });
}

/** `GET /v1/terminal/readers/:id` — reconciled with the provider. */
export async function retrieveReaderCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, retrieveReaderQueries[surface]);
  if (!query) return;
  if (!parseExpand(res, 'terminal.reader', query.expand, { list: false })) return;
  const row = await loadReader(req, res, merchant);
  if (!row) return;
  let current = row;
  try {
    current = await reconcileReader(row);
  } catch {
    // A read never fails because the provider is unreachable: the stored view is answered.
  }
  await answerReader(res, merchant, current, query.expand);
}

/** `POST /v1/terminal/readers/:id`. */
export async function updateReaderCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateTerminalReaderParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  if (!parseExpand(res, 'terminal.reader', parsed.data.expand, { list: false })) return;
  const row = await loadReader(req, res, merchant);
  if (!row) return;
  try {
    const updated = await updateReader(row, {
      label: parsed.data.label,
      metadata: parsed.data.metadata,
    });
    if (updated === 'limit_exceeded') {
      sendMetadataLimit(res);
      return;
    }
    await answerReader(res, merchant, updated, parsed.data.expand);
  } catch (error) {
    sendTerminalError(res, error);
  }
}

/** `DELETE /v1/terminal/readers/:id`. */
export async function deleteReaderCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const row = await loadReader(req, res, merchant);
  if (!row) return;
  try {
    await removeReader(row);
    res.status(200).json({ id: row.publicId, object: 'terminal.reader', deleted: true });
  } catch (error) {
    sendTerminalError(res, error);
  }
}

/** `POST /v1/terminal/readers/:id/process_payment_intent`. */
export async function processPaymentIntentCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = processPaymentIntentParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  if (!parseExpand(res, 'terminal.reader', parsed.data.expand, { list: false })) return;
  const row = await loadReader(req, res, merchant);
  if (!row) return;
  const intent = await findIntentForMerchant(getDb(), parsed.data.payment_intent, merchant.id);
  if (!intent) {
    sendError(
      res,
      400,
      'invalid_request_error',
      `no such payment intent: '${parsed.data.payment_intent}'`,
      'resource_missing',
      'payment_intent',
    );
    return;
  }
  try {
    const updated = await processPaymentIntent(row, intent, parsed.data.process_config);
    await answerReader(res, merchant, updated, parsed.data.expand);
  } catch (error) {
    sendTerminalError(res, error);
  }
}

function readerAction(
  run: (row: TerminalReaderRow) => Promise<TerminalReaderRow>,
  params: typeof terminalReaderActionParams | typeof presentPaymentMethodParams,
): (req: Request, res: Response, merchant: MerchantRow) => Promise<void> {
  return async (req, res, merchant) => {
    const parsed = params.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    if (!parseExpand(res, 'terminal.reader', parsed.data.expand, { list: false })) return;
    const row = await loadReader(req, res, merchant);
    if (!row) return;
    try {
      await answerReader(res, merchant, await run(row), parsed.data.expand);
    } catch (error) {
      sendTerminalError(res, error);
    }
  };
}

/** `POST /v1/terminal/readers/:id/cancel_action`. */
export const cancelReaderActionCore = readerAction(cancelReaderAction, terminalReaderActionParams);

/** `POST /v1/test_helpers/terminal/readers/:id/present_payment_method` (test mode only). */
export const presentPaymentMethodCore = readerAction(
  presentPaymentMethod,
  presentPaymentMethodParams,
);

/** Test helpers refuse a live merchant before anything is read (403 `test_mode_only`). */
async function presentPaymentMethodTestModeCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  if (refuseLivemode(res, merchant, 'Test helpers')) return;
  await presentPaymentMethodCore(req, res, merchant);
}

// ---------------------------------------------------------------------------
// Connection tokens
// ---------------------------------------------------------------------------

/** `POST /v1/terminal/connection_tokens` — minted fresh, never stored, never replayed. */
export async function createConnectionTokenCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createTerminalConnectionTokenParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  // Always scoped to one of THIS merchant's locations (ADR 0024 D6).
  const location = await findTerminalLocationForMerchant(
    getDb(),
    parsed.data.location,
    merchant.id,
  );
  if (!location) {
    sendError(
      res,
      400,
      'invalid_request_error',
      `no such location: '${parsed.data.location}'`,
      'resource_missing',
      'location',
    );
    return;
  }
  try {
    const token = await createConnectionToken(merchant, location);
    // A credential: nothing in between keeps it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      object: 'terminal.connection_token',
      secret: token.secret,
      location: location.publicId,
    });
  } catch (error) {
    sendTerminalError(res, error);
  }
}

// ---------------------------------------------------------------------------
// Orbit: collect a payment on a reader (dashboard only)
// ---------------------------------------------------------------------------

/**
 * Orbit's "collect a payment" (not a contract: dashboard routes are Orbit's
 * private surface). It is the two public steps in one request — create a
 * `card_present` PaymentIntent (`createIntent`, the one path every intent
 * takes: routing, the live gate, its event) and collect it on the reader —
 * so a person at a counter types an amount and the reader asks for the card.
 */
const collectOnReaderBody = z
  .object({
    amount: z.string().regex(/^[1-9][0-9]{0,17}$/, 'amount is a positive base-unit integer string'),
    currency: z.enum(CURRENCY_CODES).refine((code) => code !== 'FAIR', 'a reader takes fiat'),
    description: z.string().trim().min(1).max(500).optional(),
    capture_method: z.enum(['automatic', 'manual']).optional(),
  })
  .strict();

export async function collectOnReaderCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = collectOnReaderBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const row = await loadReader(req, res, merchant);
  if (!row) return;
  let intent: Awaited<ReturnType<typeof createIntent>>['intent'];
  try {
    ({ intent } = await createIntent({
      merchant,
      rail: 'card',
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      paymentMethodTypes: ['card_present'],
      captureMethod: parsed.data.capture_method ?? 'automatic',
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      metadata: {},
    }));
  } catch (error) {
    if (error instanceof IntentParameterError) {
      sendError(res, 400, 'invalid_request_error', error.message, error.code, error.param);
      return;
    }
    if (error instanceof RailUnavailableError) {
      sendError(res, 503, 'api_error', error.message, 'terminal_unavailable');
      return;
    }
    if (sendMoneyRefusal(res, error)) return;
    throw error;
  }
  // Re-read: the create links the provider payment after writing the row.
  intent = (await findIntentById(getDb(), intent.id)) ?? intent;
  try {
    const reader = await processPaymentIntent(row, intent, undefined);
    res.status(200).json({
      reader: toTerminalReaderDTO(reader),
      payment_intent: toPaymentIntentDTO(intent),
    });
  } catch (error) {
    sendTerminalError(res, error);
  }
}

type Core = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;
type WriteCore = (req: Request, res: Response, merchant: MerchantRow) => Promise<void>;

/** The merchant API. Reads `payments:read`; writes `payments:write`, every POST idempotent but the token. */
export function createTerminalRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const read = [deps.requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const write = [deps.requireMerchant, requireAuthenticated, requireScope('payments:write')];
  const api = (core: Core) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await core(req, res, merchant, 'api');
    });
  const apiWrite = (core: WriteCore) => api((req, res, merchant) => core(req, res, merchant));
  const locations = '/v1/terminal/locations';
  router.post(locations, ...write, idempotent, apiWrite(createLocationCore));
  router.get(locations, ...read, api(answerLocationList));
  router.get(`${locations}/:id`, ...read, apiWrite(retrieveLocationCore));
  router.post(`${locations}/:id`, ...write, idempotent, apiWrite(updateLocationCore));
  router.delete(`${locations}/:id`, ...write, apiWrite(deleteLocationCore));
  const readers = '/v1/terminal/readers';
  router.post(readers, ...write, idempotent, apiWrite(createReaderCore));
  router.get(readers, ...read, api(answerReaderList));
  router.get(`${readers}/:id`, ...read, api(retrieveReaderCore));
  router.post(`${readers}/:id`, ...write, idempotent, apiWrite(updateReaderCore));
  router.delete(`${readers}/:id`, ...write, apiWrite(deleteReaderCore));
  router.post(
    `${readers}/:id/process_payment_intent`,
    ...write,
    idempotent,
    apiWrite(processPaymentIntentCore),
  );
  router.post(
    `${readers}/:id/cancel_action`,
    ...write,
    idempotent,
    apiWrite(cancelReaderActionCore),
  );
  router.post('/v1/terminal/connection_tokens', ...write, apiWrite(createConnectionTokenCore));
  router.post(
    '/v1/test_helpers/terminal/readers/:id/present_payment_method',
    ...write,
    idempotent,
    apiWrite(presentPaymentMethodTestModeCore),
  );
  return router;
}

/**
 * The same cores under Orbit's dashboard: reads are `read`; every write is
 * `money` (`billing:manage`) — registering hardware that takes cards, and
 * taking one, is the account's money work.
 */
export function mountTerminalDashboardRoutes(
  router: Router,
  deps: {
    readonly base: string;
    readonly requireOxyUser: RequestHandler;
    readonly gate: DashboardGate;
  },
): void {
  const { base, requireOxyUser, gate } = deps;
  const read = (core: Core) =>
    gate('read', (req, res, merchant) => core(req, res, merchant, 'dashboard'));
  const money = (core: WriteCore) =>
    gate('money', (req, res, merchant) =>
      runIdempotent(req, res, merchant.id, () => core(req, res, merchant)),
    );
  // A connection token is never stored, so never replayed: no idempotency here either.
  const moneyFresh = (core: WriteCore) => gate('money', core);
  const locations = `${base}/terminal/locations`;
  router.post(locations, requireOxyUser, requestContextMiddleware, money(createLocationCore));
  router.get(locations, requireOxyUser, read(answerLocationList));
  router.get(`${locations}/:id`, requireOxyUser, read(retrieveLocationCore));
  router.post(
    `${locations}/:id`,
    requireOxyUser,
    requestContextMiddleware,
    money(updateLocationCore),
  );
  router.delete(
    `${locations}/:id`,
    requireOxyUser,
    requestContextMiddleware,
    moneyFresh(deleteLocationCore),
  );
  const readers = `${base}/terminal/readers`;
  router.post(readers, requireOxyUser, requestContextMiddleware, money(createReaderCore));
  router.get(readers, requireOxyUser, read(answerReaderList));
  router.get(`${readers}/:id`, requireOxyUser, read(retrieveReaderCore));
  router.post(`${readers}/:id`, requireOxyUser, requestContextMiddleware, money(updateReaderCore));
  router.delete(
    `${readers}/:id`,
    requireOxyUser,
    requestContextMiddleware,
    moneyFresh(deleteReaderCore),
  );
  router.post(
    `${readers}/:id/process_payment_intent`,
    requireOxyUser,
    requestContextMiddleware,
    money(processPaymentIntentCore),
  );
  router.post(
    `${readers}/:id/cancel_action`,
    requireOxyUser,
    requestContextMiddleware,
    money(cancelReaderActionCore),
  );
  router.post(
    `${readers}/:id/collect`,
    requireOxyUser,
    requestContextMiddleware,
    money(collectOnReaderCore),
  );
  router.post(
    `${base}/test_helpers/terminal/readers/:id/present_payment_method`,
    requireOxyUser,
    requestContextMiddleware,
    money(presentPaymentMethodTestModeCore),
  );
}
