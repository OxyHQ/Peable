/**
 * Orbit's money surface (ADR 0015): the merchant's account, its balance and
 * balance transactions, payouts, application fees and the payout
 * reconciliation report.
 *
 * Every handler is a CORE `(req, res, merchant, surface)` shared by the
 * service-authed routes here and the Orbit dashboard (`routes/dashboard.ts`),
 * exactly as the webhook surface is.
 *
 * ## `Peable-Account`
 *
 * Stripe's `Stripe-Account`: a PLATFORM acting on one of its connected
 * accounts (`ca_…`, a marketplace seller with a card account). Accepted on
 * `/v1/account`, `/v1/account_links`, `/v1/balance`, `/v1/balance_transactions`,
 * `/v1/payouts` and `/v1/reports/payout_reconciliation` — the routes that
 * answer FROM an account — and refused everywhere else (`server.ts`): a payment
 * is the platform's record whoever it pays, so the destination of a charge is
 * a body field (`transfer_data`), not a header. The dashboard never takes it.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  BALANCE_TRANSACTION_TYPES,
  CURRENCY_CODES,
  PAYOUT_INTERVALS,
  PAYOUT_STATUSES,
  PAYOUT_WEEKLY_ANCHORS,
  isBaseUnitString,
  type AccountLink,
  type Balance,
  type PayoutReconciliationReport,
} from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import {
  findAccountByPublicId,
  findMerchantAccount,
  hasCardHalf,
  type CardConnectedAccountRow,
} from '../db/accounts/connectedAccountRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  findBalanceTransactionByPublicId,
  listBalanceTransactions,
  summarizePayoutTransactions,
  type LedgerScope,
} from '../db/money/ledgerRepository';
import {
  findPayoutByPublicId,
  findPayoutForMerchant,
  listPayouts,
} from '../db/money/payoutRepository';
import {
  findFeeByPublicId,
  listApplicationFees,
  listFeeRefunds,
} from '../db/money/applicationFeeRepository';
import { listMismatches, findMismatchByPublicId } from '../db/money/reconciliationRepository';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import {
  AccountImmutableFieldError,
  AccountMissingError,
  openMerchantAccount,
  toProviderUpdate,
  updateAccountSettings,
} from '../services/accounts/merchantAccount';
import { createAccountLink } from '../services/accounts/connectedAccountService';
import { readBalance } from '../services/money/ledger';
import { cancelPayout, createPayout } from '../services/money/payouts';
import { toAccountDTO } from '../lib/serializeSettlement';
import {
  toApplicationFeeDTO,
  toBalanceTransactionDTO,
  toFeeRefundDTO,
  toPayoutDTO,
  toReconciliationMismatchDTO,
} from '../lib/serializeMoney';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { metadataCreateSchema } from '../lib/metadata';
import { sendMoneyRefusal } from '../lib/moneyHttp';
import { toUnix } from '../lib/time';
import {
  answerList,
  completeList,
  parseQuery,
  surfaceListQuery,
  surfaceRetrieveQuery,
  type QuerySurface,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';

export const PEABLE_ACCOUNT_HEADER = 'Peable-Account';

/** The routes that take `Peable-Account` (see the module comment). */
export const PEABLE_ACCOUNT_ROUTES =
  /^\/v1\/(account|account_links|balance|balance_transactions|payouts|reports\/payout_reconciliation)(\/|$)/;

/**
 * `Peable-Account` anywhere but {@link PEABLE_ACCOUNT_ROUTES} is refused by
 * name: elsewhere it would be silently ignored, and a platform would believe it
 * had acted for its seller.
 */
export const refuseMisplacedPeableAccount: RequestHandler = (req, res, next) => {
  if (req.header(PEABLE_ACCOUNT_HEADER) === undefined || PEABLE_ACCOUNT_ROUTES.test(req.path)) {
    next();
    return;
  }
  sendError(
    res,
    400,
    'invalid_request_error',
    'Peable-Account is accepted only on /v1/account, /v1/account_links, /v1/balance, /v1/balance_transactions, /v1/payouts and /v1/reports/payout_reconciliation',
    'parameter_invalid',
    PEABLE_ACCOUNT_HEADER,
  );
};

