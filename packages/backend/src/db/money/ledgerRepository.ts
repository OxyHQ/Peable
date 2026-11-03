/**
 * Reads and writes for `balance_transactions` and `ledger_entries` — the
 * double-entry mirror of a merchant's provider balance (ADR 0015 §4).
 *
 * `postJournal` is the ONE writer of `ledger_entries`, and it refuses a set of
 * entries that does not sum to zero before anything is inserted: the zero sum
 * spans rows, so no CHECK can carry it, and this function is where it is true.
 */
import { and, asc, desc, eq, gt, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { BalanceTransactionStatus, BalanceTransactionType } from '@peable.to/shared-types';
import { balanceTransactions, connectedAccounts, ledgerEntries, payouts } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { LedgerBalanceType, LedgerJournalKind } from '../schema/valueSets';

export interface BalanceTransactionRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly connectedAccountId: string | null;
  readonly connectedAccountPublicId: string | null;
  readonly ingestionKey: string;
  readonly provider: string | null;
  readonly providerObjectId: string | null;
  readonly amount: string;
  readonly fee: string | null;
  readonly net: string | null;
  readonly currency: string;
  readonly type: BalanceTransactionType;
  readonly reportingCategory: string;
  readonly status: BalanceTransactionStatus;
  readonly availableOn: Date | null;
  readonly occurredAt: Date;
  readonly description: string | null;
  readonly exchangeRate: string | null;
  readonly feeDetails: readonly { amount: string; currency: string; type: string }[];
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly paymentIntentId: string | null;
  readonly payoutId: string | null;
  readonly payoutPublicId: string | null;
  readonly createdAt: Date;
}

const BT_COLUMNS = {
  livemode: merchantLivemodeOf(balanceTransactions.merchantId),
  id: balanceTransactions.id,
  publicId: balanceTransactions.publicId,
  merchantId: balanceTransactions.merchantId,
  connectedAccountId: balanceTransactions.connectedAccountId,
  connectedAccountPublicId: sql<
    string | null
  >`(select ${connectedAccounts.publicId} from ${connectedAccounts} where ${connectedAccounts.id} = ${balanceTransactions.connectedAccountId})`,
  ingestionKey: balanceTransactions.ingestionKey,
  provider: balanceTransactions.provider,
  providerObjectId: balanceTransactions.providerObjectId,
  amount: balanceTransactions.amount,
  fee: balanceTransactions.fee,
  net: balanceTransactions.net,
  currency: balanceTransactions.currency,
  type: balanceTransactions.type,
  reportingCategory: balanceTransactions.reportingCategory,
  status: balanceTransactions.status,
  availableOn: balanceTransactions.availableOn,
  occurredAt: balanceTransactions.occurredAt,
  description: balanceTransactions.description,
  exchangeRate: balanceTransactions.exchangeRate,
  feeDetails: balanceTransactions.feeDetails,
  sourceType: balanceTransactions.sourceType,
  sourceId: balanceTransactions.sourceId,
  paymentIntentId: balanceTransactions.paymentIntentId,
  payoutId: balanceTransactions.payoutId,
  payoutPublicId: sql<
    string | null
  >`(select ${payouts.publicId} from ${payouts} where ${payouts.id} = ${balanceTransactions.payoutId})`,
  createdAt: balanceTransactions.createdAt,
} as const;

function toRow(row: Record<string, unknown>): BalanceTransactionRow {
  return row as unknown as BalanceTransactionRow;
}

export interface InsertBalanceTransactionParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly connectedAccountId: string | null;
  readonly ingestionKey: string;
  readonly provider: string | null;
  readonly providerObjectId: string | null;
  readonly amount: string;
  readonly fee: string | null;
  readonly net: string | null;
  readonly currency: string;
  readonly type: BalanceTransactionType;
  readonly reportingCategory: string;
  readonly status: BalanceTransactionStatus;
  readonly availableOn: Date | null;
  readonly occurredAt: Date;
  readonly description: string | null;
  readonly exchangeRate: string | null;
  readonly feeDetails: readonly { amount: string; currency: string; type: string }[];
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly paymentIntentId: string | null;
  readonly payoutId: string | null;
}

