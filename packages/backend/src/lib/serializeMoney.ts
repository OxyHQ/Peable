/**
 * Orbit's money objects on the wire (ADR 0015). Every id is the PUBLIC one;
 * the provider's own ids (`txn_…`/`po_…`/`fee_…` at the acquirer, `acct_…`)
 * never cross — they are bindings (ADR 0016 D2).
 */
import type {
  ApplicationFee,
  BalanceTransaction,
  BalanceTransactionFeeDetail,
  FeeRefund,
  Payout,
  ReconciliationMismatch,
} from '@peable.to/shared-types';
import type { ApplicationFeeRow, FeeRefundRow } from '../db/money/applicationFeeRepository';
import type { BalanceTransactionRow } from '../db/money/ledgerRepository';
import type { PayoutRow } from '../db/money/payoutRepository';
import type { ReconciliationMismatchRow } from '../db/money/reconciliationRepository';
import { toUnix, toUnixOrNull } from './time';

export function toBalanceTransactionDTO(row: BalanceTransactionRow): BalanceTransaction {
  return {
    id: row.publicId,
    object: 'balance_transaction',
    livemode: row.livemode,
    amount: row.amount,
    fee: row.fee,
    net: row.net,
    currency: row.currency,
    type: row.type,
    reporting_category: row.reportingCategory,
    status: row.status,
    available_on: toUnixOrNull(row.availableOn),
    created: toUnix(row.occurredAt),
    description: row.description,
    exchange_rate: row.exchangeRate === null ? null : Number(row.exchangeRate),
    fee_details: row.feeDetails.map((detail) => ({
      amount: detail.amount,
      currency: detail.currency,
      type: detail.type as BalanceTransactionFeeDetail['type'],
    })),
    source: row.sourceId,
    payout: row.payoutPublicId,
    account: row.connectedAccountPublicId,
  };
}

export function toPayoutDTO(row: PayoutRow): Payout {
  return {
    id: row.publicId,
    object: 'payout',
    livemode: row.livemode,
    account: row.connectedAccountPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    arrival_date: toUnixOrNull(row.arrivalDate),
    automatic: row.automatic,
    method: row.method,
    type: row.type,
    description: row.description,
    statement_descriptor: row.statementDescriptor,
    failure_code: row.failureCode,
    balance_transaction: row.balanceTransactionPublicId,
    metadata: row.metadata,
    created: toUnix(row.providerCreatedAt ?? row.createdAt),
  };
}

export function toFeeRefundDTO(row: FeeRefundRow): FeeRefund {
  return {
    id: row.publicId,
    object: 'fee_refund',
    amount: row.amount,
    currency: row.currency,
    fee: row.applicationFeePublicId,
    created: toUnix(row.createdAt),
  };
}

export function toApplicationFeeDTO(
  row: ApplicationFeeRow,
  refunds: readonly FeeRefundRow[],
): ApplicationFee {
  return {
    id: row.publicId,
    object: 'application_fee',
    livemode: row.livemode,
    account: row.connectedAccountPublicId,
    amount: row.amount,
    amount_refunded: row.amountRefunded,
    currency: row.currency,
    charge: row.chargePublicId,
    payment_intent: row.paymentIntentPublicId,
    refunded: BigInt(row.amountRefunded) >= BigInt(row.amount),
    refunds: {
      object: 'list',
      data: refunds.map(toFeeRefundDTO),
      has_more: false,
      url: `/v1/application_fees/${row.publicId}/refunds`,
    },
    created: toUnix(row.createdAt),
  };
}

export function toReconciliationMismatchDTO(
  row: ReconciliationMismatchRow,
): ReconciliationMismatch {
  return {
    id: row.publicId,
    object: 'reconciliation_mismatch',
    livemode: row.livemode,
    account: row.connectedAccountPublicId,
    kind: row.kind,
    object_id: row.objectPublicId,
    expected: row.expected,
    actual: row.actual,
    detected_at: toUnix(row.detectedAt),
    last_seen_at: toUnix(row.lastSeenAt),
    resolved_at: toUnixOrNull(row.resolvedAt),
  };
}
