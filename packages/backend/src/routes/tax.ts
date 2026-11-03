/**
 * Peable Tax (ADR 0011): the merchant API (`/v1/tax/*`) and the owner's
 * dashboard surface. Every public route's request schema is the contract's
 * (`@peable.to/contracts` `taxRoutes`): the service validates with those
 * objects, and this file decides nothing about the wire's shape.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { createOxyAuthMiddleware } from '@oxy.so/core/server';
import {
  listTaxTransactionsQuery,
  TAX_CODES,
  type TaxReport,
  taxReportQuery,
} from '@peable.to/contracts';
import { oxy } from '../oxy';
import { requireAuthenticated, sendError, wrap, requireScope } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { fromUnix } from '../lib/time';
import {
  answerList,
  completeList,
  dashboardQuery,
  parseQuery,
  type QuerySurface,
} from '../lib/list';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { resolveMerchant, resolveMerchantByApp } from './paymentIntents';
import { resolveDashboardAccess, type DashboardAccess } from './dashboard';
import { assertAppMembership as realAssertAppMembership } from '../services/appMembership';
import { parseTaxRequest, TaxError, type TaxService } from '../services/tax/taxService';

/**
 * Each query, per surface: the API validates with the contract's schema; the
 * dashboard's copy also carries `environment` (the Test/Live toggle),
 * validated by `resolveDashboardAccess` before the core runs.
 */
const TRANSACTIONS_QUERY = {
  api: listTaxTransactionsQuery,
  dashboard: dashboardQuery(listTaxTransactionsQuery),
} as const;
const REPORT_QUERY = { api: taxReportQuery, dashboard: dashboardQuery(taxReportQuery) } as const;

/** Both tax-transaction lists — the merchant API's and the owner dashboard's — answer here. */
async function answerTaxTransactionList(
  req: Request,
  res: Response,
  tax: TaxService,
  merchant: MerchantRow,
  surface: QuerySurface,
): Promise<void> {
  const query = parseQuery(req, res, TRANSACTIONS_QUERY[surface]);
  if (!query) return;
  await answerList(req, res, {
    query,
    type: 'tax.transaction',
    merchantId: merchant.id,
    cursor: (publicId) => tax.findTransactionKey(merchant, publicId),
    fetch: (page) => tax.listTransactions(merchant, page),
    serialize: (transaction) => transaction,
  });
}

/** Answer a tax request: `TaxError` carries its own status and code; anything
 * else is the gateway's fault and says nothing more. */
async function answer(res: Response, action: () => Promise<unknown>, status = 200) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = await action();
    // The action wrote its own response (a CSV export).
    if (res.headersSent) return;
    if (result === undefined) res.status(204).end();
    else res.status(status).json(result);
  } catch (error) {
    if (error instanceof TaxError) {
      sendError(
        res,
        error.status,
        error.status >= 500 ? 'api_error' : 'invalid_request_error',
        error.message,
        error.code,
        error.param,
      );
      return;
    }
    throw error;
  }
}

/** A filing export: the report as CSV, one row per jurisdiction/rate. */
function reportCsv(report: TaxReport): string {
  const header = [
    'country',
    'state',
    'registration_id',
    'scheme',
    'collection',
    'tax_type',
    'rate_percentage',
    'currency',
    'transactions',
    'reversals',
    'taxable_amount_minor',
    'tax_amount_minor',
  ];
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    header.join(','),
    ...report.rows.map((row) =>
      [
        row.country,
        row.state,
        row.registration_id,
        row.scheme,
        row.collection,
        row.tax_type,
        row.rate_percentage,
        row.currency,
        row.transactions,
        row.reversals,
        row.taxable_amount,
        row.tax_amount,
      ]
        .map(cell)
        .join(','),
    ),
  ].join('\n');
}

/** A Unix-seconds instant as its UTC calendar day, for a file name. */
const day = (seconds: number) => fromUnix(seconds).toISOString().slice(0, 10);