/**
 * Record one balance transaction. `null` when its `ingestion_key` is already
 * recorded — the idempotency of ingestion: a provider page read twice, or two
 * readers racing over it, record each transaction once.
 */
export async function insertBalanceTransaction(
  db: DatabaseOrTransaction,
  params: InsertBalanceTransactionParams,
): Promise<BalanceTransactionRow | null> {
  const [row] = await db
    .insert(balanceTransactions)
    .values({ id: uuidv7(), ...params, feeDetails: [...params.feeDetails] })
    .onConflictDoNothing({ target: balanceTransactions.ingestionKey })
    .returning(BT_COLUMNS);
  return row ? toRow(row) : null;
}

export async function findBalanceTransactionByIngestionKey(
  db: DatabaseOrTransaction,
  ingestionKey: string,
): Promise<BalanceTransactionRow | null> {
  const [row] = await db
    .select(BT_COLUMNS)
    .from(balanceTransactions)
    .where(eq(balanceTransactions.ingestionKey, ingestionKey));
  return row ? toRow(row) : null;
}

/**
 * The provider moved a transaction's funds from pending to available. A
 * compare-and-swap on `pending`: two readers seeing the same release write it
 * once, and the `released` journal is posted only by the one that did.
 */
export async function releaseBalanceTransaction(
  db: DatabaseOrTransaction,
  id: string,
  availableOn: Date | null,
): Promise<BalanceTransactionRow | null> {
  const [row] = await db
    .update(balanceTransactions)
    .set({ status: 'available', availableOn })
    .where(and(eq(balanceTransactions.id, id), eq(balanceTransactions.status, 'pending')))
    .returning(BT_COLUMNS);
  return row ? toRow(row) : null;
}

/** Name the payout that paid a transaction out — fills the gap, never repoints. */
export async function attachBalanceTransactionPayout(
  db: DatabaseOrTransaction,
  id: string,
  payoutId: string,
): Promise<void> {
  await db
    .update(balanceTransactions)
    .set({ payoutId })
    .where(and(eq(balanceTransactions.id, id), isNull(balanceTransactions.payoutId)));
}

export interface LedgerLeg {
  readonly balanceType: LedgerBalanceType;
  readonly amount: bigint;
}

/** Thrown when a journal's legs do not sum to zero — a defect, never a provider answer. */
export class UnbalancedJournalError extends Error {
  constructor(sum: bigint) {
    super(`a ledger journal must sum to zero; these legs sum to ${sum.toString()}`);
    this.name = 'UnbalancedJournalError';
  }
}

/**
 * Post ONE journal for a balance transaction. Zero legs are dropped (a
 * zero-net transaction moves no balance); the rest must sum to zero or nothing
 * is written. A journal of this kind already posted for the transaction is not
 * posted again (`ledger_entries_transaction_kind_balance_type_key`), and that
 * is reported as `false`.
 */