/** Whose money a request reads: the account, and the ledger scope it mirrors. */
interface MoneyTarget {
  /** `null` for an Oxy first-party merchant with no account of its own. */
  readonly account: CardConnectedAccountRow | null;
  readonly scope: LedgerScope;
}

/**
 * Resolve the account a money request acts on, or answer and return `null`.
 *
 *  - `Peable-Account: ca_…` (API only): one of THIS merchant's sellers, with a
 *    card account. Anything else is a 403 that does not say whether the id
 *    exists elsewhere.
 *  - otherwise the merchant's own account; an Oxy first-party merchant without
 *    one reads its platform-attributed ledger when `firstPartyLedger` allows;
 *    anyone else is told they have no account (404 `account_missing`) — never
 *    shown zeros (ADR 0015).
 */
async function resolveTarget(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
  options: { readonly firstPartyLedger: boolean },
): Promise<MoneyTarget | null> {
  const header = surface === 'api' ? req.header(PEABLE_ACCOUNT_HEADER) : undefined;
  const db = getDb();
  if (header !== undefined) {
    const seller = await findAccountByPublicId(db, merchant.id, header);
    if (!seller || !hasCardHalf(seller)) {
      sendError(
        res,
        403,
        'permission_error',
        'Peable-Account does not name a connected account with a card account that this merchant controls',
        'account_invalid',
        PEABLE_ACCOUNT_HEADER,
      );
      return null;
    }
    return { account: seller, scope: { merchantId: merchant.id, connectedAccountId: seller.id } };
  }
  const own = await findMerchantAccount(db, merchant.id);
  if (own && hasCardHalf(own)) {
    return { account: own, scope: { merchantId: merchant.id, connectedAccountId: own.id } };
  }
  if (options.firstPartyLedger && merchant.firstParty) {
    return { account: null, scope: { merchantId: merchant.id, connectedAccountId: null } };
  }
  sendMoneyRefusal(res, new AccountMissingError());
  return null;
}

