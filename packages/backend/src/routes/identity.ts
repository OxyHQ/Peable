/**
 * Identity verification (ADR 0023) — Stripe's surface: verification sessions
 * (create, list, retrieve, update, cancel, redact) and their reports (list,
 * retrieve).
 *
 * Every handler is a core `(req, res, merchant, surface)` shared by the
 * service-authed routes below and Orbit's dashboard
 * ({@link mountIdentityDashboardRoutes}), where reads are `read` and every
 * write is `money`: verifying a person is account and compliance territory.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  createVerificationSessionParams,
  listVerificationReportsQuery,
  listVerificationSessionsQuery,
  METADATA_LIMIT_MESSAGE,
  retrieveVerificationReportQuery,
  retrieveVerificationSessionQuery,
  updateVerificationSessionParams,
  verificationSessionActionParams,
} from '@peable.to/contracts';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findVerificationReportForMerchant,
  findVerificationSessionForMerchant,
  listVerificationReportsForMerchant,
  listVerificationSessionsForMerchant,
  type VerificationSessionRow,
} from '../db/identity/verificationRepository';
import {
  cancelVerificationSession,
  createVerificationSession,
  IdentityUnavailableError,
  redactVerificationSession,
  retrieveVerificationSession,
  updateVerificationSession,
  VerificationParameterError,
  VerificationSessionStateError,
} from '../services/identity/verificationSessions';
import { ProviderError } from '../services/providers/provider';
import {
  toVerificationReportDTO,
  toVerificationSessionDTO,
  type VerificationSessionLive,
} from '../lib/serializeIdentity';
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
import {
  answerList,
  dashboardQuery,
  parseQuery,
  type QuerySurface,
  resolveListReference,
} from '../lib/list';
import type { DashboardGate } from './dashboardAccess';
import { resolveMerchant } from './paymentIntents';

const listSessionsQueries = {
  api: listVerificationSessionsQuery,
  dashboard: dashboardQuery(listVerificationSessionsQuery),
} as const;
const retrieveSessionQueries = {
  api: retrieveVerificationSessionQuery,
  dashboard: dashboardQuery(retrieveVerificationSessionQuery),
} as const;
const listReportsQueries = {
  api: listVerificationReportsQuery,
  dashboard: dashboardQuery(listVerificationReportsQuery),
} as const;
const retrieveReportQueries = {
  api: retrieveVerificationReportQuery,
  dashboard: dashboardQuery(retrieveVerificationReportQuery),
} as const;

/**
 * The paths that are not references but the person's data, read live: Stripe's
 * "includable" fields. Split off before `parseExpand`, which knows references
 * only.
 */
const VERIFIED_OUTPUT_PATHS = new Set([
  'verified_outputs',
  'verified_outputs.dob',
  'verified_outputs.id_number',
]);

function splitIncludes(expand: readonly string[] | undefined): {
  readonly references: string[];
  readonly include: { verifiedOutputs: boolean; dob: boolean; idNumber: boolean };
} {
  const paths = expand ?? [];
  return {
    references: paths.filter((path) => !VERIFIED_OUTPUT_PATHS.has(path)),
    include: {
      verifiedOutputs: paths.some((path) => VERIFIED_OUTPUT_PATHS.has(path)),
      dob: paths.includes('verified_outputs.dob'),
      idNumber: paths.includes('verified_outputs.id_number'),
    },
  };
}

function sendSessionNotFound(res: Response): void {
  sendError(
    res,
    404,
    'invalid_request_error',
    'verification session not found',
    'resource_missing',
    'id',
  );
}

