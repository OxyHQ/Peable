// Connect and money vocabulary (ADR 0012, ADR 0015): the closed value sets of
// accounts, balances, payouts, application fees, transfers and reconciliation.
// Zod-free, like every vocabulary module.

/** Which half of an account a business type opens: the provider's two kinds. */
export const ACCOUNT_BUSINESS_TYPES = ['individual', 'company'] as const;
export type AccountBusinessType = (typeof ACCOUNT_BUSINESS_TYPES)[number];

/** A capability's state as the provider reports it; `null` on the wire means never requested. */
export const ACCOUNT_CAPABILITY_STATUSES = ['active', 'pending', 'inactive'] as const;
export type AccountCapabilityStatus = (typeof ACCOUNT_CAPABILITY_STATUSES)[number];

/** Whose account an `account` is: the merchant's own, or one of its marketplace sellers. */
export const ACCOUNT_TYPES = ['merchant', 'connected'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** What a hosted onboarding link for the merchant's own account is for. */
export const ACCOUNT_LINK_TYPES = ['account_onboarding', 'account_update'] as const;
export type AccountLinkType = (typeof ACCOUNT_LINK_TYPES)[number];

/**
 * Which rails a seller's account was opened for (ADR 0012 D1). One seller is
 * ONE `ca_…`: `card` is the provider account a marketplace settles to by
 * transfer, `faircoin` is the seller's own watch-only key.
 */
export const CONNECTED_ACCOUNT_RAILS = ['card', 'faircoin'] as const;
export type ConnectedAccountRail = (typeof CONNECTED_ACCOUNT_RAILS)[number];

/**
 * Where a seller's FairCoin half stands: `pending` until the seller registers
 * a key, `active` once they did.
 */
export const CONNECTED_ACCOUNT_FAIRCOIN_STATUSES = ['pending', 'active'] as const;
export type ConnectedAccountFaircoinStatus = (typeof CONNECTED_ACCOUNT_FAIRCOIN_STATUSES)[number];

/**
 * The requirement a seller reports in `requirements.currently_due` until its
 * OWN FairCoin receiving key is registered (ADR 0021 D5): a seller without one
 * is not payable — no transfer and no on-behalf payment. Only the seller can
 * clear it, from their own Oxy session (ADR 0012 D3); the platform opens the
 * FairCoin half and sends an onboarding link.
 */
export const FAIRCOIN_KEY_REQUIREMENT = 'faircoin.receiving_key';

export const PAYOUT_INTERVALS = ['manual', 'daily', 'weekly', 'monthly'] as const;
export type PayoutInterval = (typeof PAYOUT_INTERVALS)[number];

export const PAYOUT_WEEKLY_ANCHORS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type PayoutWeeklyAnchor = (typeof PAYOUT_WEEKLY_ANCHORS)[number];

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
export const BALANCE_TRANSACTION_FEE_TYPES = [
  'application_fee',
  'processing_fee',
  'tax',
  'other',
] as const;
export type BalanceTransactionFeeType = (typeof BALANCE_TRANSACTION_FEE_TYPES)[number];

export const PAYOUT_STATUSES = ['pending', 'in_transit', 'paid', 'failed', 'canceled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_METHODS = ['standard', 'instant'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_DESTINATION_TYPES = ['bank_account', 'card'] as const;
export type PayoutDestinationType = (typeof PAYOUT_DESTINATION_TYPES)[number];

/**
 * A payout reconciliation report's state: `complete` once the payout is `paid`
 * and its transactions were read from the provider, `pending` before.
 */
export const PAYOUT_RECONCILIATION_STATUSES = ['complete', 'pending'] as const;
export type PayoutReconciliationStatus = (typeof PAYOUT_RECONCILIATION_STATUSES)[number];

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

/** Where one settlement stands. */
export const TRANSFER_STATUSES = [
  'pending',
  'paid',
  'partially_reversed',
  'reversed',
  'failed',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Where one reversal of a settlement stands. */
export const TRANSFER_REVERSAL_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type TransferReversalStatus = (typeof TRANSFER_REVERSAL_STATUSES)[number];
