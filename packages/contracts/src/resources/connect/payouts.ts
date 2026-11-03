import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, idParam, listQuery, metadataCreateParam } from '../../common/params';
import { amount, livemode, metadata, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  PAYOUT_DESTINATION_TYPES,
  PAYOUT_METHODS,
  PAYOUT_RECONCILIATION_STATUSES,
  PAYOUT_STATUSES,
} from '../../vocabulary/connect';
import { CURRENCY_CODES, isBaseUnitString } from '../../vocabulary/money';
import { balanceTransactionSchema } from './balance';

/**
 * Payouts (`po_…`) — the provider moving the merchant's balance to the
 * merchant's bank (ADR 0015 §4). Executed by the provider, always; Orbit
 * instructs (a manual payout) or mirrors (a scheduled one). The bank account
 * itself stays at the provider and is never on this object.
 */
export const payoutSchema = defineObject(
  'payout',
  'Payout',
  z
    .object({
      id: z.string(),
      object: z.literal('payout'),
      livemode,
      account: z.string().describe('The account (`ca_…`) paid out.'),
      amount,
      currency: z.string().describe('Upper-case ISO 4217 code.'),
      status: z.enum(PAYOUT_STATUSES),
      arrival_date: unixSeconds
        .nullable()
        .describe('When the funds are expected in the bank, as the provider estimates.'),
      automatic: z
        .boolean()
        .describe(
          "`true` when the provider's schedule created it, `false` for `POST /v1/payouts`.",
        ),
      method: z.enum(PAYOUT_METHODS),
      type: z.enum(PAYOUT_DESTINATION_TYPES),
      description: z.string().nullable(),
      statement_descriptor: z.string().nullable(),
      failure_code: z
        .string()
        .nullable()
        .describe("The provider's failure code when `failed`; never its prose."),
      balance_transaction: z
        .string()
        .nullable()
        .describe("The payout's own `txn_…` once ingested."),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'po_0193b8f31e2d4c5a9b60',
        object: 'payout',
        livemode: false,
        account: 'ca_0193b8f2c1a87d3e9f4a',
        amount: '150000',
        currency: 'EUR',
        status: 'in_transit',
        arrival_date: 1793923200,
        automatic: false,
        method: 'standard',
        type: 'bank_account',
        description: 'November payout',
        statement_descriptor: 'ROSEN PAYOUT',
        failure_code: null,
        balance_transaction: 'txn_0193b8f31f0a7e3d2c41',
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type Payout = Expand<z.output<typeof payoutSchema>>;

/**
 * `GET /v1/reports/payout_reconciliation?payout=po_…` — the balance
 * transactions one payout paid out, with their totals. A list page with the
 * report's fields beside it.
 */
export const payoutReconciliationReportSchema = defineComponent(
  'PayoutReconciliationReport',
  z
    .object({
      object: z.literal('list'),
      data: z.array(balanceTransactionSchema),
      has_more: z.boolean(),
      url: z.string(),
      payout: z.string().describe('The payout (`po_…`) reconciled.'),
      status: z
        .enum(PAYOUT_RECONCILIATION_STATUSES)
        .describe(
          '`complete` once the payout is `paid` and its transactions were read from the provider; `pending` before — the set is not final and the totals may grow.',
        ),
      currency: z.string(),
      summary: z
        .object({
          count: z.number().int().nonnegative(),
          amount: signedAmount,
          fee: signedAmount,
          net: signedAmount,
        })
        .strict()
        .describe('Over EVERY transaction of the payout, not just this page.'),
    })
    .strict(),
);
export type PayoutReconciliationReport = Expand<z.output<typeof payoutReconciliationReportSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    payout: Payout;
  }
}

/** `POST /v1/payouts` — a payout instruction for an account on a manual schedule. */
export const createPayoutParams = z
  .object({
    amount: z
      .string()
      .refine(isBaseUnitString, 'amount must be a minor-unit integer string')
      .refine((value) => value !== '0', 'amount must be positive'),
    currency: z.enum(CURRENCY_CODES),
    description: z.string().max(1000).optional(),
    statement_descriptor: z.string().min(1).max(22).optional(),
    method: z.enum(PAYOUT_METHODS).optional().describe('Defaults to `standard`.'),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreatePayoutParams = z.input<typeof createPayoutParams>;

export const listPayoutsQuery = listQuery({ status: z.enum(PAYOUT_STATUSES).optional() });
export type ListPayoutsParams = z.input<typeof listPayoutsQuery>;

/** `POST /v1/payouts/{id}/cancel` takes no parameters. */
export const cancelPayoutParams = z.object({}).strict();

export const payoutReconciliationQuery = listQuery({
  payout: idParam.describe('The payout (`po_…`) to reconcile.'),
});
export type PayoutReconciliationParams = z.input<typeof payoutReconciliationQuery>;

const payoutIdParam = { id: 'The payout (`po_…`).' } as const;

export const payoutRoutes = [
  defineRoute({
    operationId: 'listPayouts',
    method: 'get',
    path: '/v1/payouts',
    tag: 'Payouts',
    summary: 'List payouts',
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    query: listPayoutsQuery,
    response: listOf(payoutSchema),
    sdk: 'payouts.list',
    expandable: 'payout',
  }),
  defineRoute({
    operationId: 'createPayout',
    method: 'post',
    path: '/v1/payouts',
    tag: 'Payouts',
    summary: 'Create a payout',
    description:
      'An instruction to the provider, for an account on a `manual` payout schedule. The provider executes it; Orbit never moves the money itself.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    peableAccount: true,
    body: createPayoutParams,
    response: payoutSchema,
    status: 201,
    sdk: 'payouts.create',
  }),
  defineRoute({
    operationId: 'retrievePayout',
    method: 'get',
    path: '/v1/payouts/{id}',
    tag: 'Payouts',
    summary: 'Retrieve a payout',
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    params: payoutIdParam,
    query: expandOnlyQuery,
    response: payoutSchema,
    sdk: 'payouts.retrieve',
  }),
  defineRoute({
    operationId: 'cancelPayout',
    method: 'post',
    path: '/v1/payouts/{id}/cancel',
    tag: 'Payouts',
    summary: 'Cancel a payout',
    description: 'Only a manual payout the provider still allows to be canceled.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    peableAccount: true,
    params: payoutIdParam,
    body: cancelPayoutParams,
    response: payoutSchema,
    sdk: 'payouts.cancel',
  }),
  defineRoute({
    operationId: 'retrievePayoutReconciliation',
    method: 'get',
    path: '/v1/reports/payout_reconciliation',
    tag: 'Payouts',
    summary: 'Reconcile a payout',
    description:
      'The balance transactions one payout paid out, a page at a time, with totals over all of them.',
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    query: payoutReconciliationQuery,
    response: payoutReconciliationReportSchema,
    sdk: 'reports.payoutReconciliation',
    expandable: 'balance_transaction',
  }),
] as const;
