// Balance, balance transactions, payouts and application fees (ADR 0015 §3–§5).
//
// MIRRORS, every one of them. The money is in the merchant's own provider
// account; Orbit's double-entry ledger is fed by the provider's own balance
// transactions and payouts for that account and reconciled against them daily.
// Nothing here is computed by Orbit: a figure the provider has not given is
// `null` with a status, never `0`.
//
// Signed amounts: every `amount` below is a canonical integer STRING in the
// currency's smallest unit that MAY be negative (`"-1500"`) — a refund or a
// payout takes money out of a balance.
import type { CurrencyCode } from './money';
import type { List } from './list';

/** One currency's figure in a balance. */
export interface BalanceAmount {
  /** Signed base units. */
  amount: string;
  currency: CurrencyCode | string;
}

/**
 * `GET /v1/balance` — read from the ledger, per currency.
 *
 * A merchant without a fiat account has NO balance and is told so (404
 * `account_missing`), never shown zeros (ADR 0015 consequences).
 */
export interface Balance {
  object: 'balance';
  livemode: boolean;
  /** Payable now: the provider has made these funds available. */
  available: BalanceAmount[];
  /** Not yet available at the provider. */
  pending: BalanceAmount[];
  /**
   * FairCoin received straight into the merchant's own wallet (ADR 0015 §5).
   * Recorded for the merchant's books only: Orbit never held it, so it is never
   * payable and no payout draws on it.
   */
  informational: BalanceAmount[];
  /** The account (`ca_…`) this balance mirrors; `null` for an Oxy first-party merchant. */
  account: string | null;
}

/** Orbit's vocabulary for what moved — the provider's own types, provider-neutral. */
export const BALANCE_TRANSACTION_TYPES = [
  'charge',
  'payment',
  'refund',
  'payment_refund',
  'adjustment',
  'application_fee',
  'application_fee_refund',
  'payout',
  'payout_cancel',
  'payout_failure',
  'transfer',
  'transfer_refund',
  'dispute',
  'dispute_reversal',
  'processing_fee',
  'faircoin_payment',
  'faircoin_payment_reversal',
  'other',
] as const;
export type BalanceTransactionType = (typeof BALANCE_TRANSACTION_TYPES)[number];

/**
 * - `pending` / `available` — the provider's own status for the funds.
 * - `informational` — a FairCoin payment: recorded, never part of a payable balance.
 */
export const BALANCE_TRANSACTION_STATUSES = ['available', 'pending', 'informational'] as const;
export type BalanceTransactionStatus = (typeof BALANCE_TRANSACTION_STATUSES)[number];

/** One component of a transaction's fee. `processing_fee` is the acquirer's own. */
export interface BalanceTransactionFeeDetail {
  amount: string;
  currency: string;
  type: 'application_fee' | 'processing_fee' | 'tax' | 'other';
}

export interface BalanceTransaction {
  /** `txn_…` */
  id: string;
  object: 'balance_transaction';
  livemode: boolean;
  /** Gross, signed. */
  amount: string;
  /** What was taken, or `null` when the source gave no figure (never `0` for unknown). */
  fee: string | null;
  /** `amount - fee`, as the provider reports it, or `null` with `fee`. */
  net: string | null;
  currency: string;
  type: BalanceTransactionType;
  /** A coarser grouping for reports (`charge`, `refund`, `payout`, `fee`, …). */
  reporting_category: string;
  status: BalanceTransactionStatus;
  /** When the funds became (or become) available; `null` for an informational entry. */
  available_on: number | null;
  /** When it happened at its source. */
  created: number;
  description: string | null;
  exchange_rate: number | null;
  fee_details: BalanceTransactionFeeDetail[];
  /**
   * The Orbit object that caused it (`ch_…`, `re_…`, `po_…`, `fee_…`, `tr_…`,
   * `pi_…`), or `null` when the provider's source is not an object Orbit holds.
   */
  source: string | null;
  /** The payout (`po_…`) that paid this transaction out, once known. */
  payout: string | null;
  /** The account (`ca_…`) whose balance it moved; `null` for a first-party merchant. */
  account: string | null;
}

