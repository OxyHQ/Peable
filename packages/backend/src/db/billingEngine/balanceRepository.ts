import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { CurrencyCode, CustomerBalanceTransactionType } from '@peable.to/shared-types';
import { customerBalanceTransactions, customers } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { nowMs, publicIdOf, requiredPublicIdOf } from './columns';

/**
 * The customer balance ledger (ADR 0018 §4). `customers.balance` is the
 * running total and `customer_balance_transactions` its history; the one
 * writer, {@link recordBalanceTransaction}, locks the customer, moves the
 * balance and appends the row in the caller's transaction, so the two can
 * never disagree.
 */

export interface BalanceTransactionRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly customerPublicId: string;
  readonly type: CustomerBalanceTransactionType;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly endingBalance: string;
  readonly description: string | null;
  readonly invoicePublicId: string | null;
  readonly creditNotePublicId: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

const T = 'customer_balance_transactions';
const COLUMNS = {
  id: customerBalanceTransactions.id,
  publicId: customerBalanceTransactions.publicId,
  merchantId: customerBalanceTransactions.merchantId,
  livemode: merchantLivemodeOf(customerBalanceTransactions.merchantId),
  customerPublicId: requiredPublicIdOf('customers', T, 'customer_id'),
  type: customerBalanceTransactions.type,
  amount: customerBalanceTransactions.amount,
  currency: customerBalanceTransactions.currency,
  endingBalance: customerBalanceTransactions.endingBalance,
  description: customerBalanceTransactions.description,
  invoicePublicId: publicIdOf('invoices', T, 'invoice_id'),
  creditNotePublicId: publicIdOf('credit_notes', T, 'credit_note_id'),
  metadata: customerBalanceTransactions.metadata,
  createdAt: customerBalanceTransactions.createdAt,
} as const;

const toRow = (row: { type: string; currency: string; [key: string]: unknown }) =>
  row as unknown as BalanceTransactionRow;

/** Why a balance movement was refused. */
export type BalanceRefusal = 'customer_missing' | 'currency_mismatch';

/**
 * Lock the customer, fix its currency if it has none, move its balance by
 * `amount` (signed) and append the ledger row. A zero amount writes nothing
 * and answers `null`.
 */
export async function recordBalanceTransaction(
  tx: Transaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly customerId: string;
    readonly type: CustomerBalanceTransactionType;
    readonly amount: bigint;
    readonly currency: CurrencyCode;
    readonly description?: string | null;
    readonly invoiceId?: string | null;
    readonly creditNoteId?: string | null;
    readonly metadata?: Record<string, string>;
  },
): Promise<BalanceTransactionRow | BalanceRefusal | null> {
  const [customer] = await tx
    .select({ balance: customers.balance, currency: customers.currency })
    .from(customers)
    .where(and(eq(customers.id, params.customerId), eq(customers.merchantId, params.merchantId)))
    .for('update');
  if (!customer) return 'customer_missing';
  if (customer.currency !== null && customer.currency !== params.currency) {
    return 'currency_mismatch';
  }
  if (params.amount === 0n) return null;
  const ending = BigInt(customer.balance) + params.amount;
  await tx
    .update(customers)
    .set({ balance: ending.toString(), currency: params.currency, updatedAt: nowMs })
    .where(eq(customers.id, params.customerId));
  const [row] = await tx
    .insert(customerBalanceTransactions)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      customerId: params.customerId,
      type: params.type,
      amount: params.amount.toString(),
      currency: params.currency,
      endingBalance: ending.toString(),
      description: params.description ?? null,
      invoiceId: params.invoiceId ?? null,
      creditNoteId: params.creditNoteId ?? null,
      metadata: params.metadata ?? {},
    })
    .returning(COLUMNS);
  if (!row) throw new Error('balance transaction insert returned no row');
  return toRow(row);
}

/**
 * Fix the customer's billing currency if it has none (its first subscription
 * or invoice). `false` when it already holds another one.
 */
export async function claimCustomerCurrency(
  tx: Transaction,
  customerId: string,
  currency: CurrencyCode,
): Promise<boolean> {
  const [customer] = await tx
    .select({ currency: customers.currency })
    .from(customers)
    .where(eq(customers.id, customerId))
    .for('update');
  if (!customer) return false;
  if (customer.currency === currency) return true;
  if (customer.currency !== null) return false;
  await tx
    .update(customers)
    .set({ currency, updatedAt: nowMs })
    .where(eq(customers.id, customerId));
  return true;
}

/** The customer's balance as it stands, locked for the caller's transaction. */
export async function lockCustomerBalance(
  tx: Transaction,
  customerId: string,
): Promise<{ balance: bigint; currency: CurrencyCode | null }> {
  const [customer] = await tx
    .select({ balance: customers.balance, currency: customers.currency })
    .from(customers)
    .where(eq(customers.id, customerId))
    .for('update');
  if (!customer) throw new Error(`customer ${customerId} vanished`);
  return { balance: BigInt(customer.balance), currency: customer.currency as CurrencyCode | null };
}

export async function findBalanceTransaction(
  db: DatabaseOrTransaction,
  publicId: string,
  customerId: string,
): Promise<BalanceTransactionRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(customerBalanceTransactions)
    .where(
      and(
        eq(customerBalanceTransactions.publicId, publicId),
        eq(customerBalanceTransactions.customerId, customerId),
      ),
    );
  return row ? toRow(row) : null;
}

export async function listBalanceTransactions(
  db: DatabaseOrTransaction,
  customerId: string,
  page: KeysetPage,
): Promise<{ data: BalanceTransactionRow[]; hasMore: boolean }> {
  const walk = keyset(customerBalanceTransactions.id, customerBalanceTransactions.createdAt, page);
  const rows = await db
    .select(COLUMNS)
    .from(customerBalanceTransactions)
    .where(and(eq(customerBalanceTransactions.customerId, customerId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}