async function loadSession(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<VerificationSessionRow | null> {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  // ONE 404 for "does not exist" and "is not yours", scoped in the predicate.
  const row = await findVerificationSessionForMerchant(getDb(), id, merchant.id);
  if (!row) sendSessionNotFound(res);
  return row;
}

/** Answer a service error, or rethrow what is not one. */
function sendIdentityError(res: Response, error: unknown): void {
  if (error instanceof IdentityUnavailableError) {
    sendError(res, 503, 'api_error', error.message, 'identity_unavailable');
    return;
  }
  if (error instanceof VerificationSessionStateError) {
    sendError(
      res,
      409,
      'invalid_request_error',
      error.message,
      'verification_session_unexpected_state',
    );
    return;
  }
  if (error instanceof VerificationParameterError) {
    sendError(res, 400, 'invalid_request_error', error.message, 'parameter_invalid', error.param);
    return;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return;
  }
  throw error;
}

async function answerSession(
  res: Response,
  merchant: MerchantRow,
  row: VerificationSessionRow,
  live: VerificationSessionLive,
  references: readonly string[] | undefined,
  status = 200,
): Promise<void> {
  const expand = parseExpand(res, 'identity.verification_session', references, { list: false });
  if (!expand) return;
  const dto = toVerificationSessionDTO(row, live);
  await expandObjects([dto], 'identity.verification_session', expand, merchant.id);
  // The person's single-use credentials (and, when asked, their data) are on
  // this answer: nothing in between keeps it.
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(dto);
}

/** `POST /v1/identity/verification_sessions`. */
export async function createVerificationSessionCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createVerificationSessionParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { expand, metadata, ...body } = parsed.data;
  // Validated before the provider is asked: a malformed path costs no session.
  if (!parseExpand(res, 'identity.verification_session', expand, { list: false })) return;
  try {
    const { row, live } = await createVerificationSession(merchant, {
      ...body,
      metadata: metadata ?? {},
    });
    await answerSession(res, merchant, row, live, expand, 201);
  } catch (error) {
    sendIdentityError(res, error);
  }
}

/** `GET /v1/identity/verification_sessions`. */
export async function answerVerificationSessionList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listSessionsQueries[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'identity.verification_session',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findVerificationSessionForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listVerificationSessionsForMerchant(db, {
        merchantId: merchant.id,
        status: query.status,
        clientReferenceId: query.client_reference_id,
        page,
      }),
    serialize: (row) => toVerificationSessionDTO(row),
  });
}

/** `GET /v1/identity/verification_sessions/:id`. */
export async function retrieveVerificationSessionCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, retrieveSessionQueries[surface]);
  if (!query) return;
  const { references, include } = splitIncludes(query.expand);
  if (surface === 'dashboard' && include.verifiedOutputs) {
    // Orbit shows the verdict, never the person's data: a dashboard member
    // reads what the merchant's integration would have to ask for on purpose.
    sendError(
      res,
      400,
      'invalid_request_error',
      'verified_outputs is read with the merchant credential only',
      'parameter_invalid',
      'expand',
    );
    return;
  }
  if (!parseExpand(res, 'identity.verification_session', references, { list: false })) return;
  const found = await loadSession(req, res, merchant);
  if (!found) return;
  try {
    const { row, live } = await retrieveVerificationSession(found, include);
    await answerSession(res, merchant, row, live, references);
  } catch (error) {
    sendIdentityError(res, error);
  }
}

/** `POST /v1/identity/verification_sessions/:id`. */
export async function updateVerificationSessionCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = updateVerificationSessionParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  if (!parseExpand(res, 'identity.verification_session', parsed.data.expand, { list: false })) {
    return;
  }
  const row = await loadSession(req, res, merchant);
  if (!row) return;
  try {
    const updated = await updateVerificationSession(row, {
      type: parsed.data.type,
      options: parsed.data.options,
      metadata: parsed.data.metadata,
    });
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
    await answerSession(res, merchant, updated, {}, parsed.data.expand);
  } catch (error) {
    sendIdentityError(res, error);
  }
}

function sessionAction(
  run: (row: VerificationSessionRow) => Promise<VerificationSessionRow>,
): (req: Request, res: Response, merchant: MerchantRow) => Promise<void> {
  return async (req, res, merchant) => {
    const parsed = verificationSessionActionParams.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    if (!parseExpand(res, 'identity.verification_session', parsed.data.expand, { list: false })) {
      return;
    }
    const row = await loadSession(req, res, merchant);
    if (!row) return;
    try {
      await answerSession(res, merchant, await run(row), {}, parsed.data.expand);
    } catch (error) {
      sendIdentityError(res, error);
    }
  };
}

/** `POST /v1/identity/verification_sessions/:id/cancel`. */
export const cancelVerificationSessionCore = sessionAction(cancelVerificationSession);
/** `POST /v1/identity/verification_sessions/:id/redact`. */
export const redactVerificationSessionCore = sessionAction(redactVerificationSession);

