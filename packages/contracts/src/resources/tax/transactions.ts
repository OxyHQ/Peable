import { z } from 'zod';
import { type List, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { listQuery } from '../../common/params';
import { nullableString, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_TRANSACTION_TYPES } from '../../vocabulary/tax';
import { baseUnitAmountParam } from '../catalog/shared';
import { taxCalculationLineItemSchema, taxCalculationSchema } from './calculations';

/**
 * A tax transaction (`taxtxn_…`, ADR 0011/0013): a calculation that was paid,
 * created by Peable when the payment it priced is accepted on its rail. The
 * report and filings are built from these. A `reversal` is a refund (or credit
 * note) of an earlier transaction, netted into the original's report rows,
 * never a deletion of it.
 */

/**
 * What a reversal gave back: the original calculation's amounts, scaled to the
 * refunded share and NEGATIVE (positive only when it reinstates an earlier
 * reversal, e.g. a refund the bank later failed).
 */
export const taxTransactionReversalSchema = defineComponent(
  'TaxTransactionReversal',
  z
    .object({
      amount_total: signedAmount,
      amount_net: signedAmount,
      tax_amount: signedAmount,
      line_items: z.array(taxCalculationLineItemSchema),
    })
    .strict(),
);
export type TaxTransactionReversal = z.output<typeof taxTransactionReversalSchema>;

export const taxTransactionSchema = defineObject(
  'tax.transaction',
  'TaxTransaction',
  z
    .object({
      object: z.literal('tax.transaction'),
      id: z.string().describe('`taxtxn_…`.'),
      type: z.enum(TAX_TRANSACTION_TYPES),
      calculation_id: z.string().describe('The calculation (`taxcalc_…`) that was paid.'),
      reference: z.string().describe("The rail's own object, e.g. the invoice id."),
      rail: z.string(),
      committed_at: unixSeconds.describe('The tax date a filing period is judged by.'),
      reversal_of: nullableString.describe("The original transaction's id, for a reversal."),
      reversal: taxTransactionReversalSchema.nullable(),
      calculation: taxCalculationSchema,
    })
    .strict(),
);
export type TaxTransaction = Expand<z.output<typeof taxTransactionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.transaction': TaxTransaction;
  }
}

export type TaxTransactionList = List<TaxTransaction>;

/** The shared list parameters; `created[...]` filters `committed_at`. */
export const listTaxTransactionsQuery = listQuery({});
export type ListTaxTransactionsParams = z.input<typeof listTaxTransactionsQuery>;

/**
 * Record a refund made outside Peable (a FairCoin payment is refunded from the
 * seller's own wallet, never by the gateway). Card refunds and credit notes are
 * observed from the provider instead, so the two cannot double-count one refund.
 */
export const createTaxReversalParams = z
  .object({
    reference: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .describe("The refund's own reference; a repeated reference returns the same reversal."),
    amount: baseUnitAmountParam
      .refine((value) => value !== '0', 'must be positive')
      .optional()
      .describe(
        'Gross base units refunded (what the payer got back). Omitted: everything not yet reversed.',
      ),
  })
  .strict();
export type CreateTaxReversalParams = z.input<typeof createTaxReversalParams>;

export const taxTransactionRoutes = [
  defineRoute({
    operationId: 'listTaxTransactions',
    method: 'get',
    path: '/v1/tax/transactions',
    tag: 'Tax',
    summary: 'List tax transactions',
    description:
      'Newest first. `created` filters on `committed_at` — the tax date a filing period is judged by.',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxTransactionsQuery,
    response: listOf(taxTransactionSchema),
    sdk: 'tax.transactions.list',
    expandable: 'tax.transaction',
  }),
  defineRoute({
    operationId: 'createTaxReversal',
    method: 'post',
    path: '/v1/tax/transactions/{id}/reversals',
    tag: 'Tax',
    summary: 'Reverse a tax transaction',
    description:
      'For a refund the rail cannot report itself (FairCoin). Card refunds and credit notes, and Orbit invoices, are reversed from their own records and are refused here.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The original transaction (`taxtxn_…`).' },
    body: createTaxReversalParams,
    response: taxTransactionSchema,
    status: 201,
    sdk: 'tax.transactions.createReversal',
  }),
] as const;