export async function postJournal(
  db: DatabaseOrTransaction,
  transaction: Pick<BalanceTransactionRow, 'id' | 'merchantId' | 'connectedAccountId' | 'currency'>,
  kind: LedgerJournalKind,
  legs: readonly LedgerLeg[],
): Promise<boolean> {
  const sum = legs.reduce((total, leg) => total + leg.amount, 0n);
  if (sum !== 0n) throw new UnbalancedJournalError(sum);
  const nonZero = legs.filter((leg) => leg.amount !== 0n);
  if (nonZero.length === 0) return true;
  const journalId = uuidv7();
  const inserted = await db
    .insert(ledgerEntries)
    .values(
      nonZero.map((leg) => ({
        id: uuidv7(),
        journalId,
        kind,
        balanceTransactionId: transaction.id,
        merchantId: transaction.merchantId,
        connectedAccountId: transaction.connectedAccountId,
        currency: transaction.currency,
        balanceType: leg.balanceType,
        amount: leg.amount.toString(),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  if (inserted.length !== 0 && inserted.length !== nonZero.length) {
    // Part of a journal landed beside an earlier one: the set would no longer
    // sum to zero. Refused by rolling the caller's transaction back.
    throw new UnbalancedJournalError(sum);
  }
  return inserted.length === nonZero.length;
}

/** The scope of one mirrored balance: a merchant, and its account (or none, first-party). */
export interface LedgerScope {
  readonly merchantId: string;
  readonly connectedAccountId: string | null;
}

function scopeOf(
  table: typeof ledgerEntries | typeof balanceTransactions,
  scope: LedgerScope,
): SQL {
  const account =
    scope.connectedAccountId === null
      ? isNull(table.connectedAccountId)
      : eq(table.connectedAccountId, scope.connectedAccountId);
  return and(eq(table.merchantId, scope.merchantId), account) as SQL;
}

/** The balance per currency and balance type, from the entries — never stored. */
export async function readLedgerBalance(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
): Promise<readonly { currency: string; balanceType: LedgerBalanceType; amount: string }[]> {
  const rows = await db
    .select({
      currency: ledgerEntries.currency,
      balanceType: ledgerEntries.balanceType,
      amount: sql<string>`sum(${ledgerEntries.amount}::numeric)::text`,
    })
    .from(ledgerEntries)
    .where(and(scopeOf(ledgerEntries, scope), sql`${ledgerEntries.balanceType} <> 'external'`))
    .groupBy(ledgerEntries.currency, ledgerEntries.balanceType)
    .orderBy(ledgerEntries.currency);
  return rows.map((row) => ({
    currency: row.currency,
    balanceType: row.balanceType as LedgerBalanceType,
    amount: row.amount,
  }));
}

export interface ListBalanceTransactionsFilter {
  readonly type?: BalanceTransactionType;
  readonly payoutId?: string;
  readonly sourceId?: string;
  readonly currency?: string;
}

/** One page, newest RECORDED first — the keyset every list walks (`db/keyset.ts`). */
export async function listBalanceTransactions(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
  filter: ListBalanceTransactionsFilter,
  page: KeysetPage,
): Promise<{ data: BalanceTransactionRow[]; hasMore: boolean }> {
  const walk = keyset(balanceTransactions.id, balanceTransactions.createdAt, page);
  const rows = await db
    .select(BT_COLUMNS)
    .from(balanceTransactions)
    .where(
      and(
        scopeOf(balanceTransactions, scope),
        filter.type !== undefined ? eq(balanceTransactions.type, filter.type) : undefined,
        filter.payoutId !== undefined
          ? eq(balanceTransactions.payoutId, filter.payoutId)
          : undefined,
        filter.sourceId !== undefined
          ? eq(balanceTransactions.sourceId, filter.sourceId)
          : undefined,
        filter.currency !== undefined
          ? eq(balanceTransactions.currency, filter.currency)
          : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/** By `txn_…`, scoped to the merchant AND the account it is read through. */
export async function findBalanceTransactionByPublicId(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
  publicId: string,
): Promise<BalanceTransactionRow | null> {
  const [row] = await db
    .select(BT_COLUMNS)
    .from(balanceTransactions)
    .where(and(scopeOf(balanceTransactions, scope), eq(balanceTransactions.publicId, publicId)));
  return row ? toRow(row) : null;
}

/** Totals over EVERY transaction of a payout — the reconciliation report's summary. */
export async function summarizePayoutTransactions(
  db: DatabaseOrTransaction,
  payoutId: string,
): Promise<{ count: number; amount: string; fee: string; net: string }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${balanceTransactions.amount}::numeric), 0)::text`,
      fee: sql<string>`coalesce(sum(${balanceTransactions.fee}::numeric), 0)::text`,
      net: sql<string>`coalesce(sum(${balanceTransactions.net}::numeric), 0)::text`,
    })
    .from(balanceTransactions)
    .where(eq(balanceTransactions.payoutId, payoutId));
  return {
    count: Number(row?.count ?? 0),
    amount: row?.amount ?? '0',
    fee: row?.fee ?? '0',
    net: row?.net ?? '0',
  };
}

/**
 * Journals whose entries do not sum to zero — the reconciliation's proof of the
 * one invariant no CHECK carries. Empty on a healthy ledger.
 */
export async function findUnbalancedJournals(
  db: DatabaseOrTransaction,
  merchantId?: string,
): Promise<readonly { journalId: string; merchantId: string; sum: string }[]> {
  return db
    .select({
      journalId: ledgerEntries.journalId,
      merchantId: sql<string>`min(${ledgerEntries.merchantId})`,
      sum: sql<string>`sum(${ledgerEntries.amount}::numeric)::text`,
    })
    .from(ledgerEntries)
    .where(merchantId !== undefined ? eq(ledgerEntries.merchantId, merchantId) : undefined)
    .groupBy(ledgerEntries.journalId)
    .having(sql`sum(${ledgerEntries.amount}::numeric) <> 0`);
}

/** When the oldest still-`pending` transaction of an account happened — a sync reads from there. */
export async function findOldestPendingTransaction(
  db: DatabaseOrTransaction,
  connectedAccountId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`min(${balanceTransactions.occurredAt})` })
    .from(balanceTransactions)
    .where(
      and(
        eq(balanceTransactions.connectedAccountId, connectedAccountId),
        eq(balanceTransactions.status, 'pending'),
      ),
    );
  return row?.at ? new Date(row.at) : null;
}

/** The informational FairCoin rows of one payment, newest first — the reorg bookkeeping. */
export async function listFaircoinEntriesForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
): Promise<readonly BalanceTransactionRow[]> {
  const rows = await db
    .select(BT_COLUMNS)
    .from(balanceTransactions)
    .where(
      and(
        eq(balanceTransactions.paymentIntentId, paymentIntentId),
        eq(balanceTransactions.status, 'informational'),
      ),
    )
    .orderBy(desc(balanceTransactions.createdAt));
  return rows.map(toRow);
}

/** Every provider row of an account created at or after `since` — the reconciliation window. */
export async function listProviderTransactionsSince(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
  since: Date,
): Promise<readonly BalanceTransactionRow[]> {
  const rows = await db
    .select(BT_COLUMNS)
    .from(balanceTransactions)
    .where(
      and(
        scopeOf(balanceTransactions, scope),
        sql`${balanceTransactions.provider} is not null`,
        gte(balanceTransactions.occurredAt, since),
      ),
    );
  return rows.map(toRow);
}

/**
 * Every balance transaction of the ledger scope that occurred (the wire `created`) in `[start, end)`, OLDEST first, a page at a time — what
 * the `balance_transactions.itemized.1` report reads (`services/reporting/reports.ts`). A keyset
 * walk on the primary key, so a busy interval never holds more than one page
 * beside the CSV being written. Scoped in the predicate, like its list.
 */
export async function* balanceTransactionsForReport(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
  interval: { readonly start: Date; readonly end: Date; readonly currency: string | null },
  pageSize = 1000,
): AsyncGenerator<BalanceTransactionRow> {
  let after: string | null = null;
  for (;;) {
    const rows = await db
      .select(BT_COLUMNS)
      .from(balanceTransactions)
      .where(
        and(
          scopeOf(balanceTransactions, scope),
          gte(balanceTransactions.occurredAt, interval.start),
          lt(balanceTransactions.occurredAt, interval.end),
          interval.currency === null
            ? undefined
            : sql`upper(${balanceTransactions.currency}) = ${interval.currency}`,
          after === null ? undefined : gt(balanceTransactions.id, after),
        ),
      )
      .orderBy(asc(balanceTransactions.id))
      .limit(pageSize);
    yield* rows.map(toRow);
    const last = rows.at(-1);
    if (!last || rows.length < pageSize) return;
    after = last.id;
  }
}
