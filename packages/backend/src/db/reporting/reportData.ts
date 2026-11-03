/**
 * What the reports read (`services/reporting/reports.ts` writes the CSV).
 *
 * Each itemized reader is an async generator over a keyset walk in primary
 * key order, a page at a time, so a report over a busy interval never holds
 * more than one page of rows in memory beside the CSV it is writing. Every
 * read is scoped to the merchant (and, for the ledger, to its account) in the
 * predicate — the same scope its API list reads.
 */
import { and, asc, eq, gt, gte, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { CurrencyCode } from '@peable.to/shared-types';
import { balanceTransactions, paymentIntents, payouts } from '../schema';
import type { LedgerScope } from '../money/ledgerRepository';
import type { DatabaseOrTransaction } from '../postgres';

const PAGE = 1000;

export interface ReportInterval {
  readonly start: Date;
  readonly end: Date;
  readonly currency: CurrencyCode | null;
}

export interface PaymentReportRow {
  readonly id: string;
  readonly publicId: string;
  readonly createdAt: Date;
  readonly status: string;
  readonly rail: string;
  readonly currency: string;
  readonly amount: string;
  readonly amountReceived: string;
  readonly amountRefunded: string;
  readonly customerPublicId: string | null;
  readonly chargePublicId: string | null;
  readonly captureMethod: string;
  readonly description: string | null;
  readonly receiptEmail: string | null;
  readonly cancellationReason: string | null;
  readonly canceledAt: Date | null;
}

/** Every payment intent CREATED in the interval, oldest first. */
export async function* paymentsForReport(
  db: DatabaseOrTransaction,
  merchantId: string,
  interval: ReportInterval,
): AsyncGenerator<PaymentReportRow> {
  let after: string | null = null;
  for (;;) {
    const rows: PaymentReportRow[] = await db
      .select({
        id: paymentIntents.id,
        publicId: paymentIntents.publicId,
        createdAt: paymentIntents.createdAt,
        status: paymentIntents.status,
        rail: paymentIntents.rail,
        currency: paymentIntents.currency,
        amount: paymentIntents.amount,
        amountReceived: paymentIntents.amountReceived,
        amountRefunded: sql<string>`${sql.raw(
          `(select coalesce(sum(r.amount::numeric), 0)::text from refunds r where r.payment_intent_id = "payment_intents"."id" and r.status = 'succeeded')`,
        )}`,
        customerPublicId: sql<string | null>`${sql.raw(
          '(select c.public_id from customers c where c.id = "payment_intents"."customer_id")',
        )}`,
        chargePublicId: sql<string | null>`${sql.raw(
          '(select ch.public_id from charges ch where ch.payment_intent_id = "payment_intents"."id")',
        )}`,
        captureMethod: paymentIntents.captureMethod,
        description: paymentIntents.description,
        receiptEmail: paymentIntents.receiptEmail,
        cancellationReason: paymentIntents.cancellationReason,
        canceledAt: paymentIntents.canceledAt,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.merchantId, merchantId),
          gte(paymentIntents.createdAt, interval.start),
          lt(paymentIntents.createdAt, interval.end),
          interval.currency === null ? undefined : eq(paymentIntents.currency, interval.currency),
          after === null ? undefined : gt(paymentIntents.id, after),
        ),
      )
      .orderBy(asc(paymentIntents.id))
      .limit(PAGE);
    yield* rows;
    const last = rows.at(-1);
    if (!last || rows.length < PAGE) return;
    after = last.id;
  }
}

export interface PayoutReportRow {
  readonly id: string;
  readonly publicId: string;
  readonly createdAt: Date;
  readonly arrivalDate: Date | null;
  readonly status: string;
  readonly currency: string;
  readonly amount: string;
  readonly method: string;
  readonly type: string;
  readonly automatic: boolean;
  readonly description: string | null;
  readonly statementDescriptor: string | null;
  readonly failureCode: string | null;
}

function accountOf(
  column: typeof payouts.connectedAccountId | typeof balanceTransactions.connectedAccountId,
  scope: LedgerScope,
): SQL {
  return scope.connectedAccountId === null
    ? isNull(column)
    : (eq(column, scope.connectedAccountId) as SQL);
}

/** Every payout of the ledger scope CREATED in the interval, oldest first. */
export async function* payoutsForReport(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
  interval: ReportInterval,
): AsyncGenerator<PayoutReportRow> {
  let after: string | null = null;
  for (;;) {
    const rows: PayoutReportRow[] = await db
      .select({
        id: payouts.id,
        publicId: payouts.publicId,
        createdAt: payouts.createdAt,
        arrivalDate: payouts.arrivalDate,
        status: payouts.status,
        currency: payouts.currency,
        amount: payouts.amount,
        method: payouts.method,
        type: payouts.type,
        automatic: payouts.automatic,
        description: payouts.description,
        statementDescriptor: payouts.statementDescriptor,
        failureCode: payouts.failureCode,
      })
      .from(payouts)
      .where(
        and(
          eq(payouts.merchantId, scope.merchantId),
          accountOf(payouts.connectedAccountId, scope),
          gte(payouts.createdAt, interval.start),
          lt(payouts.createdAt, interval.end),
          interval.currency === null ? undefined : eq(payouts.currency, interval.currency),
          after === null ? undefined : gt(payouts.id, after),
        ),
      )
      .orderBy(asc(payouts.id))
      .limit(PAGE);
    yield* rows;
    const last = rows.at(-1);
    if (!last || rows.length < PAGE) return;
    after = last.id;
  }
}

