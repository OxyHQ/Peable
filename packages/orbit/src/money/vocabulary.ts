import type {
  AccountCapabilityStatus,
  AccountPayoutSchedule,
  BalanceTransactionStatus,
  BalanceTransactionType,
  PayoutInterval,
  PayoutStatus,
  PayoutWeeklyAnchor,
  ReconciliationMismatchKind,
} from '@peable.to/shared-types';
import { t } from '../i18n';
import type { StatusTone } from '../payments/status';

/**
 * The money vocabularies of ADR 0015, restated from `shared-types` (whose root
 * barrel a browser bundle must not load, see `format/money.ts`) and pinned to
 * the originals by `vocabulary.test.ts`.
 */

export const ORBIT_BALANCE_TRANSACTION_TYPES: readonly BalanceTransactionType[] = [
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
];

export const ORBIT_BALANCE_TRANSACTION_STATUSES: readonly BalanceTransactionStatus[] = [
  'available',
  'pending',
  'informational',
];

export const ORBIT_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'pending',
  'in_transit',
  'paid',
  'failed',
  'canceled',
];

export const ORBIT_PAYOUT_INTERVALS: readonly PayoutInterval[] = [
  'manual',
  'daily',
  'weekly',
  'monthly',
];

export const ORBIT_WEEKLY_ANCHORS: readonly PayoutWeeklyAnchor[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export const ORBIT_RECONCILIATION_MISMATCH_KINDS: readonly ReconciliationMismatchKind[] = [
  'missing_in_ledger',
  'amount_mismatch',
  'status_mismatch',
  'missing_at_provider',
  'payout_mismatch',
  'unbalanced_journal',
];

/** A label from `prefix.value`, or the raw value for one the catalog does not know. */
function labelOf(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

export const balanceTransactionTypeLabel = (type: string) => labelOf('txn.type', type);
export const balanceTransactionStatusLabel = (status: string) => labelOf('txn.status', status);
export const payoutStatusLabel = (status: string) => labelOf('payout.status', status);
export const payoutIntervalLabel = (interval: string) => labelOf('payout.interval', interval);
export const weekdayLabel = (day: string) => labelOf('weekday', day);
export const mismatchKindLabel = (kind: string) => labelOf('mismatch.kind', kind);

const TXN_STATUS_TONES: Record<BalanceTransactionStatus, StatusTone> = {
  available: 'success',
  pending: 'info',
  informational: 'neutral',
};

export function balanceTransactionStatusTone(status: BalanceTransactionStatus): StatusTone {
  return TXN_STATUS_TONES[status] ?? 'neutral';
}

const PAYOUT_TONES: Record<PayoutStatus, StatusTone> = {
  pending: 'neutral',
  in_transit: 'info',
  paid: 'success',
  failed: 'danger',
  canceled: 'warning',
};

export function payoutStatusTone(status: PayoutStatus): StatusTone {
  return PAYOUT_TONES[status] ?? 'neutral';
}

/** Only a `pending` payout can be canceled, and only while the provider still allows it. */
export function canCancelPayout(status: PayoutStatus): boolean {
  return status === 'pending';
}

/** A schedule in one line: `Weekly, every Friday · funds payable after 7 day(s)`. */
export function scheduleSummary(schedule: AccountPayoutSchedule | null): string {
  if (schedule === null) return t('schedule.notReported');
  let summary: string;
  if (schedule.interval === 'weekly' && schedule.weekly_anchor) {
    summary = t('schedule.summary.weekly', { day: weekdayLabel(schedule.weekly_anchor) });
  } else if (schedule.interval === 'monthly' && schedule.monthly_anchor !== null) {
    summary = t('schedule.summary.monthly', { day: schedule.monthly_anchor });
  } else {
    summary = labelOf('schedule.summary', schedule.interval);
  }
  return schedule.delay_days === null
    ? summary
    : t('schedule.summary.delay', { summary, days: schedule.delay_days });
}

/** `null` is "never requested", which is not the same as `inactive`. */
export function capabilityLabel(status: AccountCapabilityStatus | null): string {
  return status === null ? t('capability.none') : labelOf('capability', status);
}

const CAPABILITY_TONES: Record<AccountCapabilityStatus, StatusTone> = {
  active: 'success',
  pending: 'warning',
  inactive: 'danger',
};

export function capabilityTone(status: AccountCapabilityStatus | null): StatusTone {
  return status === null ? 'neutral' : (CAPABILITY_TONES[status] ?? 'neutral');
}