/** `GET /v1/identity/verification_reports`. */
export async function answerVerificationReportList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listReportsQueries[surface]);
  if (!query) return;
  const db = getDb();
  const session = await resolveListReference(
    res,
    'verification_session',
    query.verification_session,
    async (publicId) =>
      (await findVerificationSessionForMerchant(db, publicId, merchant.id))?.id ?? null,
  );
  if (!session.ok) return;
  await answerList(req, res, {
    query,
    type: 'identity.verification_report',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findVerificationReportForMerchant(db, publicId, merchant.id))?.id ?? null,
    fetch: (page) =>
      listVerificationReportsForMerchant(db, {
        merchantId: merchant.id,
        verificationSessionId: session.id,
        type: query.type,
        page,
      }),
    serialize: toVerificationReportDTO,
  });
}

/** `GET /v1/identity/verification_reports/:id`. */
export async function retrieveVerificationReportCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, retrieveReportQueries[surface]);
  if (!query) return;
  const expand = parseExpand(res, 'identity.verification_report', query.expand, { list: false });
  if (!expand) return;
  const { id } = req.params;
  const row = id ? await findVerificationReportForMerchant(getDb(), id, merchant.id) : null;
  if (!row) {
    sendError(
      res,
      404,
      'invalid_request_error',
      'verification report not found',
      'resource_missing',
      'id',
    );
    return;
  }
  const dto = toVerificationReportDTO(row);
  await expandObjects([dto], 'identity.verification_report', expand, merchant.id);
  res.status(200).json(dto);
}

type Core = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;
type WriteCore = (req: Request, res: Response, merchant: MerchantRow) => Promise<void>;

/** The merchant API. Reads `payments:read`; every write `payments:write` and idempotent. */
export function createIdentityRouter(deps: { requireMerchant: RequestHandler }): Router {
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
  const sessions = '/v1/identity/verification_sessions';
  router.post(sessions, ...write, idempotent, apiWrite(createVerificationSessionCore));
  router.get(sessions, ...read, api(answerVerificationSessionList));
  router.get(`${sessions}/:id`, ...read, api(retrieveVerificationSessionCore));
  router.post(`${sessions}/:id`, ...write, idempotent, apiWrite(updateVerificationSessionCore));
  router.post(
    `${sessions}/:id/cancel`,
    ...write,
    idempotent,
    apiWrite(cancelVerificationSessionCore),
  );
  router.post(
    `${sessions}/:id/redact`,
    ...write,
    idempotent,
    apiWrite(redactVerificationSessionCore),
  );
  router.get('/v1/identity/verification_reports', ...read, api(answerVerificationReportList));
  router.get('/v1/identity/verification_reports/:id', ...read, api(retrieveVerificationReportCore));
  return router;
}

/**
 * The same cores under Orbit's dashboard: reads are `read`; creating,
 * editing, cancelling and redacting are `money` (`billing:manage`) — sending a
 * person through identity verification, and erasing what they submitted, is
 * the account's compliance work, not configuration.
 */
export function mountIdentityDashboardRoutes(
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
  const sessions = `${base}/identity/verification_sessions`;
  router.post(
    sessions,
    requireOxyUser,
    requestContextMiddleware,
    money(createVerificationSessionCore),
  );
  router.get(sessions, requireOxyUser, read(answerVerificationSessionList));
  router.get(`${sessions}/:id`, requireOxyUser, read(retrieveVerificationSessionCore));
  router.post(
    `${sessions}/:id`,
    requireOxyUser,
    requestContextMiddleware,
    money(updateVerificationSessionCore),
  );
  router.post(
    `${sessions}/:id/cancel`,
    requireOxyUser,
    requestContextMiddleware,
    money(cancelVerificationSessionCore),
  );
  router.post(
    `${sessions}/:id/redact`,
    requireOxyUser,
    requestContextMiddleware,
    money(redactVerificationSessionCore),
  );
  router.get(
    `${base}/identity/verification_reports`,
    requireOxyUser,
    read(answerVerificationReportList),
  );
  router.get(
    `${base}/identity/verification_reports/:id`,
    requireOxyUser,
    read(retrieveVerificationReportCore),
  );
}
