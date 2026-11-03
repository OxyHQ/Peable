/**
 * The seller-account surface: `/v1/connected_accounts`.
 *
 * Every handler is a CORE `(req, res, merchant[, surface])` shared by the
 * service-authed routes here and Orbit's Connect screen (`routes/dashboard.ts`),
 * as the money and webhook surfaces are. A core never authenticates: its caller
 * has already resolved the merchant — from the service credential here, from
 * the dashboard's membership gate there.
 *
 * Every lookup is scoped to that merchant — never "find by id, then check the
 * owner", which is the shape that leaks one marketplace's sellers to another
 * the day someone forgets the second half.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import {
  type AccountLink,
  createConnectedAccountLinkParams,
  createConnectedAccountParams,
  expandOnlyQuery,
  listConnectedAccountsQuery,
  refreshConnectedAccountParams,
} from '@peable.to/contracts';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import {
  findAccountByExternalRef,
  findAccountByPublicId,
  listAccountsForMerchant,
} from '../db/accounts/connectedAccountRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  AccountConflictError,
  AccountRailMissingError,
  AccountsUnavailableError,
  createAccountLink,
  ensureConnectedAccount,
  FaircoinNetworkRefusedError,
  refreshConnectedAccount,
} from '../services/accounts/connectedAccountService';
import {
  AccountAlreadyActiveError,
  createFaircoinAccountLink,
} from '../services/accounts/faircoinOnboarding';
import { ProviderError } from '../services/providers/provider';
import { toConnectedAccountDTO } from '../lib/serializeSettlement';
import {
  requireAuthenticated,
  sendError,
  sendProviderError,
  sendValidationError,
  wrap,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { toUnix } from '../lib/time';
import { answerList, parseQuery, type QuerySurface, surfaceQuery } from '../lib/list';
import { resolveMerchant } from './paymentIntents';

/**
 * Request schemas: the contract's (`@peable.to/contracts`
 * `connectedAccountRoutes`); the dashboard surface accepts the same plus its
 * `environment` toggle.
 */
const listAccountsQuery = surfaceQuery(listConnectedAccountsQuery);
const retrieveAccountQuery = surfaceQuery(expandOnlyQuery);

/** The `:accountId` of a matched route, or the 400 when Express somehow lacks it. */
function accountIdParam(req: Request, res: Response): string | null {
  const { accountId } = req.params;
  if (!accountId) {
    sendError(res, 400, 'invalid_request_error', 'account id is required');
    return null;
  }
  return accountId;
}

/** One of THIS merchant's sellers by `ca_…`, or the 404 that does not say whether it exists elsewhere. */
async function sellerOf(req: Request, res: Response, merchant: MerchantRow) {
  const accountId = accountIdParam(req, res);
  if (!accountId) return null;
  const account = await findAccountByPublicId(getDb(), merchant.id, accountId);
  if (!account) {
    sendError(res, 404, 'invalid_request_error', 'connected account not found');
    return null;
  }
  return account;
}

/** The refusals every write core shares; `false` when `error` is not one of them. */
function sendAccountRefusal(res: Response, error: unknown): boolean {
  if (error instanceof FaircoinNetworkRefusedError) {
    sendError(res, 400, 'invalid_request_error', error.message);
    return true;
  }
  if (
    error instanceof AccountConflictError ||
    error instanceof AccountRailMissingError ||
    error instanceof AccountAlreadyActiveError
  ) {
    sendError(res, 409, 'invalid_request_error', error.message);
    return true;
  }
  if (error instanceof AccountsUnavailableError) {
    sendError(res, 503, 'api_error', error.message);
    return true;
  }
  if (error instanceof ProviderError) {
    sendProviderError(res, error);
    return true;
  }
  return false;
}

/**
 * `POST /v1/connected_accounts`: open (or return) the account for one seller.
 *
 * Answers 200 for an account that already existed and 201 for one just
 * opened, so a merchant can tell a converged retry from a real creation —
 * which matters here more than usual, because the underlying object cannot be
 * deleted and "did I just open a second one" is a question they will ask.
 */
export async function createConnectedAccountCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createConnectedAccountParams.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const { country, business_type: businessType } = parsed.data;
  const card =
    country !== undefined && businessType !== undefined ? { country, businessType } : undefined;
  const faircoin = parsed.data.faircoin
    ? { network: parsed.data.faircoin.network, oxyUserId: parsed.data.faircoin.oxy_user_id }
    : undefined;
  const base = {
    merchantId: merchant.id,
    environment: merchant.environment,
    externalRef: parsed.data.external_ref,
  };
  // The schema already refuses a body with neither half; this is that same
  // fact said to the type checker, rather than asserted past it.
  const input = card
    ? { ...base, card, ...(faircoin ? { faircoin } : {}) }
    : faircoin
      ? { ...base, faircoin }
      : null;
  if (!input) {
    sendError(res, 400, 'invalid_request_error', 'open at least one rail');
    return;
  }

  try {
    const { account, created } = await ensureConnectedAccount(input);
    res.status(created ? 201 : 200).json(toConnectedAccountDTO(account));
  } catch (error) {
    if (sendAccountRefusal(res, error)) return;
    throw error;
  }
}

