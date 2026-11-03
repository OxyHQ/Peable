/**
 * Stripe's balance, payout, fee and account-settings vocabulary, mapped into
 * Orbit's (ADR 0015). Pure functions over objects Stripe already returned:
 * nothing here calls Stripe, so the mapping is tested without a key.
 *
 * Every figure crosses VERBATIM. A provider amount is a number in Stripe's SDK
 * and a canonical integer string here, and the conversion refuses a value that
 * is not a safe integer rather than rounding it — a ledger that rounds is a
 * ledger that no longer reconciles.
 */
import type Stripe from 'stripe';
import type {
  AccountBusinessProfile,
  AccountSettings,
  BalanceTransactionType,
  PayoutStatus,
} from '@peable.to/shared-types';
import {
  ProviderError,
  type ProviderAccountUpdate,
  type ProviderApplicationFee,
  type ProviderBalanceTransaction,
  type ProviderPayout,
} from '../provider';
import { fromUnix } from '../../../lib/time';

/** A Stripe integer amount as Orbit's canonical string; refuses anything not exact. */
export function fromStripeAmount(value: number, stage: 'balance' | 'payout'): string {
  if (!Number.isSafeInteger(value)) {
    throw new ProviderError({
      provider: 'stripe',
      stage,
      message: `the provider reported a non-integer amount ${String(value)}`,
      retryable: false,
      code: 'amount_not_representable',
    });
  }
  return String(value);
}

/**
 * Stripe's balance-transaction `type` in Orbit's closed set. Disputes are
 * Stripe `adjustment`s whose reporting category says so; the acquirer's own
 * fees are `processing_fee` — the provider's name never reaches the wire.
 */
export function toBalanceTransactionType(
  type: string,
  reportingCategory: string,
): BalanceTransactionType {
  if (reportingCategory === 'dispute') return 'dispute';
  if (reportingCategory === 'dispute_reversal') return 'dispute_reversal';
  switch (type) {
    case 'charge':
    case 'payment':
    case 'adjustment':
    case 'application_fee':
    case 'application_fee_refund':
    case 'payout':
    case 'payout_cancel':
    case 'payout_failure':
    case 'transfer_refund':
      return type;
    case 'refund':
    case 'refund_failure':
      return 'refund';
    case 'payment_refund':
    case 'payment_reversal':
    case 'payment_failure_refund':
      return 'payment_refund';
    case 'transfer':
    case 'transfer_cancel':
    case 'transfer_failure':
      return 'transfer';
    case 'stripe_fee':
    case 'stripe_fx_fee':
    case 'tax_fee':
      return 'processing_fee';
    default:
      return 'other';
  }
}

/** Stripe's reporting categories are generic words; anything else is `other`. */
function toReportingCategory(category: string | undefined): string {
  return category && /^[a-z_]{1,64}$/.test(category) ? category : 'other';
}

function toFeeDetailType(type: string): 'application_fee' | 'processing_fee' | 'tax' | 'other' {
  if (type === 'application_fee') return 'application_fee';
  if (type === 'stripe_fee') return 'processing_fee';
  if (type === 'tax') return 'tax';
  return 'other';
}

/** What kind of object a Stripe id names, by its prefix. */
function sourceKindOf(id: string): ProviderBalanceTransaction['sourceKind'] {
  if (id.startsWith('ch_') || id.startsWith('py_')) return 'charge';
  if (id.startsWith('re_') || id.startsWith('pyr_')) return 'refund';
  if (id.startsWith('po_')) return 'payout';
  if (id.startsWith('fee_')) return 'application_fee';
  if (id.startsWith('fr_')) return 'application_fee_refund';
  if (id.startsWith('tr_')) return 'transfer';
  if (id.startsWith('du_') || id.startsWith('dp_')) return 'dispute';
  return null;
}

/**
 * For the destination account's `payment` (a `py_…`), the platform charge the
 * funds came from: `source.source_transfer.source_transaction`, expanded by
 * the list call. Absent in any other shape, never guessed.
 */