/** `GET /v1/balance_transactions` filters, beside the list parameters. */
export interface ListBalanceTransactionsParams {
  type?: BalanceTransactionType;
  /** `po_…`: only the transactions that payout paid out. */
  payout?: string;
  /** An Orbit object id the transaction was caused by. */
  source?: string;
  currency?: string;
}

export const PAYOUT_STATUSES = ['pending', 'in_transit', 'paid', 'failed', 'canceled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * A payout (`po_…`) — the provider moving the merchant's balance to the
 * merchant's bank. Executed by the provider, always; Orbit instructs (a manual
 * payout) or mirrors (a scheduled one). The bank account itself stays at the
 * provider and is never on this object.
 */
export interface Payout {
  id: string;
  object: 'payout';
  livemode: boolean;
  /** The account (`ca_…`) paid out. */
  account: string;
  amount: string;
  currency: string;
  status: PayoutStatus;
  /** When the funds are expected in the bank, as the provider estimates. */
  arrival_date: number | null;
  /** `true` when the provider's schedule created it, `false` for `POST /v1/payouts`. */
  automatic: boolean;
  method: 'standard' | 'instant';
  type: 'bank_account' | 'card';
  description: string | null;
  statement_descriptor: string | null;
  /** The provider's failure code when `failed`; never its prose. */
  failure_code: string | null;
  /** The payout's own `txn_…` once ingested. */
  balance_transaction: string | null;
  metadata: Record<string, string>;
  created: number;
}

/** `POST /v1/payouts` — a payout instruction for an account on a manual schedule. */
export interface CreatePayoutParams {
  amount: string;
  currency: CurrencyCode;
  description?: string;
  statement_descriptor?: string;
  method?: 'standard' | 'instant';
  metadata?: Record<string, string>;
}

export interface ListPayoutsParams {
  status?: PayoutStatus;
}

/** A refund of an application fee (`fr_…`). */
export interface FeeRefund {
  id: string;
  object: 'fee_refund';
  amount: string;
  currency: string;
  /** The `fee_…` it refunds. */
  fee: string;
  created: number;
}

/**
 * Orbit's fee on one payment (`fee_…`, ADR 0015 §3), taken by the provider from
 * the merchant's account when the charge succeeded. Created from the provider's
 * own record, never computed after the fact.
 */
export interface ApplicationFee {
  id: string;
  object: 'application_fee';
  livemode: boolean;
  /** The account (`ca_…`) the fee was taken from. */
  account: string;
  amount: string;
  amount_refunded: string;
  currency: string;
  /** The `ch_…` it was taken on, when Orbit holds the charge. */
  charge: string | null;
  /** The `pi_…` it was taken on. */
  payment_intent: string;
  /** Refunded in full. */
  refunded: boolean;
  refunds: List<FeeRefund>;
  created: number;
}

/**
 * `GET /v1/reports/payout_reconciliation?payout=po_…` — the balance
 * transactions one payout paid out, with their totals. A list page with the
 * report's fields beside it.
 */
export interface PayoutReconciliationReport extends List<BalanceTransaction> {
  payout: string;
  /**
   * `complete` once the payout is `paid` and its transactions were read from
   * the provider; `pending` before — the set is not final and the totals may grow.
   */
  status: 'complete' | 'pending';
  currency: string;
  /** Over EVERY transaction of the payout, not just this page. */
  summary: {
    count: number;
    amount: string;
    fee: string;
    net: string;
  };
}

/** What the daily reconciliation found disagreeing with the provider. Never auto-corrected. */
export const RECONCILIATION_MISMATCH_KINDS = [
  'missing_in_ledger',
  'amount_mismatch',
  'status_mismatch',
  'missing_at_provider',
  'payout_mismatch',
  'unbalanced_journal',
] as const;
export type ReconciliationMismatchKind = (typeof RECONCILIATION_MISMATCH_KINDS)[number];

export interface ReconciliationMismatch {
  id: string;
  object: 'reconciliation_mismatch';
  livemode: boolean;
  account: string | null;
  kind: ReconciliationMismatchKind;
  /** The Orbit object concerned (`txn_…`, `po_…`), when Orbit holds one. */
  object_id: string | null;
  /** What the provider says (`expected`) against what the ledger holds (`actual`). */
  expected: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  detected_at: number;
  last_seen_at: number;
  /** Set when a later run no longer sees the difference. */
  resolved_at: number | null;
}
