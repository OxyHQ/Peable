import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, idParam, listQuery } from '../../common/params';
import { livemode, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { faircoinQuoteSchema } from '../payments/paymentIntents';
import {
  BALANCE_TRANSACTION_FEE_TYPES,
  BALANCE_TRANSACTION_STATUSES,
  BALANCE_TRANSACTION_TYPES,
  RECONCILIATION_MISMATCH_KINDS,
} from '../../vocabulary/connect';

/**
 * Balance and balance transactions (ADR 0015 §3–§5).
 *
 * MIRRORS, every one of them. The money is in the merchant's own provider
 * account; Orbit's double-entry ledger is fed by the provider's own balance
 * transactions and payouts for that account and reconciled against them daily.
 * Nothing here is computed by Orbit: a figure the provider has not given is
 * `null` with a status, never `0`.
 *
 * Every amount is a canonical integer STRING in the currency's smallest unit
 * that MAY be negative (`"-1500"`): a refund or a payout takes money out of a
 * balance.
 */

/** A currency as the provider reports it: upper-case ISO 4217, or `FAIR`. */
const ledgerCurrency = z.string().describe('Upper-case ISO 4217 code, or `FAIR`.');

/** One currency's figure in a balance. */
export const balanceAmountSchema = defineComponent(
  'BalanceAmount',
  z.object({ amount: signedAmount, currency: ledgerCurrency }).strict(),
);
export type BalanceAmount = z.output<typeof balanceAmountSchema>;

/**
 * `GET /v1/balance` — read from the ledger, per currency. A merchant without a
 * fiat account has NO balance and is told so (404 `account_missing`), never
 * shown zeros.
 */
export const balanceSchema = defineObject(
  'balance',
  'Balance',
  z
    .object({
      object: z.literal('balance'),
      livemode,
      available: z
        .array(balanceAmountSchema)
        .describe('Payable now: the provider has made these funds available.'),
      pending: z.array(balanceAmountSchema).describe('Not yet available at the provider.'),
      informational: z
        .array(balanceAmountSchema)
        .describe(
          "FairCoin received straight into the merchant's own wallet (ADR 0015 §5): recorded for the books only. Orbit never held it, so it is never payable.",
        ),
      account: z
        .string()
        .nullable()
        .describe(
          'The account (`ca_…`) this balance mirrors; `null` for an Oxy first-party merchant.',
        ),
    })
    .strict(),
  {
    examples: [
      {
        object: 'balance',
        livemode: false,
        available: [{ amount: '184250', currency: 'EUR' }],
        pending: [{ amount: '12900', currency: 'EUR' }],
        informational: [{ amount: '250000000', currency: 'FAIR' }],
        account: 'ca_0193b8f2c1a87d3e9f4a',
      },
    ],
  },
);
export type Balance = Expand<z.output<typeof balanceSchema>>;

/** One component of a transaction's fee. */
export const balanceTransactionFeeDetailSchema = defineComponent(
  'BalanceTransactionFeeDetail',
  z
    .object({
      amount: signedAmount,
      currency: ledgerCurrency,
      type: z.enum(BALANCE_TRANSACTION_FEE_TYPES),
    })
    .strict(),
);
export type BalanceTransactionFeeDetail = z.output<typeof balanceTransactionFeeDetailSchema>;

export const balanceTransactionSchema = defineObject(
  'balance_transaction',
  'BalanceTransaction',
  z
    .object({
      id: z.string().describe('`txn_…`'),
      object: z.literal('balance_transaction'),
      livemode,
      amount: signedAmount.describe('Gross, signed.'),
      fee: signedAmount
        .nullable()
        .describe(
          'What was taken, or `null` when the source gave no figure (never `0` for unknown).',
        ),
      net: signedAmount
        .nullable()
        .describe('`amount - fee`, as the provider reports it, or `null` with `fee`.'),
      currency: ledgerCurrency,
      type: z.enum(BALANCE_TRANSACTION_TYPES),
      reporting_category: z
        .string()
        .describe('A coarser grouping for reports (`charge`, `refund`, `payout`, `fee`, …).'),
      status: z.enum(BALANCE_TRANSACTION_STATUSES),
      available_on: unixSeconds
        .nullable()
        .describe(
          'When the funds became (or become) available; `null` for an informational entry.',
        ),
      created: unixSeconds.describe('When it happened at its source.'),
      description: z.string().nullable(),
      exchange_rate: z.number().nullable(),
      faircoin_quote: faircoinQuoteSchema
        .nullable()
        .describe(
          'A FairCoin payment of a fiat order: the quote it was priced at — its fiat equivalent (ADR 0021). Informational; no fiat moved.',
        ),
      fee_details: z.array(balanceTransactionFeeDetailSchema),
      source: z
        .string()
        .nullable()
        .describe(
          "The Orbit object that caused it (`ch_…`, `re_…`, `po_…`, `fee_…`, `tr_…`, `pi_…`), or `null` when the provider's source is not an object Orbit holds.",
        ),
      payout: z
        .string()
        .nullable()
        .describe('The payout (`po_…`) that paid this transaction out, once known.'),
      account: z
        .string()
        .nullable()
        .describe(
          'The account (`ca_…`) whose balance it moved; `null` for a first-party merchant.',
        ),
    })
    .strict(),
  {
    examples: [
      {
        id: 'txn_0193b8f30a6c4e21b7d9',
        object: 'balance_transaction',
        livemode: false,
        amount: '2000',
        fee: '88',
        net: '1912',
        currency: 'EUR',
        type: 'charge',
        reporting_category: 'charge',
        status: 'available',
        available_on: 1794355200,
        created: 1793750400,
        description: 'Order 6735',
        exchange_rate: null,
        faircoin_quote: null,
        fee_details: [{ amount: '88', currency: 'EUR', type: 'processing_fee' }],
        source: 'ch_0193b8f2f7c94b1d8e02',
        payout: null,
        account: 'ca_0193b8f2c1a87d3e9f4a',
      },
    ],
  },
);
export type BalanceTransaction = Expand<z.output<typeof balanceTransactionSchema>>;

/**
 * What the daily reconciliation found disagreeing with the provider (Orbit's
 * dashboard reads them). Never auto-corrected.
 */
export const reconciliationMismatchSchema = defineObject(
  'reconciliation_mismatch',
  'ReconciliationMismatch',
  z
    .object({
      id: z.string(),
      object: z.literal('reconciliation_mismatch'),
      livemode,
      account: z.string().nullable(),
      kind: z.enum(RECONCILIATION_MISMATCH_KINDS),
      object_id: z
        .string()
        .nullable()
        .describe('The Orbit object concerned (`txn_…`, `po_…`), when Orbit holds one.'),
      expected: z.record(z.string(), z.unknown()).nullable().describe('What the provider says.'),
      actual: z.record(z.string(), z.unknown()).nullable().describe('What the ledger holds.'),
      detected_at: unixSeconds,
      last_seen_at: unixSeconds,
      resolved_at: unixSeconds
        .nullable()
        .describe('Set when a later run no longer sees the difference.'),
    })
    .strict(),
);
export type ReconciliationMismatch = Expand<z.output<typeof reconciliationMismatchSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    balance: Balance;
    balance_transaction: BalanceTransaction;
    reconciliation_mismatch: ReconciliationMismatch;
  }
}