/** Same as `resolveTarget`, for a route that needs a real account (payouts, settings). */
async function resolveAccount(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<CardConnectedAccountRow | null> {
  const target = await resolveTarget(req, res, merchant, surface, { firstPartyLedger: false });
  return target?.account ?? null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const baseUnit = (name: string) =>
  z.string().refine(isBaseUnitString, `${name} must be a minor-unit integer string`);

const descriptor = z
  .string()
  .min(5)
  .max(22)
  .regex(/^[^<>\\'"*]*$/, 'a statement descriptor may not contain < > \\ \' " *');

const updateAccountBodySchema = z
  .object({
    country: z.string().length(2).optional(),
    business_type: z.enum(['individual', 'company']).optional(),
    business_profile: z
      .object({
        name: z.string().min(1).max(200).optional(),
        url: z.string().url().max(2048).optional(),
        support_email: z.string().email().max(320).optional(),
        support_url: z.string().url().max(2048).optional(),
        product_description: z.string().max(1000).optional(),
        mcc: z
          .string()
          .regex(/^[0-9]{4}$/)
          .optional(),
      })
      .strict()
      .optional(),
    settings: z
      .object({
        payouts: z
          .object({
            schedule: z
              .object({
                interval: z.enum(PAYOUT_INTERVALS),
                delay_days: z.number().int().min(1).max(365).optional(),
                weekly_anchor: z.enum(PAYOUT_WEEKLY_ANCHORS).optional(),
                monthly_anchor: z.number().int().min(1).max(31).optional(),
              })
              .strict()
              .superRefine((schedule, ctx) => {
                if (schedule.weekly_anchor !== undefined && schedule.interval !== 'weekly') {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['weekly_anchor'],
                    message: 'weekly_anchor is for a weekly schedule',
                  });
                }
                if (schedule.monthly_anchor !== undefined && schedule.interval !== 'monthly') {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['monthly_anchor'],
                    message: 'monthly_anchor is for a monthly schedule',
                  });
                }
              })
              .optional(),
            statement_descriptor: descriptor.optional(),
          })
          .strict()
          .optional(),
        payments: z.object({ statement_descriptor: descriptor.optional() }).strict().optional(),
        branding: z
          .object({
            primary_color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional(),
            secondary_color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const accountLinkBodySchema = z
  .object({
    refresh_url: z.string().url(),
    return_url: z.string().url(),
    type: z.enum(['account_onboarding', 'account_update']).optional(),
  })
  .strict();

const createPayoutBodySchema = z
  .object({
    amount: baseUnit('amount').refine((value) => value !== '0', 'amount must be positive'),
    currency: z.enum(CURRENCY_CODES),
    description: z.string().max(1000).optional(),
    statement_descriptor: z.string().min(1).max(22).optional(),
    method: z.enum(['standard', 'instant']).optional(),
    metadata: metadataCreateSchema.optional(),
  })
  .strict();

const balanceTransactionsQuery = surfaceListQuery({
  type: z.enum(BALANCE_TRANSACTION_TYPES).optional(),
  payout: z.string().min(1).max(255).optional(),
  source: z.string().min(1).max(255).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3,4}$/)
    .optional(),
});
const payoutsQuery = surfaceListQuery({ status: z.enum(PAYOUT_STATUSES).optional() });
const applicationFeesQuery = surfaceListQuery({
  payment_intent: z.string().min(1).max(255).optional(),
});
const reconciliationReportQuery = surfaceListQuery({ payout: z.string().min(1).max(255) });
const mismatchesQuery = surfaceListQuery({ open: z.enum(['true', 'false']).optional() });
const retrieveQuery = surfaceRetrieveQuery();
const emptyBody = z.object({}).strict();

function paramId(req: Request, res: Response): string | null {
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export async function retrieveAccount(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  res.status(200).json(toAccountDTO(account));
}

/**
 * `POST /v1/account`: open the merchant's account (the first time, with
 * `country` + `business_type`), or write its settings to the provider.
 */
export async function updateAccount(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const parsed = updateAccountBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const body = parsed.data;
  try {
    const usesHeader = surface === 'api' && req.header(PEABLE_ACCOUNT_HEADER) !== undefined;
    const own = usesHeader ? null : await findMerchantAccount(getDb(), merchant.id);
    if (!usesHeader && !own) {
      if (body.country === undefined || body.business_type === undefined) {
        throw new AccountMissingError(
          'this merchant has no fiat account; open one with country and business_type',
        );
      }
      const { account, created } = await openMerchantAccount(merchant, {
        ...body,
        country: body.country,
        business_type: body.business_type,
      });
      res.status(created ? 201 : 200).json(toAccountDTO(account));
      return;
    }
    if (body.country !== undefined) throw new AccountImmutableFieldError('country');
    if (body.business_type !== undefined) throw new AccountImmutableFieldError('business_type');
    const account = await resolveAccount(req, res, merchant, surface);
    if (!account) return;
    const update = toProviderUpdate(body);
    res
      .status(200)
      .json(toAccountDTO(update ? await updateAccountSettings(account, update) : account));
  } catch (error) {
    if (sendMoneyRefusal(res, error)) return;
    throw error;
  }
}

/** `POST /v1/account_links`: hosted onboarding for the account, minted on demand. */
export async function createAccountOnboardingLink(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const parsed = accountLinkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  try {
    const link = await createAccountLink({
      account,
      refreshUrl: parsed.data.refresh_url,
      returnUrl: parsed.data.return_url,
      ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
    });
    const body: AccountLink = {
      object: 'account_link',
      livemode: account.livemode,
      url: link.url,
      expires_at: toUnix(link.expiresAt),
    };
    res.status(201).json(body);
  } catch (error) {
    if (sendMoneyRefusal(res, error)) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Balance and balance transactions
// ---------------------------------------------------------------------------

export async function retrieveBalance(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const target = await resolveTarget(req, res, merchant, surface, { firstPartyLedger: true });
  if (!target) return;
  const figures = await readBalance(target.scope);
  const body: Balance = {
    object: 'balance',
    livemode: merchant.livemode,
    available: figures.available,
    pending: figures.pending,
    informational: figures.informational,
    account: target.account?.publicId ?? null,
  };
  res.status(200).json(body);
}

export async function answerBalanceTransactionList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, balanceTransactionsQuery[surface]);
  if (!query) return;
  const target = await resolveTarget(req, res, merchant, surface, { firstPartyLedger: true });
  if (!target) return;
  const db = getDb();
  let payoutId: string | undefined;
  if (query.payout !== undefined) {
    const payout = await findPayoutForMerchant(db, merchant.id, query.payout);
    if (!payout) {
      sendError(
        res,
        400,
        'invalid_request_error',
        'payout does not name an object this caller can read',
        'resource_missing',
        'payout',
      );
      return;
    }
    payoutId = payout.id;
  }
  await answerList(req, res, {
    query,
    type: 'balance_transaction',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findBalanceTransactionByPublicId(db, target.scope, publicId))?.id ?? null,
    fetch: (page) =>
      listBalanceTransactions(
        db,
        target.scope,
        {
          ...(query.type !== undefined ? { type: query.type } : {}),
          ...(payoutId !== undefined ? { payoutId } : {}),
          ...(query.source !== undefined ? { sourceId: query.source } : {}),
          ...(query.currency !== undefined ? { currency: query.currency.toUpperCase() } : {}),
        },
        page,
      ),
    serialize: toBalanceTransactionDTO,
  });
}

export async function retrieveBalanceTransaction(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const id = paramId(req, res);
  if (!id) return;
  const target = await resolveTarget(req, res, merchant, surface, { firstPartyLedger: true });
  if (!target) return;
  const row = await findBalanceTransactionByPublicId(getDb(), target.scope, id);
  if (!row) {
    sendError(res, 404, 'invalid_request_error', 'balance transaction not found');
    return;
  }
  res.status(200).json(toBalanceTransactionDTO(row));
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

export async function answerPayoutList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, payoutsQuery[surface]);
  if (!query) return;
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'payout',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findPayoutByPublicId(db, merchant.id, account.id, publicId))?.id ?? null,
    fetch: (page) =>
      listPayouts(
        db,
        merchant.id,
        account.id,
        query.status !== undefined ? { status: query.status } : {},
        page,
      ),
    serialize: toPayoutDTO,
  });
}

