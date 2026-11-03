import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand, expandable } from '../../common/objects';
import { expandOnlyQuery, expandParam, listQuery, metadataCreateParam } from '../../common/params';
import { currency, livemode, metadata, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { CUSTOMER_BALANCE_TRANSACTION_TYPES } from '../../vocabulary/invoices';
import { currencyParam, shortText, signedAmountParam } from './params';

/**
 * The customer balance ledger (`cbtxn_…`, ADR 0018 §3): every movement of a
 * customer's balance. Negative is credit the customer holds (Stripe's
 * convention), applied to their next invoice when it finalizes.
 */
export const customerBalanceTransactionSchema = defineObject(
  'customer_balance_transaction',
  'CustomerBalanceTransaction',
  z
    .object({
      id: z.string(),
      object: z.literal('customer_balance_transaction'),
      livemode,
      customer: expandable('customer', '`cus_…`, or the Customer with `expand[]=customer`.'),
      type: z.enum(CUSTOMER_BALANCE_TRANSACTION_TYPES),
      amount: signedAmount.describe('SIGNED: negative credits the customer, positive debits.'),
      currency,
      ending_balance: signedAmount.describe('SIGNED: the balance after this transaction.'),
      description: z.string().nullable(),
      invoice: expandable(
        'invoice',
        'The invoice it moved with (`in_…`, or the Invoice with `expand[]=invoice`).',
      ).nullable(),
      credit_note: z.string().nullable().describe('The credit note (`cn_…`) it came from.'),
      metadata,
      created: unixSeconds,
    })
    .strict(),
);
export type CustomerBalanceTransaction = Expand<z.output<typeof customerBalanceTransactionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    customer_balance_transaction: CustomerBalanceTransaction;
  }
}

/** An adjustment: a negative `amount` credits the customer, a positive one adds to what they owe. */
export const createCustomerBalanceTransactionParams = z
  .object({
    amount: signedAmountParam.describe('SIGNED: negative credits the customer, positive debits.'),
    currency: currencyParam,
    description: shortText(350).optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateCustomerBalanceTransactionParams = z.input<
  typeof createCustomerBalanceTransactionParams
>;

export const listCustomerBalanceTransactionsQuery = listQuery({});
export type CustomerBalanceTransactionListParams = z.input<
  typeof listCustomerBalanceTransactionsQuery
>;

const customerId = 'The customer (`cus_…`).';

export const customerBalanceTransactionRoutes = [
  defineRoute({
    operationId: 'createCustomerBalanceTransaction',
    method: 'post',
    path: '/v1/customers/{id}/balance_transactions',
    tag: 'Customer balance',
    summary: "Adjust a customer's balance",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: customerId },
    body: createCustomerBalanceTransactionParams,
    response: customerBalanceTransactionSchema,
    sdk: 'customerBalanceTransactions.create',
    expandable: 'customer_balance_transaction',
  }),
  defineRoute({
    operationId: 'listCustomerBalanceTransactions',
    method: 'get',
    path: '/v1/customers/{id}/balance_transactions',
    tag: 'Customer balance',
    summary: "List a customer's balance transactions",
    auth: 'service',
    scope: 'payments:read',
    params: { id: customerId },
    query: listCustomerBalanceTransactionsQuery,
    response: listOf(customerBalanceTransactionSchema),
    sdk: 'customerBalanceTransactions.list',
    expandable: 'customer_balance_transaction',
  }),
  defineRoute({
    operationId: 'retrieveCustomerBalanceTransaction',
    method: 'get',
    path: '/v1/customers/{id}/balance_transactions/{transaction}',
    tag: 'Customer balance',
    summary: 'Retrieve a customer balance transaction',
    auth: 'service',
    scope: 'payments:read',
    params: { id: customerId, transaction: 'The balance transaction (`cbtxn_…`).' },
    query: expandOnlyQuery,
    response: customerBalanceTransactionSchema,
    sdk: 'customerBalanceTransactions.retrieve',
    expandable: 'customer_balance_transaction',
  }),
] as const;