function originatingChargeOf(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const transfer = (source as { source_transfer?: unknown }).source_transfer;
  if (typeof transfer !== 'object' || transfer === null) return null;
  const origin = (transfer as { source_transaction?: unknown }).source_transaction;
  if (typeof origin === 'string') return origin;
  if (typeof origin === 'object' && origin !== null) {
    const id = (origin as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export function toProviderBalanceTransaction(
  txn: Stripe.BalanceTransaction,
): ProviderBalanceTransaction {
  const reportingCategory = toReportingCategory(txn.reporting_category);
  const sourceId =
    typeof txn.source === 'string'
      ? txn.source
      : txn.source && typeof txn.source === 'object' && 'id' in txn.source
        ? String(txn.source.id)
        : null;
  return {
    providerObjectId: txn.id,
    amount: fromStripeAmount(txn.amount, 'balance'),
    fee: fromStripeAmount(txn.fee, 'balance'),
    net: fromStripeAmount(txn.net, 'balance'),
    currency: txn.currency.toUpperCase(),
    type: toBalanceTransactionType(txn.type, reportingCategory),
    reportingCategory,
    status: txn.status === 'available' ? 'available' : 'pending',
    availableOn: txn.available_on ? fromUnix(txn.available_on) : null,
    created: fromUnix(txn.created),
    description: txn.description ?? null,
    exchangeRate: txn.exchange_rate === null ? null : String(txn.exchange_rate),
    feeDetails: txn.fee_details.map((detail) => ({
      amount: fromStripeAmount(detail.amount, 'balance'),
      currency: detail.currency.toUpperCase(),
      type: toFeeDetailType(detail.type),
    })),
    sourceObjectId: sourceId,
    sourceKind: sourceId === null ? null : sourceKindOf(sourceId),
    originatingChargeObjectId: originatingChargeOf(txn.source),
  };
}

function toPayoutStatus(status: string): PayoutStatus {
  switch (status) {
    case 'paid':
    case 'pending':
    case 'in_transit':
    case 'canceled':
    case 'failed':
      return status;
    default:
      return 'pending';
  }
}

export function toProviderPayout(payout: Stripe.Payout): ProviderPayout {
  return {
    providerObjectId: payout.id,
    amount: fromStripeAmount(payout.amount, 'payout'),
    currency: payout.currency.toUpperCase(),
    status: toPayoutStatus(payout.status),
    method: payout.method === 'instant' ? 'instant' : 'standard',
    type: payout.type === 'card' ? 'card' : 'bank_account',
    automatic: payout.automatic,
    arrivalDate: payout.arrival_date ? fromUnix(payout.arrival_date) : null,
    description: payout.description ?? null,
    statementDescriptor: payout.statement_descriptor ?? null,
    // The CODE only: `failure_message` is the provider's prose.
    failureCode: payout.failure_code ?? null,
    created: fromUnix(payout.created),
  };
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return value.id;
  return null;
}

export function toProviderApplicationFee(fee: Stripe.ApplicationFee): ProviderApplicationFee {
  return {
    providerObjectId: fee.id,
    amount: fromStripeAmount(fee.amount, 'balance'),
    currency: fee.currency.toUpperCase(),
    // A destination charge's fee is taken on the destination's `py_…`; the
    // charge Orbit holds is the PLATFORM's, `originating_transaction`.
    chargeObjectId: idOf(fee.originating_transaction) ?? idOf(fee.charge),
    accountObjectId: idOf(fee.account),
    refunds: fee.refunds.data.map((refund) => ({
      providerObjectId: refund.id,
      amount: fromStripeAmount(refund.amount, 'balance'),
      currency: refund.currency.toUpperCase(),
      created: fromUnix(refund.created),
    })),
    created: fromUnix(fee.created),
  };
}

export function toBusinessProfile(account: Stripe.Account): AccountBusinessProfile {
  const profile = account.business_profile;
  return {
    name: profile?.name ?? null,
    url: profile?.url ?? null,
    support_email: profile?.support_email ?? null,
    support_url: profile?.support_url ?? null,
    product_description: profile?.product_description ?? null,
    mcc: profile?.mcc ?? null,
  };
}

const WEEKLY_ANCHORS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

export function toAccountSettings(account: Stripe.Account): AccountSettings {
  const settings = account.settings;
  const schedule = settings?.payouts?.schedule;
  const interval = schedule?.interval;
  return {
    payouts: {
      schedule:
        interval === 'manual' ||
        interval === 'daily' ||
        interval === 'weekly' ||
        interval === 'monthly'
          ? {
              interval,
              delay_days: typeof schedule?.delay_days === 'number' ? schedule.delay_days : null,
              weekly_anchor:
                schedule?.weekly_anchor && WEEKLY_ANCHORS.has(schedule.weekly_anchor)
                  ? (schedule.weekly_anchor as NonNullable<
                      AccountSettings['payouts']['schedule']
                    >['weekly_anchor'])
                  : null,
              monthly_anchor:
                typeof schedule?.monthly_anchor === 'number' ? schedule.monthly_anchor : null,
            }
          : null,
      statement_descriptor: settings?.payouts?.statement_descriptor ?? null,
    },
    payments: { statement_descriptor: settings?.payments?.statement_descriptor ?? null },
    branding: {
      primary_color: settings?.branding?.primary_color ?? null,
      secondary_color: settings?.branding?.secondary_color ?? null,
    },
  };
}

/** Orbit's settings write in Stripe's shape; an omitted field is not sent. */
export function toStripeAccountUpdate(update: ProviderAccountUpdate): Stripe.AccountUpdateParams {
  const params: Stripe.AccountUpdateParams = {};
  if (update.businessProfile) {
    const profile: Stripe.AccountUpdateParams.BusinessProfile = {};
    const source = update.businessProfile;
    if (source.name != null) profile.name = source.name;
    if (source.url != null) profile.url = source.url;
    if (source.support_email != null) profile.support_email = source.support_email;
    if (source.support_url != null) profile.support_url = source.support_url;
    if (source.product_description != null)
      profile.product_description = source.product_description;
    if (source.mcc != null) profile.mcc = source.mcc;
    params.business_profile = profile;
  }
  const settings: Stripe.AccountUpdateParams.Settings = {};
  if (update.payoutSchedule || update.payoutStatementDescriptor !== undefined) {
    settings.payouts = {
      ...(update.payoutSchedule
        ? {
            schedule: {
              interval: update.payoutSchedule.interval,
              ...(update.payoutSchedule.delayDays !== undefined
                ? { delay_days: update.payoutSchedule.delayDays }
                : {}),
              ...(update.payoutSchedule.weeklyAnchor !== undefined
                ? {
                    weekly_anchor: update.payoutSchedule
                      .weeklyAnchor as Stripe.AccountUpdateParams.Settings.Payouts.Schedule.WeeklyAnchor,
                  }
                : {}),
              ...(update.payoutSchedule.monthlyAnchor !== undefined
                ? { monthly_anchor: update.payoutSchedule.monthlyAnchor }
                : {}),
            },
          }
        : {}),
      ...(update.payoutStatementDescriptor !== undefined
        ? { statement_descriptor: update.payoutStatementDescriptor }
        : {}),
    };
  }
  if (update.paymentsStatementDescriptor !== undefined) {
    settings.payments = { statement_descriptor: update.paymentsStatementDescriptor };
  }
  if (update.brandingPrimaryColor !== undefined || update.brandingSecondaryColor !== undefined) {
    settings.branding = {
      ...(update.brandingPrimaryColor !== undefined
        ? { primary_color: update.brandingPrimaryColor }
        : {}),
      ...(update.brandingSecondaryColor !== undefined
        ? { secondary_color: update.brandingSecondaryColor }
        : {}),
    };
  }
  if (Object.keys(settings).length > 0) params.settings = settings;
  return params;
}