async function payoutOf(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  account: CardConnectedAccountRow,
) {
  const id = paramId(req, res);
  if (!id) return null;
  const payout = await findPayoutByPublicId(getDb(), merchant.id, account.id, id);
  if (!payout) {
    sendError(res, 404, 'invalid_request_error', 'payout not found');
    return null;
  }
  return payout;
}

export async function retrievePayout(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  const payout = await payoutOf(req, res, merchant, account);
  if (!payout) return;
  res.status(200).json(toPayoutDTO(payout));
}

export async function createPayoutCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const parsed = createPayoutBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  try {
    const payout = await createPayout({
      account,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      method: parsed.data.method ?? 'standard',
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.statement_descriptor !== undefined
        ? { statementDescriptor: parsed.data.statement_descriptor }
        : {}),
      metadata: parsed.data.metadata ?? {},
    });
    res.status(201).json(toPayoutDTO(payout));
  } catch (error) {
    if (sendMoneyRefusal(res, error)) return;
    throw error;
  }
}

export async function cancelPayoutCore(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const parsed = emptyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  const payout = await payoutOf(req, res, merchant, account);
  if (!payout) return;
  try {
    res.status(200).json(toPayoutDTO(await cancelPayout(account, payout)));
  } catch (error) {
    if (sendMoneyRefusal(res, error)) return;
    throw error;
  }
}

/**
 * The balance transactions one payout paid out, with their totals over the
 * whole payout. `complete` once the payout is `paid` and its transactions were
 * read from the provider; until then the set is not final.
 */
export async function answerPayoutReconciliation(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, reconciliationReportQuery[surface]);
  if (!query) return;
  const account = await resolveAccount(req, res, merchant, surface);
  if (!account) return;
  const db = getDb();
  const payout = await findPayoutByPublicId(db, merchant.id, account.id, query.payout);
  if (!payout) {
    sendError(
      res,
      400,
      'invalid_request_error',
      'payout does not name an object this caller can read',
      'resource_missing',
      'payout',
    );
    return;
  }
  const scope = { merchantId: merchant.id, connectedAccountId: account.id };
  const summary = await summarizePayoutTransactions(db, payout.id);
  const extra: Omit<PayoutReconciliationReport, 'object' | 'data' | 'has_more' | 'url'> = {
    payout: payout.publicId,
    status:
      payout.status === 'paid' && payout.transactionsSyncedAt !== null ? 'complete' : 'pending',
    currency: payout.currency,
    summary,
  };
  await answerList(req, res, {
    query,
    type: 'balance_transaction',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findBalanceTransactionByPublicId(db, scope, publicId))?.id ?? null,
    fetch: (page) => listBalanceTransactions(db, scope, { payoutId: payout.id }, page),
    serialize: toBalanceTransactionDTO,
    extra,
  });
}