/** A sum over balance transactions, `null` when any of them lacks the figure. */
export interface LedgerSum {
  readonly value: string | null;
  readonly count: number;
}

export interface BalanceSummaryRow {
  readonly currency: string;
  readonly starting: LedgerSum;
  readonly activityGross: LedgerSum;
  /** Fees as the provider reports them (positive = taken). */
  readonly activityFee: LedgerSum;
  readonly activity: LedgerSum;
  readonly payouts: LedgerSum;
}

/** The balance transaction types that move money to (or back from) the bank. */
const PAYOUT_TYPES = ['payout', 'payout_cancel', 'payout_failure'];

/**
 * Per currency: the ledger's net before `start`, and the activity and payouts
 * inside `[start, end)`, by `occurred_at`. FairCoin rows (`informational`) are
 * not part of a payable balance and are left out, as `GET /v1/balance` leaves
 * them out of `available`.
 *
 * A NET is unknown while the provider has not reported a transaction's fee
 * (`fee`/`net` NULL together, CONVENTIONS.md §Orbit money); a sum over such a
 * row is `null`, never a guess.
 */
export async function balanceSummaryForReport(
  db: DatabaseOrTransaction,
  scope: LedgerScope,
  interval: ReportInterval,
): Promise<BalanceSummaryRow[]> {
  const t = balanceTransactions;
  // A raw template binds its value as-is, and the driver takes no Date there:
  // the instant goes as ISO text with its type stated.
  const start = sql`${interval.start.toISOString()}::timestamptz`;
  const before = sql`${t.occurredAt} < ${start}`;
  const inside = sql`${t.occurredAt} >= ${start}`;
  const isPayout = sql`${t.type} in (${sql.join(
    PAYOUT_TYPES.map((type) => sql`${type}`),
    sql`, `,
  )})`;
  const sumOf = (column: AnyPgColumn, where: SQL) =>
    sql<
      string | null
    >`case when bool_or((${where}) and ${column} is null) then null else coalesce(sum(${column}::numeric) filter (where ${where}), 0)::text end`;
  const countOf = (where: SQL) => sql<number>`(count(*) filter (where ${where}))::int`;
  const activity = sql`(${inside}) and not (${isPayout})`;
  const payout = sql`(${inside}) and (${isPayout})`;
  const rows = await db
    .select({
      currency: t.currency,
      starting: sumOf(t.net, before),
      startingCount: countOf(before),
      activityGross: sumOf(t.amount, activity),
      activityFee: sumOf(t.fee, activity),
      activity: sumOf(t.net, activity),
      activityCount: countOf(activity),
      payouts: sumOf(t.net, payout),
      payoutCount: countOf(payout),
    })
    .from(t)
    .where(
      and(
        eq(t.merchantId, scope.merchantId),
        accountOf(t.connectedAccountId, scope),
        ne(t.status, 'informational'),
        lt(t.occurredAt, interval.end),
        interval.currency === null ? undefined : eq(t.currency, interval.currency),
      ),
    )
    .groupBy(t.currency)
    .orderBy(t.currency);
  return rows.map((row) => ({
    currency: row.currency,
    starting: { value: row.starting, count: Number(row.startingCount) },
    activityGross: { value: row.activityGross, count: Number(row.activityCount) },
    activityFee: { value: row.activityFee, count: Number(row.activityCount) },
    activity: { value: row.activity, count: Number(row.activityCount) },
    payouts: { value: row.payouts, count: Number(row.payoutCount) },
  }));
}

/** The earliest instant each report could have data from — `data_available_start`. */
export async function earliestReportData(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<{ payments: Date | null; ledger: Date | null; payouts: Date | null }> {
  const [row] = await db
    .select({
      payments: sql<
        string | null
      >`(select min(p.created_at) from payment_intents p where p.merchant_id = ${merchantId}::text)`,
      ledger: sql<
        string | null
      >`(select min(b.occurred_at) from balance_transactions b where b.merchant_id = ${merchantId}::text)`,
      payouts: sql<
        string | null
      >`(select min(o.created_at) from payouts o where o.merchant_id = ${merchantId}::text)`,
    })
    .from(sql`(select 1) as one`);
  const at = (value: string | null | undefined) =>
    value === null || value === undefined ? null : new Date(value);
  return { payments: at(row?.payments), ledger: at(row?.ledger), payouts: at(row?.payouts) };
}