export const listBalanceTransactionsQuery = listQuery({
  type: z.enum(BALANCE_TRANSACTION_TYPES).optional(),
  payout: idParam.optional().describe('`po_…`: only the transactions that payout paid out.'),
  source: idParam.optional().describe('An Orbit object id the transaction was caused by.'),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3,4}$/)
    .optional()
    .describe('Case-insensitive.'),
});
export type ListBalanceTransactionsParams = z.input<typeof listBalanceTransactionsQuery>;

/** Reconciliation findings, as Orbit's dashboard lists them (not a public route). */
export const listReconciliationMismatchesQuery = listQuery({
  open: z.enum(['true', 'false']).optional().describe('`true`: only unresolved findings.'),
});

export const balanceRoutes = [
  defineRoute({
    operationId: 'retrieveBalance',
    method: 'get',
    path: '/v1/balance',
    tag: 'Balance',
    summary: 'Retrieve the balance',
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    query: expandOnlyQuery,
    response: balanceSchema,
    sdk: 'balance.retrieve',
  }),
  defineRoute({
    operationId: 'listBalanceTransactions',
    method: 'get',
    path: '/v1/balance_transactions',
    tag: 'Balance transactions',
    summary: 'List balance transactions',
    description: 'Newest first, filtered by `type`, `payout`, `source`, `currency` and `created`.',
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    query: listBalanceTransactionsQuery,
    response: listOf(balanceTransactionSchema),
    sdk: 'balanceTransactions.list',
    expandable: 'balance_transaction',
  }),
  defineRoute({
    operationId: 'retrieveBalanceTransaction',
    method: 'get',
    path: '/v1/balance_transactions/{id}',
    tag: 'Balance transactions',
    summary: 'Retrieve a balance transaction',
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    params: { id: 'The balance transaction (`txn_…`).' },
    query: expandOnlyQuery,
    response: balanceTransactionSchema,
    sdk: 'balanceTransactions.retrieve',
  }),
] as const;
