// Reporting (Stripe's `reporting.report_type` / `reporting.report_run`): a
// merchant asks for a report over an interval, Peable computes it in the
// background and stores the CSV as a `file_…` of purpose `finance_report_run`
// — or downloads the same CSV at once, streamed
// (`GET /v1/reporting/report_types/:id/csv`). Both are ONE report: the same
// layout, the same columns, the same computation (`services/reporting/reports.ts`).
//
// Cell conventions, the same in every report and both ways of getting it:
//
// - Amounts are base-unit integer strings, as on the API (signed where a
//   balance moves down); each has a `<name>_decimal` column with the same value
//   in whole units by the currency's own decimals (`19.99`; JPY `1999`; FAIR
//   eight places), computed from the string exactly.
// - Instants are ISO 8601 UTC (`*_utc`).
// - An unknown is an empty cell, never `0` (a fee the provider has not
//   reported, a payout not yet arrived).
// - A TEXT cell that would start a spreadsheet formula (`=`, `+`, `-`, `@`, tab,
//   CR) is prefixed with `'`; a number cell never is.
// - RFC 4180: `,`, `\r\n`, quoted when needed. UTF-8.
//
// Import-free at runtime, so a browser reads it from the
// `@peable.to/shared-types/reporting` subpath without the root barrel.
import type { CurrencyCode } from './money';
import type { FileObject } from './file';

/**
 * Every report Peable produces, by Stripe's versioned id: the trailing `.1` is
 * the column layout's version, so a layout can change under a new id without
 * changing a report a merchant already parses.
 */
export const REPORT_TYPE_IDS = [
  'payments.itemized.1',
  'balance.summary.1',
  'balance_transactions.itemized.1',
  'payouts.itemized.1',
  'refunds.itemized.1',
  'disputes.itemized.1',
] as const;
export type ReportTypeId = (typeof REPORT_TYPE_IDS)[number];

/**
 * The layout of each report: its name, every column it can carry and the ones
 * it carries when `parameters.columns` is absent. Fixed per version.
 *
 * - `payments.itemized.1` — one row per payment intent CREATED in the
 *   interval. Amounts are base-unit strings, as on the API.
 * - `balance.summary.1` — per currency, the balance at `interval_start`, the
 *   activity and payouts inside the interval, and the balance at
 *   `interval_end`, from the ledger (ADR 0015). A figure built on a transaction
 *   whose fee the provider has not reported is empty, never `0`.
 * - `balance_transactions.itemized.1` — one row per balance transaction that
 *   OCCURRED in the interval (its wire `created`), payouts included, from the
 *   ledger; an unreported fee or net is empty.
 * - `payouts.itemized.1` — one row per payout created in the interval.
 * - `refunds.itemized.1` — one row per refund created in the interval.
 * - `disputes.itemized.1` — one row per dispute opened in the interval.
 *
 * Itemized rows are written oldest first. A column is only ever APPENDED to a
 * version's `columns` (the `_decimal` columns were); `default_columns` of a
 * version never change.
 */
export const REPORT_TYPE_LAYOUTS: Readonly<
  Record<
    ReportTypeId,
    {
      readonly name: string;
      readonly columns: readonly string[];
      readonly default_columns: readonly string[];
      /** Whether the report reads the ledger, and so needs the merchant's account. */
      readonly ledger: boolean;
    }
  >