// ---------------------------------------------------------------------------
// Application fees and reconciliation findings
// ---------------------------------------------------------------------------

export async function answerApplicationFeeList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, applicationFeesQuery[surface]);
  if (!query) return;
  const db = getDb();
  let paymentIntentId: string | undefined;
  if (query.payment_intent !== undefined) {
    const intent = await findIntentForMerchant(db, query.payment_intent, merchant.id);
    if (!intent) {
      sendError(
        res,
        400,
        'invalid_request_error',
        'payment_intent does not name an object this caller can read',
        'resource_missing',
        'payment_intent',
      );
      return;
    }
    paymentIntentId = intent.id;
  }
  await answerList(req, res, {
    query,
    type: 'application_fee',
    merchantId: merchant.id,
    cursor: async (publicId) => (await findFeeByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) =>
      listApplicationFees(
        db,
        merchant.id,
        paymentIntentId !== undefined ? { paymentIntentId } : {},
        page,
      ),
    serialize: async (row) => toApplicationFeeDTO(row, await listFeeRefunds(db, row.id)),
  });
}

export async function retrieveApplicationFee(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  if (!parseQuery(req, res, retrieveQuery[surface])) return;
  const id = paramId(req, res);
  if (!id) return;
  const db = getDb();
  const fee = await findFeeByPublicId(db, merchant.id, id);
  if (!fee) {
    sendError(res, 404, 'invalid_request_error', 'application fee not found');
    return;
  }
  res.status(200).json(toApplicationFeeDTO(fee, await listFeeRefunds(db, fee.id)));
}

export async function answerFeeRefundList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
): Promise<void> {
  const id = paramId(req, res);
  if (!id) return;
  const db = getDb();
  const fee = await findFeeByPublicId(db, merchant.id, id);
  if (!fee) {
    sendError(res, 404, 'invalid_request_error', 'application fee not found');
    return;
  }
  // A fee's refunds are a small complete set (one per partial refund).
  res.status(200).json(completeList(req, (await listFeeRefunds(db, fee.id)).map(toFeeRefundDTO)));
}

export async function answerMismatchList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, mismatchesQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'reconciliation_mismatch',
    merchantId: merchant.id,
    cursor: async (publicId) =>
      (await findMismatchByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) =>
      listMismatches(db, merchant.id, query.open === 'true' ? { open: true } : {}, page),
    serialize: toReconciliationMismatchDTO,
  });
}

// ---------------------------------------------------------------------------
// The service-authed router
// ---------------------------------------------------------------------------

type Core = (
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface,
) => Promise<void>;

export function createMoneyRouter(deps: { requireMerchant: RequestHandler }): Router {
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
  const api = (core: Core) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await core(req, res, merchant, 'api');
    });

  router.get('/v1/account', ...read, api(retrieveAccount));
  router.post('/v1/account', ...write, api(updateAccount));
  router.post('/v1/account_links', ...write, api(createAccountOnboardingLink));
  router.get('/v1/balance', ...read, api(retrieveBalance));
  router.get('/v1/balance_transactions', ...read, api(answerBalanceTransactionList));
  router.get('/v1/balance_transactions/:id', ...read, api(retrieveBalanceTransaction));
  router.get('/v1/payouts', ...read, api(answerPayoutList));
  router.post('/v1/payouts', ...write, api(createPayoutCore));
  router.get('/v1/payouts/:id', ...read, api(retrievePayout));
  router.post('/v1/payouts/:id/cancel', ...write, api(cancelPayoutCore));
  router.get('/v1/reports/payout_reconciliation', ...read, api(answerPayoutReconciliation));
  router.get('/v1/application_fees', ...read, api(answerApplicationFeeList));
  router.get('/v1/application_fees/:id', ...read, api(retrieveApplicationFee));
  router.get(
    '/v1/application_fees/:id/refunds',
    ...read,
    api((req, res, merchant) => answerFeeRefundList(req, res, merchant)),
  );
  return router;
}
