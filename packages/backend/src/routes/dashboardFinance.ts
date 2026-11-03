import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { getDb } from '../db/postgres';
import { findIntentForMerchant } from '../db/payments/paymentIntentRepository';
import { listRefundsForIntent } from '../db/refunds/refundRepository';
import { listDisputesForIntent } from '../db/disputes/disputeRepository';
import { listTransfersForIntent } from '../db/transfers/transferRepository';
import {
  findAccountById,
  findAccountByPublicId,
  listAccountsForMerchant,
} from '../db/accounts/connectedAccountRepository';
import { toRefundDTO } from '../lib/serializeRefund';
import { toDisputeDTO } from '../lib/serialize';
import { toConnectedAccountDTO, toTransferDTO } from '../lib/serializeSettlement';
import { reportSettlement } from '../services/settlementReport';
import { remainingRefundable } from '../services/refunds/refundService';
import { sendError, wrap } from '../lib/http';
import { listDashboardBilling } from '../db/billing/dashboardBillingRepository';

const pageQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  starting_after: z.string().min(1).max(255).optional(),
});
const base = '/v1/dashboard/applications/:applicationId';
/** Same live user/application membership resolution as the existing dashboard reads. */
export function registerDashboardFinanceReads(
  router: Router,
  requireUser: RequestHandler,
  resolve: (req: Request, res: Response) => Promise<MerchantRow | null>,
) {
  for (const kind of ['refunds', 'disputes', 'settlement', 'transfers'] as const) {
    router.get(
      `${base}/payment_intents/:id/${kind}`,
      requireUser,
      wrap(async (req, res) => {
        const merchant = await resolve(req, res);
        if (!merchant) return;
        const intent = await findIntentForMerchant(getDb(), req.params.id ?? '', merchant.id);
        if (!intent) {
          sendError(res, 404, 'invalid_request_error', 'payment intent not found');
          return;
        }
        if (kind === 'settlement') {
          res.json({
            object: 'settlement',
            paymentIntentId: intent.publicId,
            ...(await reportSettlement(intent)),
          });
          return;
        }
        if (kind === 'refunds') {
          res.json({
            object: 'list',
            data: (await listRefundsForIntent(getDb(), intent.id)).map((row) =>
              toRefundDTO(row, intent.publicId, intent.status),
            ),
            remainingRefundable: await remainingRefundable(intent),
          });
          return;
        }
        if (kind === 'disputes') {
          res.json({
            object: 'list',
            data: (await listDisputesForIntent(getDb(), intent.id)).map((row) =>
              toDisputeDTO(row, intent.publicId),
            ),
          });
          return;
        }
        const rows = await listTransfersForIntent(getDb(), intent.id);
        const data = await Promise.all(
          rows.map(async (row) => {
            const account = await findAccountById(getDb(), merchant.id, row.connectedAccountId);
            if (!account) throw new Error('Transfer account cannot be read');
            return toTransferDTO(row, account.publicId, intent.publicId);
          }),
        );
        res.json({ object: 'list', data });
      }),
    );
  }
  router.get(
    `${base}/connected_accounts`,
    requireUser,
    wrap(async (req, res) => {
      const merchant = await resolve(req, res);
      if (!merchant) return;
      const parsed = pageQuery.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 422, 'invalid_request_error', 'invalid pagination');
        return;
      }
      const cursor = parsed.data.starting_after
        ? await findAccountByPublicId(getDb(), merchant.id, parsed.data.starting_after)
        : undefined;
      if (parsed.data.starting_after && !cursor) {
        sendError(res, 422, 'invalid_request_error', 'unknown starting_after');
        return;
      }
      const page = await listAccountsForMerchant(
        getDb(),
        merchant.id,
        parsed.data.limit,
        cursor?.id,
      );
      res.json({
        object: 'list',
        data: page.data.map(toConnectedAccountDTO),
        has_more: page.hasMore,
      });
    }),
  );
  for (const kind of ['customers', 'subscriptions', 'invoices'] as const) {
    router.get(
      `${base}/billing/${kind}`,
      requireUser,
      wrap(async (req, res) => {
        const merchant = await resolve(req, res);
        if (!merchant) return;
        const parsed = pageQuery.safeParse(req.query);
        if (!parsed.success) {
          sendError(res, 422, 'invalid_request_error', 'invalid pagination');
          return;
        }
        const result = await listDashboardBilling(
          getDb(),
          merchant,
          kind,
          parsed.data.limit,
          parsed.data.starting_after,
        );
        if (!result) {
          sendError(res, 422, 'invalid_request_error', 'unknown starting_after');
          return;
        }
        res.json({
          object: 'list',
          source: 'verified_provider_bindings',
          rail: 'stripe',
          data: result.data,
          has_more: result.hasMore,
        });
      }),
    );
  }
}