/** `GET /v1/connected_accounts`: every seller this merchant has onboarded, newest first. */
export async function answerConnectedAccountList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, listAccountsQuery[surface]);
  if (!query) return;

  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'connected_account',
    merchantId: merchant.id,
    // A PUBLIC `ca_…`, resolved ownership-scoped: a cursor naming ANOTHER
    // merchant's seller is a 400 exactly like an unknown one and never
    // confirms that the account exists.
    cursor: async (publicId) =>
      (await findAccountByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) => listAccountsForMerchant(db, merchant.id, page),
    serialize: toConnectedAccountDTO,
  });
}

/**
 * `GET /v1/connected_accounts/by_ref/:externalRef`: one seller, by the
 * merchant's own id for them.
 *
 * By `external_ref` and NOT by `ca_…`, deliberately: the merchant already has
 * their own id and may well have lost the `ca_…` (a create whose response
 * never arrived). Making the durable address the primary one is what keeps
 * recovery possible without a list scan.
 */
export async function retrieveConnectedAccountByRef(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveAccountQuery[surface])) return;
  // `noUncheckedIndexedAccess` types a route param as possibly undefined
  // even though Express guarantees it is present on a matched route.
  const { externalRef } = req.params;
  if (!externalRef) {
    sendError(res, 400, 'invalid_request_error', 'external_ref is required');
    return;
  }

  const account = await findAccountByExternalRef(getDb(), merchant.id, externalRef);
  if (!account) {
    sendError(res, 404, 'invalid_request_error', 'connected account not found');
    return;
  }
  res.status(200).json(toConnectedAccountDTO(account));
}

/** `GET /v1/connected_accounts/:accountId`. */
export async function retrieveConnectedAccount(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveAccountQuery[surface])) return;
  const account = await sellerOf(req, res, merchant);
  if (!account) return;
  res.status(200).json(toConnectedAccountDTO(account));
}

/**
 * `POST /v1/connected_accounts/:accountId/refresh`: re-read this account from
 * the provider now.
 *
 * `payments:write` rather than `:read` on the API, because it costs a provider
 * call and a merchant looping it is a rate-limit problem at the provider rather
 * than here. The sweep and the inbound event keep it fresh without anyone
 * asking; this is for a seller staring at a dashboard.
 */
export async function refreshConnectedAccountCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = refreshConnectedAccountParams.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const account = await sellerOf(req, res, merchant);
  if (!account) return;
  try {
    res.status(200).json(toConnectedAccountDTO(await refreshConnectedAccount(account)));
  } catch (error) {
    if (sendAccountRefusal(res, error)) return;
    throw error;
  }
}

/**
 * `POST /v1/connected_accounts/:accountId/account_links`: a hosted onboarding
 * link for the seller.
 *
 * Minted on demand and never stored: these expire in minutes at the provider,
 * so a stored one is a link that has already died by the time a seller follows
 * it — and the failure looks like the seller's fault.
 */
export async function createConnectedAccountLinkCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const parsed = createConnectedAccountLinkParams.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const account = await sellerOf(req, res, merchant);
  if (!account) return;

  const rail = parsed.data.rail ?? 'card';
  try {
    const link =
      rail === 'faircoin'
        ? await createFaircoinAccountLink({
            account,
            refreshUrl: parsed.data.refresh_url,
            returnUrl: parsed.data.return_url,
          })
        : await createAccountLink({
            account,
            refreshUrl: parsed.data.refresh_url,
            returnUrl: parsed.data.return_url,
          });
    const body: AccountLink = {
      object: 'account_link',
      livemode: account.livemode,
      url: link.url,
      expires_at: toUnix(link.expiresAt),
    };
    res.status(201).json(body);
  } catch (error) {
    if (sendAccountRefusal(res, error)) return;
    throw error;
  }
}

type SellerCore = (req: Request, res: Response, merchant: MerchantRow) => Promise<void>;

/** The service-authed `/v1/connected_accounts` router. */
export function createConnectedAccountsRouter(deps: { requireMerchant: RequestHandler }): Router {
  const router = Router();
  const { requireMerchant } = deps;
  const read = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
  const write = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:write'),
    idempotent,
  ];
  const api = (core: SellerCore) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await core(req, res, merchant);
    });

  router.post('/v1/connected_accounts', ...write, api(createConnectedAccountCore));
  router.get(
    '/v1/connected_accounts',
    ...read,
    api((req, res, merchant) => answerConnectedAccountList(req, res, merchant, 'api')),
  );
  router.get(
    '/v1/connected_accounts/by_ref/:externalRef',
    ...read,
    api((req, res, merchant) => retrieveConnectedAccountByRef(req, res, merchant, 'api')),
  );
  router.get(
    '/v1/connected_accounts/:accountId',
    ...read,
    api((req, res, merchant) => retrieveConnectedAccount(req, res, merchant, 'api')),
  );
  router.post(
    '/v1/connected_accounts/:accountId/refresh',
    ...write,
    api(refreshConnectedAccountCore),
  );
  router.post(
    '/v1/connected_accounts/:accountId/account_links',
    ...write,
    api(createConnectedAccountLinkCore),
  );
  return router;
}
