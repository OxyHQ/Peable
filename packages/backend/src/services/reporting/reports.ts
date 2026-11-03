/**
 * The three reports (`REPORT_TYPE_LAYOUTS` in `@peable.to/shared-types` is the
 * public half: names, columns, defaults). Each column here is the one place its
 * value is computed, so the CSV and the layout cannot name different columns —
 * `reports.test.ts` holds the two to the same set.
 */
import {
  FILE_PURPOSE_POLICIES,
  REPORT_TYPE_LAYOUTS,
  type ReportTypeId,
} from '@peable.to/shared-types';
import { getDb } from '../../db/postgres';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { ReportRunRow } from '../../db/reporting/reportRunRepository';
import {
  balanceSummaryForReport,
  type BalanceSummaryRow,
  type LedgerSum,
  type PaymentReportRow,
  type PayoutReportRow,
  paymentsForReport,
  payoutsForReport,
  type ReportInterval,
} from '../../db/reporting/reportData';
import type { LedgerScope } from '../../db/money/ledgerRepository';
import { merchantLedger } from '../money/ledgerScope';
import { type CsvCellKind, CsvWriter } from './csv';

/** A report that can never be produced as asked: the run fails with this message. */
export class ReportRunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRunRefusedError';
  }
}

interface Column<Row> {
  readonly kind: CsvCellKind;
  readonly value: (row: Row) => string | null;
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

const PAYMENT_COLUMNS: Readonly<Record<string, Column<PaymentReportRow>>> = {
  payment_intent_id: { kind: 'text', value: (r) => r.publicId },
  created_utc: { kind: 'text', value: (r) => iso(r.createdAt) },
  status: { kind: 'text', value: (r) => r.status },
  rail: { kind: 'text', value: (r) => r.rail },
  currency: { kind: 'text', value: (r) => r.currency },
  amount: { kind: 'number', value: (r) => r.amount },
  amount_received: { kind: 'number', value: (r) => r.amountReceived },
  amount_refunded: { kind: 'number', value: (r) => r.amountRefunded },
  customer_id: { kind: 'text', value: (r) => r.customerPublicId },
  charge_id: { kind: 'text', value: (r) => r.chargePublicId },
  capture_method: { kind: 'text', value: (r) => r.captureMethod },
  description: { kind: 'text', value: (r) => r.description },
  receipt_email: { kind: 'text', value: (r) => r.receiptEmail },
  cancellation_reason: { kind: 'text', value: (r) => r.cancellationReason },
  canceled_at_utc: { kind: 'text', value: (r) => iso(r.canceledAt) },
};

const PAYOUT_COLUMNS: Readonly<Record<string, Column<PayoutReportRow>>> = {
  payout_id: { kind: 'text', value: (r) => r.publicId },
  created_utc: { kind: 'text', value: (r) => iso(r.createdAt) },
  arrival_date_utc: { kind: 'text', value: (r) => iso(r.arrivalDate) },
  status: { kind: 'text', value: (r) => r.status },
  currency: { kind: 'text', value: (r) => r.currency },
  amount: { kind: 'number', value: (r) => r.amount },
  method: { kind: 'text', value: (r) => r.method },
  type: { kind: 'text', value: (r) => r.type },
  automatic: { kind: 'text', value: (r) => String(r.automatic) },
  description: { kind: 'text', value: (r) => r.description },
  statement_descriptor: { kind: 'text', value: (r) => r.statementDescriptor },
  failure_code: { kind: 'text', value: (r) => r.failureCode },
};

/** One line of a balance summary. */
interface SummaryLine {
  readonly category: string;
  readonly description: string;
  readonly currency: string;
  readonly net: string | null;
  readonly count: number;
}

const SUMMARY_COLUMNS: Readonly<Record<string, Column<SummaryLine>>> = {
  category: { kind: 'text', value: (r) => r.category },
  description: { kind: 'text', value: (r) => r.description },
  currency: { kind: 'text', value: (r) => r.currency },
  net_amount: { kind: 'number', value: (r) => r.net },
  transaction_count: { kind: 'number', value: (r) => String(r.count) },
};

const add = (...values: (string | null)[]): string | null =>
  values.some((value) => value === null)
    ? null
    : values.reduce((sum, value) => sum + BigInt(value as string), 0n).toString();
const negate = (value: string | null) => (value === null ? null : (-BigInt(value)).toString());

function summaryLines(row: BalanceSummaryRow): SummaryLine[] {
  const line = (category: string, description: string, sum: LedgerSum): SummaryLine => ({
    category,
    description,
    currency: row.currency,
    net: sum.value,
    count: sum.count,
  });
  const ending = add(row.starting.value, row.activity.value, row.payouts.value);
  return [
    line('starting_balance', 'Balance at the start of the interval', row.starting),
    line('activity_gross', 'Activity before fees', row.activityGross),
    line('activity_fee', 'Fees', { ...row.activityFee, value: negate(row.activityFee.value) }),
    line('activity', 'Net activity', row.activity),
    line('payouts', 'Payouts', row.payouts),
    {
      category: 'ending_balance',
      description: 'Balance at the end of the interval',
      currency: row.currency,
      net: ending,
      count: row.starting.count + row.activity.count + row.payouts.count,
    },
  ];
}

/** The columns a run writes, in the layout's order. */
export function columnsOf(run: Pick<ReportRunRow, 'reportType' | 'columns'>): readonly string[] {
  const layout = REPORT_TYPE_LAYOUTS[run.reportType];
  if (run.columns === null) return layout.default_columns;
  const asked = new Set(run.columns);
  return layout.columns.filter((column) => asked.has(column));
}

/** The column computations of each report, by name — what `reports.test.ts` pins. */
export const REPORT_COLUMN_NAMES: Readonly<Record<ReportTypeId, readonly string[]>> = {
  'payments.itemized.1': Object.keys(PAYMENT_COLUMNS),
  'balance.summary.1': Object.keys(SUMMARY_COLUMNS),
  'payouts.itemized.1': Object.keys(PAYOUT_COLUMNS),
};

async function write<Row>(
  table: Readonly<Record<string, Column<Row>>>,
  names: readonly string[],
  rows: AsyncIterable<Row> | Iterable<Row>,
): Promise<Uint8Array> {
  const columns = names.map((name) => {
    const column = table[name];
    if (!column) throw new Error(`report column ${name} has no computation`);
    return column;
  });
  const csv = new CsvWriter(
    columns.map((column) => column.kind),
    FILE_PURPOSE_POLICIES.finance_report_run.max_bytes,
  );
  csv.push(names);
  for await (const row of rows) {
    if (!csv.push(columns.map((column) => column.value(row)))) {
      throw new ReportRunRefusedError(
        'the report is larger than a report file may be; run it over a shorter interval',
      );
    }
  }
  return csv.toBytes();
}

/** The ledger a ledger report reads, or the refusal a merchant without one gets. */
export async function ledgerScopeForReport(merchant: MerchantRow): Promise<LedgerScope | null> {
  return (await merchantLedger(merchant, { firstPartyLedger: true }))?.scope ?? null;
}

/**
 * Produce a run's CSV.
 *
 * @throws {ReportRunRefusedError} it can never be produced as asked.
 */
export async function buildReport(run: ReportRunRow, merchant: MerchantRow): Promise<Uint8Array> {
  const db = getDb();
  const interval: ReportInterval = {
    start: run.intervalStart,
    end: run.intervalEnd,
    currency: run.currency,
  };
  const names = columnsOf(run);
  switch (run.reportType) {
    case 'payments.itemized.1':
      return write(PAYMENT_COLUMNS, names, paymentsForReport(db, merchant.id, interval));
    case 'payouts.itemized.1':
    case 'balance.summary.1': {
      const scope = await ledgerScopeForReport(merchant);
      if (scope === null) {
        throw new ReportRunRefusedError(
          'this merchant has no fiat account, so there is no ledger to report on',
        );
      }
      if (run.reportType === 'payouts.itemized.1') {
        return write(PAYOUT_COLUMNS, names, payoutsForReport(db, scope, interval));
      }
      const summary = await balanceSummaryForReport(db, scope, interval);
      return write(SUMMARY_COLUMNS, names, summary.flatMap(summaryLines));
    }
  }
}

/** `frr_….csv` — the report's file name, printable ASCII (the Files rule). */
export function reportFilename(run: Pick<ReportRunRow, 'publicId' | 'reportType'>): string {
  return `${run.reportType}-${run.publicId}.csv`;
}