async function sendReport(
  req: Request,
  res: Response,
  tax: TaxService,
  merchant: MerchantRow,
  surface: QuerySurface,
) {
  await answer(res, async () => {
    const query = parseTaxRequest(REPORT_QUERY[surface], req.query);
    const report = await tax.report(merchant, query);
    if (query.format !== 'csv') return report;
    res
      .status(200)
      .type('text/csv')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="peable-tax-${day(report.from)}-${day(report.to)}.csv"`,
      )
      .send(reportCsv(report));
    return null;
  });
}

/**
 * The merchant API (`/v1/tax/*`), for an app's server holding a service
 * credential. It reads settings, records location evidence, calculates and
 * reports. Registrations and the approval are the owner's, in the dashboard.
 */
export function createTaxRouter(deps: {
  requireMerchant: RequestHandler;
  tax?: TaxService;
}): Router {
  const router = Router();
  const read = [deps.requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const write = [deps.requireMerchant, requireAuthenticated, requireScope('payments:write')];
  const route = (
    action: (
      tax: TaxService,
      merchant: MerchantRow,
      req: Request,
      res: Response,
    ) => Promise<unknown>,
    status = 200,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      const tax = deps.tax;
      if (!tax) {
        sendError(
          res,
          404,
          'invalid_request_error',
          'Peable Tax is not enabled on this deployment.',
          'tax_not_enabled',
        );
        return;
      }
      if (status === -1) {
        await action(tax, merchant, req, res);
        return;
      }
      await answer(res, () => action(tax, merchant, req, res), status);
    });

  router.get(
    '/v1/tax/codes',
    ...read,
    route(async (_tax, _merchant, req) => completeList(req, TAX_CODES)),
  );
  router.get(
    '/v1/tax/settings',
    ...read,
    route((tax, merchant) => tax.getSettings(merchant)),
  );
  router.get(
    '/v1/tax/registrations',
    ...read,
    route(async (tax, merchant, req) => completeList(req, await tax.listRegistrations(merchant))),
  );
  router.get(
    '/v1/tax/products',
    ...read,
    route(async (tax, merchant, req) => completeList(req, await tax.listProductCodes(merchant))),
  );
  router.put(
    '/v1/tax/products/:productRef',
    ...write,
    route((tax, merchant, req) =>
      tax.setProductCode(merchant, req.params.productRef ?? '', req.body),
    ),
  );
  router.post(
    '/v1/tax/location_evidence',
    ...write,
    idempotent,
    route((tax, merchant, req) => tax.recordEvidence(merchant, req.body), 201),
  );
  router.get(
    '/v1/tax/location_evidence/:id',
    ...read,
    route((tax, merchant, req) => tax.retrieveEvidence(merchant, req.params.id ?? '')),
  );
  router.post(
    '/v1/tax/calculations',
    ...write,
    idempotent,
    route((tax, merchant, req) => tax.calculate(merchant, req.body, { requireActive: true }), 201),
  );
  router.get(
    '/v1/tax/calculations/:id',
    ...read,
    route((tax, merchant, req) => tax.retrieveCalculation(merchant, req.params.id ?? '')),
  );
  router.get(
    '/v1/tax/transactions',
    ...read,
    route(
      (tax, merchant, req, res) => answerTaxTransactionList(req, res, tax, merchant, 'api'),
      -1,
    ),
  );
  // A refund the rail cannot report itself (FairCoin: the seller refunds from
  // their own wallet). Card refunds are observed from the provider.
  router.post(
    '/v1/tax/transactions/:id/reversals',
    ...write,
    idempotent,
    route((tax, merchant, req) => tax.createReversal(merchant, req.params.id ?? '', req.body), 201),
  );
  router.get(
    '/v1/tax/reports/summary',
    ...read,
    route((tax, merchant, req, res) => sendReport(req, res, tax, merchant, 'api'), -1),
  );
  return router;
}

/**
 * The owner's surface (`/v1/dashboard/applications/:applicationId/tax/*`):
 * a signed-in Oxy member of the application. Reading needs `billing:read`;
 * changing settings or registrations, and approving, need `billing:manage` —
 * oxy-api's own permission vocabulary, never re-implemented here.
 */
export function createDashboardTaxRouter(deps: {
  tax?: TaxService;
  requireOxyUser?: RequestHandler;
  assertAppMembership?: typeof realAssertAppMembership;
}): Router {
  const router = Router();
  const requireOxyUser = deps.requireOxyUser ?? createOxyAuthMiddleware(oxy);
  const assertAppMembership = deps.assertAppMembership ?? realAssertAppMembership;
  const base = '/v1/dashboard/applications/:applicationId/tax';
  const route = (
    permission: 'billing:read' | 'billing:manage',
    action: (
      tax: TaxService,
      merchant: MerchantRow,
      req: Request,
      access: DashboardAccess,
      res: Response,
    ) => Promise<unknown>,
    status = 200,
  ) =>
    wrap(async (req, res) => {
      const access = await resolveDashboardAccess(req, res, { assertAppMembership });
      if (!access) return;
      const permissions = access.membership.permissions ?? [];
      // `billing:manage` implies reading.
      if (
        !permissions.includes(permission) &&
        !(permission === 'billing:read' && permissions.includes('billing:manage'))
      ) {
        sendError(res, 403, 'permission_error', `${permission} is required for tax settings`);
        return;
      }
      const merchant = await resolveMerchantByApp(access.applicationId, access.environment, res);
      if (!merchant) return;
      const tax = deps.tax;
      if (!tax) {
        sendError(
          res,
          404,
          'invalid_request_error',
          'Peable Tax is not enabled on this deployment.',
          'tax_not_enabled',
        );
        return;
      }
      if (status === -1) {
        await action(tax, merchant, req, access, res);
        return;
      }
      await answer(res, () => action(tax, merchant, req, access, res), status);
    });

  router.get(
    `${base}/codes`,
    requireOxyUser,
    route('billing:read', async (_tax, _merchant, req) => completeList(req, TAX_CODES)),
  );
  router.get(
    `${base}/settings`,
    requireOxyUser,
    route('billing:read', (tax, merchant) => tax.getSettings(merchant)),
  );
  router.patch(
    `${base}/settings`,
    requireOxyUser,
    route('billing:manage', (tax, merchant, req) => tax.updateSettings(merchant, req.body)),
  );
  router.get(
    `${base}/registrations`,
    requireOxyUser,
    route('billing:read', async (tax, merchant, req) =>
      completeList(req, await tax.listRegistrations(merchant)),
    ),
  );
  router.post(
    `${base}/registrations`,
    requireOxyUser,
    route(
      'billing:manage',
      (tax, merchant, req) => tax.createRegistration(merchant, req.body),
      201,
    ),
  );
  router.delete(
    `${base}/registrations/:id`,
    requireOxyUser,
    route('billing:manage', (tax, merchant, req) =>
      tax.deleteRegistration(merchant, req.params.id ?? ''),
    ),
  );
  router.post(
    `${base}/registrations/:id/end`,
    requireOxyUser,
    route('billing:manage', (tax, merchant, req) =>
      tax.endRegistration(merchant, req.params.id ?? '', req.body),
    ),
  );
  router.get(
    `${base}/products`,
    requireOxyUser,
    route('billing:read', async (tax, merchant, req) =>
      completeList(req, await tax.listProductCodes(merchant)),
    ),
  );
  router.put(
    `${base}/products/:productRef`,
    requireOxyUser,
    route('billing:manage', (tax, merchant, req) =>
      tax.setProductCode(merchant, req.params.productRef ?? '', req.body),
    ),
  );
  // The owner's approval. Whether the platform's provider account calculates
  // is decided by oxy-api's own view of the application, never by the body.
  router.post(
    `${base}/approve`,
    requireOxyUser,
    route('billing:manage', (tax, merchant, _req, access) =>
      tax.approve(merchant, {
        userId: access.userId,
        officialApplication: access.membership.official === true,
      }),
    ),
  );
  // Preview: evidence and a calculation against the CURRENT approved state,
  // allowed before approval so an owner can see what a sale would cost.
  router.post(
    `${base}/location_evidence`,
    requireOxyUser,
    route('billing:read', (tax, merchant, req) => tax.recordEvidence(merchant, req.body), 201),
  );
  router.post(
    `${base}/calculations`,
    requireOxyUser,
    route(
      'billing:read',
      (tax, merchant, req) => tax.calculate(merchant, req.body, { requireActive: false }),
      201,
    ),
  );
  router.get(
    `${base}/transactions`,
    requireOxyUser,
    route(
      'billing:read',
      (tax, merchant, req, _access, res) =>
        answerTaxTransactionList(req, res, tax, merchant, 'dashboard'),
      -1,
    ),
  );
  router.get(
    `${base}/reports/summary`,
    requireOxyUser,
    route(
      'billing:read',
      (tax, merchant, req, _access, res) => sendReport(req, res, tax, merchant, 'dashboard'),
      -1,
    ),
  );
  return router;
}