> = Object.freeze({
  'payments.itemized.1': {
    name: 'Itemized payments',
    columns: [
      'payment_intent_id',
      'created_utc',
      'status',
      'rail',
      'currency',
      'amount',
      'amount_received',
      'amount_refunded',
      'customer_id',
      'charge_id',
      'capture_method',
      'description',
      'receipt_email',
      'cancellation_reason',
      'canceled_at_utc',
      'amount_decimal',
      'amount_received_decimal',
      'amount_refunded_decimal',
      'connected_account_id',
      'metadata',
    ],
    default_columns: [
      'payment_intent_id',
      'created_utc',
      'status',
      'currency',
      'amount',
      'amount_received',
      'amount_refunded',
      'customer_id',
    ],
    ledger: false,
  },
  'balance.summary.1': {
    name: 'Balance summary',
    columns: [
      'category',
      'description',
      'currency',
      'net_amount',
      'transaction_count',
      'net_amount_decimal',
    ],
    default_columns: ['category', 'description', 'currency', 'net_amount'],
    ledger: true,
  },
  'balance_transactions.itemized.1': {
    name: 'Itemized balance transactions',
    columns: [
      'balance_transaction_id',
      'created_utc',
      'available_on_utc',
      'type',
      'reporting_category',
      'status',
      'currency',
      'amount',
      'fee',
      'net',
      'source_id',
      'payout_id',
      'description',
      'exchange_rate',
      'amount_decimal',
      'fee_decimal',
      'net_decimal',
    ],
    default_columns: [
      'balance_transaction_id',
      'created_utc',
      'available_on_utc',
      'type',
      'status',
      'currency',
      'amount',
      'fee',
      'net',
      'amount_decimal',
      'fee_decimal',
      'net_decimal',
      'source_id',
      'payout_id',
    ],
    ledger: true,
  },
  'payouts.itemized.1': {
    name: 'Itemized payouts',
    columns: [
      'payout_id',
      'created_utc',
      'arrival_date_utc',
      'status',
      'currency',
      'amount',
      'method',
      'type',
      'automatic',
      'description',
      'statement_descriptor',
      'failure_code',
      'amount_decimal',
      'balance_transaction_id',
      'metadata',
    ],
    default_columns: [
      'payout_id',
      'created_utc',
      'arrival_date_utc',
      'status',
      'currency',
      'amount',
      'automatic',
    ],
    ledger: true,
  },
  'refunds.itemized.1': {
    name: 'Itemized refunds',
    columns: [
      'refund_id',
      'created_utc',
      'payment_intent_id',
      'status',
      'reason',
      'origin',
      'external_ref',
      'failure_code',
      'currency',
      'amount',
      'amount_decimal',
      'metadata',
    ],
    default_columns: [
      'refund_id',
      'created_utc',
      'payment_intent_id',
      'status',
      'reason',
      'currency',
      'amount',
      'amount_decimal',
    ],
    ledger: false,
  },
  'disputes.itemized.1': {
    name: 'Itemized disputes',
    columns: [
      'dispute_id',
      'created_utc',
      'payment_intent_id',
      'charge_id',
      'status',
      'reason',
      'currency',
      'amount',
      'amount_decimal',
      'is_charge_refundable',
      'evidence_due_by_utc',
      'evidence_submitted_at_utc',
      'has_evidence',
      'metadata',
    ],
    default_columns: [
      'dispute_id',
      'created_utc',
      'payment_intent_id',
      'status',
      'reason',
      'currency',
      'amount',
      'amount_decimal',
      'evidence_due_by_utc',
    ],
    ledger: false,
  },
});

/** `reporting.report_type` — what can be run, and over which interval data exists. */
export interface ReportType {
  /** `payments.itemized.1`, … */
  id: ReportTypeId;
  object: 'reporting.report_type';
  livemode: boolean;
  name: string;
  /** The column layout's version — the trailing number of the id. */
  version: number;
  /** Every column `parameters.columns` may name, in the order they are written. */
  columns: string[];
  default_columns: string[];
  /** The earliest `interval_start` with data (Unix seconds). */
  data_available_start: number;
  /** The latest `interval_end` a run may ask for: now — the data is live. */
  data_available_end: number;
  /** When the layout last changed. */
  updated: number;
}

export const REPORT_RUN_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

/** What a run was asked to cover. */
export interface ReportRunParameters {
  /** Inclusive, Unix seconds. */
  interval_start: number;
  /** Exclusive, Unix seconds. */
  interval_end: number;
  /** The columns, in the layout's order; the report type's `default_columns` when absent. */
  columns?: string[];
  /** Only this currency. */
  currency?: CurrencyCode;
}

/** `reporting.report_run` (`frr_…`). */
export interface ReportRun {
  id: string;
  object: 'reporting.report_run';
  livemode: boolean;
  created: number;
  report_type: ReportTypeId;
  parameters: ReportRunParameters;
  status: ReportRunStatus;
  /** Why a `failed` run failed; `null` otherwise. */
  error: string | null;
  /** The CSV once `succeeded` — a `file_…` of purpose `finance_report_run`. */
  result: FileObject | null;
  succeeded_at: number | null;
}

/** `POST /v1/reporting/report_runs`. */
export interface CreateReportRunParams {
  report_type: ReportTypeId;
  parameters: ReportRunParameters;
}

/** `GET /v1/reporting/report_runs`. */
export interface ListReportRunsParams {
  report_type?: ReportTypeId;
}
