/**
 * The reports (`REPORT_TYPE_LAYOUTS` in `@peable.to/shared-types` is the public
 * half: names, columns, defaults). Each column here is the ONE place its value
 * is computed, and each report the one place its rows are read, for both ways
 * a report leaves the gateway:
 *
 * - a report RUN (`reportRunWorker.ts`), stored as a `finance_report_run`
 *   file — `buildReport`, into memory under the file's byte ceiling;
 * - a DOWNLOAD (`GET /v1/reporting/report_types/:id/csv`) — `streamReport`,
 *   straight to the socket a page at a time, bounded by a page, not the range.
 *
 * Both start from `openReport`, so the two can never disagree about a column,
 * a row or an empty cell. `reports.test.ts` (and the realdb suite) hold the
 * computations to the layout's column set.
 */
import type { Writable } from 'node:stream';
import {
  type BalanceTransaction,
  type CurrencyCode,
  type Dispute,
  FILE_PURPOSE_POLICIES,
  REPORT_TYPE_LAYOUTS,
  type Refund,
  type ReportTypeId,
} from '@peable.to/shared-types';
import { getDb } from '../../db/postgres';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
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
import { balanceTransactionsForReport, type LedgerScope } from '../../db/money/ledgerRepository';
import { refundsForReport } from '../../db/refunds/refundRepository';
import { disputesForReport } from '../../db/disputes/disputeRepository';
import { toDisputeDTO, toRefundDTO } from '../../lib/serialize';
import { toBalanceTransactionDTO } from '../../lib/serializeMoney';
import { merchantLedger } from '../money/ledgerScope';
import { baseUnitsToDecimal, type CsvCellKind, CsvWriter, csvLine, writeChunk } from './csv';

/** A report that can never be produced as asked: the run fails with this message. */
export class ReportRunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRunRefusedError';
  }
}

/** A report that needs the ledger, asked of a merchant without one. */
export class ReportLedgerMissingError extends ReportRunRefusedError {
  constructor() {
    super('this merchant has no fiat account, so there is no ledger to report on');
    this.name = 'ReportLedgerMissingError';
  }
}

interface Column<Row> {
  readonly kind: CsvCellKind;
  readonly value: (row: Row) => string | null;
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString());
const isoOf = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();
const json = (value: Record<string, string>) => JSON.stringify(value);
const idOf = (value: string | { id: string } | null) =>
  value === null ? null : typeof value === 'string' ? value : value.id;

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
  amount_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.amount, r.currency) },
  amount_received_decimal: {
    kind: 'number',
    value: (r) => baseUnitsToDecimal(r.amountReceived, r.currency),
  },
  amount_refunded_decimal: {
    kind: 'number',
    value: (r) => baseUnitsToDecimal(r.amountRefunded, r.currency),
  },
  connected_account_id: { kind: 'text', value: (r) => r.connectedAccountPublicId },
  metadata: { kind: 'text', value: (r) => json(r.metadata) },
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
  amount_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.amount, r.currency) },
  balance_transaction_id: { kind: 'text', value: (r) => r.balanceTransactionPublicId },
  metadata: { kind: 'text', value: (r) => json(r.metadata) },
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
  net_amount_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.net, r.currency) },
};

const BALANCE_TRANSACTION_COLUMNS: Readonly<Record<string, Column<BalanceTransaction>>> = {
  balance_transaction_id: { kind: 'text', value: (r) => r.id },
  created_utc: { kind: 'text', value: (r) => isoOf(r.created) },
  available_on_utc: { kind: 'text', value: (r) => isoOf(r.available_on) },
  type: { kind: 'text', value: (r) => r.type },
  reporting_category: { kind: 'text', value: (r) => r.reporting_category },
  status: { kind: 'text', value: (r) => r.status },
  currency: { kind: 'text', value: (r) => r.currency },
  amount: { kind: 'number', value: (r) => r.amount },
  // `null` is "not reported" and stays an empty cell — never a zero fee.
  fee: { kind: 'number', value: (r) => r.fee },
  net: { kind: 'number', value: (r) => r.net },
  source_id: { kind: 'text', value: (r) => r.source },
  payout_id: { kind: 'text', value: (r) => r.payout },
  description: { kind: 'text', value: (r) => r.description },
  exchange_rate: {
    kind: 'number',
    value: (r) => (r.exchange_rate === null ? null : String(r.exchange_rate)),
  },
  amount_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.amount, r.currency) },
  fee_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.fee, r.currency) },
  net_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.net, r.currency) },
};

const REFUND_COLUMNS: Readonly<Record<string, Column<Refund>>> = {
  refund_id: { kind: 'text', value: (r) => r.id },
  created_utc: { kind: 'text', value: (r) => isoOf(r.created) },
  payment_intent_id: { kind: 'text', value: (r) => idOf(r.payment_intent) },
  status: { kind: 'text', value: (r) => r.status },
  reason: { kind: 'text', value: (r) => r.reason },
  origin: { kind: 'text', value: (r) => r.origin },
  external_ref: { kind: 'text', value: (r) => r.external_ref },
  failure_code: { kind: 'text', value: (r) => r.failure_code },
  currency: { kind: 'text', value: (r) => r.currency },
  amount: { kind: 'number', value: (r) => r.amount },
  amount_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.amount, r.currency) },
  metadata: { kind: 'text', value: (r) => json(r.metadata) },
};

const DISPUTE_COLUMNS: Readonly<Record<string, Column<Dispute>>> = {
  dispute_id: { kind: 'text', value: (r) => r.id },
  created_utc: { kind: 'text', value: (r) => isoOf(r.created) },
  payment_intent_id: { kind: 'text', value: (r) => idOf(r.payment_intent) },
  charge_id: { kind: 'text', value: (r) => idOf(r.charge) },
  status: { kind: 'text', value: (r) => r.status },
  reason: { kind: 'text', value: (r) => r.reason },
  currency: { kind: 'text', value: (r) => r.currency },
  amount: { kind: 'number', value: (r) => r.amount },
  amount_decimal: { kind: 'number', value: (r) => baseUnitsToDecimal(r.amount, r.currency) },
  is_charge_refundable: { kind: 'text', value: (r) => String(r.is_charge_refundable) },
  evidence_due_by_utc: { kind: 'text', value: (r) => isoOf(r.evidence_details.due_by) },
  evidence_submitted_at_utc: {
    kind: 'text',
    value: (r) => isoOf(r.evidence_details.submitted_at),
  },
  has_evidence: { kind: 'text', value: (r) => String(r.evidence_details.has_evidence) },
  metadata: { kind: 'text', value: (r) => json(r.metadata) },
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

/** `AsyncIterable` over `inner`, each item mapped — a DTO from a repository row. */
async function* mapped<A, B>(inner: AsyncIterable<A>, map: (item: A) => B): AsyncGenerator<B> {
  for await (const item of inner) yield map(item);
}

/** Where one report's rows come from, and the column computations over them. */
interface ReportDefinition<Row> {
  readonly columns: Readonly<Record<string, Column<Row>>>;
  readonly rows: (
    merchant: MerchantRow,
    scope: LedgerScope | null,
    interval: ReportInterval,
  ) => AsyncIterable<Row> | Promise<Iterable<Row>>;
}

// Each definition's row type is its own; the registry holds them side by side.
// biome-ignore lint/suspicious/noExplicitAny: a registry over heterogeneous row types
type AnyDefinition = ReportDefinition<any>;

const ledgerOf = (scope: LedgerScope | null): LedgerScope => {
  if (scope === null) throw new ReportLedgerMissingError();
  return scope;
};

const REPORTS: Readonly<Record<ReportTypeId, AnyDefinition>> = {
  'payments.itemized.1': {
    columns: PAYMENT_COLUMNS,
    rows: (merchant, _scope, interval) => paymentsForReport(getDb(), merchant.id, interval),
  } satisfies ReportDefinition<PaymentReportRow>,
  'balance.summary.1': {
    columns: SUMMARY_COLUMNS,
    rows: async (_merchant, scope, interval) =>
      (await balanceSummaryForReport(getDb(), ledgerOf(scope), interval)).flatMap(summaryLines),
  } satisfies ReportDefinition<SummaryLine>,
  'balance_transactions.itemized.1': {
    columns: BALANCE_TRANSACTION_COLUMNS,
    rows: (_merchant, scope, interval) =>
      mapped(
        balanceTransactionsForReport(getDb(), ledgerOf(scope), interval),
        toBalanceTransactionDTO,
      ),
  } satisfies ReportDefinition<BalanceTransaction>,
  'payouts.itemized.1': {
    columns: PAYOUT_COLUMNS,
    rows: (_merchant, scope, interval) => payoutsForReport(getDb(), ledgerOf(scope), interval),
  } satisfies ReportDefinition<PayoutReportRow>,
  'refunds.itemized.1': {
    columns: REFUND_COLUMNS,
    rows: (merchant, _scope, interval) =>
      mapped(refundsForReport(getDb(), merchant.id, interval), (row) =>
        toRefundDTO(row, row.paymentIntentPublicId),
      ),
  } satisfies ReportDefinition<Refund>,
  'disputes.itemized.1': {
    columns: DISPUTE_COLUMNS,
    rows: (merchant, _scope, interval) =>
      mapped(disputesForReport(getDb(), merchant.id, interval), (row) =>
        toDisputeDTO(row, row.paymentIntentPublicId),
      ),
  } satisfies ReportDefinition<Dispute>,
};

/** The column computations of each report, by name — what the tests pin to the layouts. */
export const REPORT_COLUMN_NAMES: Readonly<Record<ReportTypeId, readonly string[]>> =
  Object.fromEntries(
    Object.entries(REPORTS).map(([id, report]) => [id, Object.keys(report.columns)]),
  ) as unknown as Record<ReportTypeId, readonly string[]>;

/** What one report is asked to cover — a run's parameters, or a download's query. */
export interface ReportRequest {
  readonly reportType: ReportTypeId;
  readonly intervalStart: Date;
  readonly intervalEnd: Date;
  /** `null`: the layout's `default_columns`. */
  readonly columns: readonly string[] | null;
  readonly currency: CurrencyCode | null;
}

/** The columns a report writes, in the layout's order. */
export function columnsOf(
  request: Pick<ReportRequest, 'reportType' | 'columns'>,
): readonly string[] {
  const layout = REPORT_TYPE_LAYOUTS[request.reportType];
  if (request.columns === null) return layout.default_columns;
  const asked = new Set(request.columns);
  return layout.columns.filter((column) => asked.has(column));
}

/** The ledger a ledger report reads, or `null` for a merchant without one. */
export async function ledgerScopeForReport(merchant: MerchantRow): Promise<LedgerScope | null> {
  return (await merchantLedger(merchant, { firstPartyLedger: true }))?.scope ?? null;
}

/** A report ready to be written: its header, its cell kinds, and its rendered values. */
export interface OpenReport {
  readonly header: readonly string[];
  readonly kinds: readonly CsvCellKind[];
  readonly values: AsyncIterable<readonly (string | null)[]>;
}

/**
 * The one entry to a report, for a run and a download alike.
 *
 * @throws {ReportLedgerMissingError} a ledger report for a merchant without an account.
 */
export async function openReport(
  request: ReportRequest,
  merchant: MerchantRow,
): Promise<OpenReport> {
  const report = REPORTS[request.reportType];
  const names = columnsOf(request);
  const columns = names.map((name) => {
    const column = report.columns[name];
    if (!column) throw new Error(`report column ${name} has no computation`);
    return column;
  });
  const scope = REPORT_TYPE_LAYOUTS[request.reportType].ledger
    ? await ledgerScopeForReport(merchant)
    : null;
  if (REPORT_TYPE_LAYOUTS[request.reportType].ledger && scope === null) {
    throw new ReportLedgerMissingError();
  }
  const interval: ReportInterval = {
    start: request.intervalStart,
    end: request.intervalEnd,
    currency: request.currency,
  };
  const rows = report.rows(merchant, scope, interval);
  async function* values(): AsyncGenerator<readonly (string | null)[]> {
    for await (const row of await rows) yield columns.map((column) => column.value(row));
  }
  return { header: names, kinds: columns.map((column) => column.kind), values: values() };
}

/**
 * A run's CSV, in memory under the `finance_report_run` file ceiling.
 *
 * @throws {ReportRunRefusedError} it can never be produced as asked.
 */
export async function buildReport(
  request: ReportRequest,
  merchant: MerchantRow,
): Promise<Uint8Array> {
  const report = await openReport(request, merchant);
  const csv = new CsvWriter(report.kinds, FILE_PURPOSE_POLICIES.finance_report_run.max_bytes);
  csv.push(report.header);
  for await (const values of report.values) {
    if (!csv.push(values)) {
      throw new ReportRunRefusedError(
        'the report is larger than a report file may be; run it over a shorter interval',
      );
    }
  }
  return csv.toBytes();
}

/** Rows rendered per socket write: enough to amortize the write, small enough to stay a page. */
const STREAM_BATCH = 250;

/**
 * Write an opened report to `out`: the header row, then its rows in batches,
 * each written before more are read and waiting on `drain` — so memory is
 * bounded by a batch whatever the interval. Answers `false` when the client
 * went away (the reads stop). A read that fails throws, AFTER bytes went out:
 * the caller destroys the response so the download fails rather than ends.
 */
export async function streamReport(out: Writable, report: OpenReport): Promise<boolean> {
  if (!(await writeChunk(out, csvLine(report.header, [])))) return false;
  let chunk = '';
  let count = 0;
  for await (const values of report.values) {
    chunk += csvLine(values, report.kinds);
    if (++count >= STREAM_BATCH) {
      if (!(await writeChunk(out, chunk))) return false;
      chunk = '';
      count = 0;
    }
  }
  return chunk ? writeChunk(out, chunk) : true;
}

/** `payments.itemized.1-frr_….csv` — a run's file name, printable ASCII (the Files rule). */
export function reportFilename(run: {
  readonly publicId: string;
  readonly reportType: string;
}): string {
  return `${run.reportType}-${run.publicId}.csv`;
}

/** `payments.itemized.1_test_2026-10-01_2026-11-01.csv` — a download's file name. */
export function downloadFilename(request: ReportRequest, livemode: boolean): string {
  const day = (at: Date) => at.toISOString().slice(0, 10);
  return `${request.reportType}_${livemode ? 'live' : 'test'}_${day(request.intervalStart)}_${day(request.intervalEnd)}.csv`;
}
