import type {
  Account,
  AccountRequirements,
  ApplicationFee,
  Balance,
  BalanceTransaction,
  Payout,
  PayoutReconciliationReport,
  Refund,
} from '@peable.to/shared-types';

/**
 * Complete ADR 0015 wire shapes, so every suite builds its money fixtures from
 * the same contract and a field added there is added here once.
 */

const CREATED = 1792108800;

/** Nothing owed: the requirements of a fully onboarded account. */
export function requirementsFixture(
  overrides: Partial<AccountRequirements> = {},
): AccountRequirements {
  return {
    currently_due: [],
    eventually_due: [],
    past_due: [],
    pending_verification: [],
    disabled_reason: null,
    ...overrides,
  };
}

export function accountFixture(overrides: Partial<Account> = {}): Account {
  return {
    id: 'ca_merchant',
    object: 'account',
    livemode: false,
    type: 'merchant',
    country: 'ES',
    default_currency: 'eur',
    business_profile: {
      name: 'Tienda',
      url: null,
      support_email: null,
      support_url: null,
      product_description: null,
      mcc: null,
    },
    capabilities: { card_payments: 'active', transfers: 'active' },
    requirements: requirementsFixture(),
    charges_enabled: true,
    payouts_enabled: true,
    settings: {
      payouts: {
        schedule: { interval: 'manual', delay_days: 7, weekly_anchor: null, monthly_anchor: null },
        statement_descriptor: null,
      },
      payments: { statement_descriptor: 'TIENDA' },
      branding: { primary_color: null, secondary_color: null },
    },
    last_synced_at: CREATED,
    created: CREATED,
    ...overrides,
  };
}

export function balanceFixture(overrides: Partial<Balance> = {}): Balance {
  return {
    object: 'balance',
    livemode: false,
    available: [{ amount: '12500', currency: 'eur' }],
    pending: [{ amount: '-300', currency: 'eur' }],
    informational: [{ amount: '100000000', currency: 'FAIR' }],
    account: 'ca_merchant',
    ...overrides,
  };
}

export function balanceTransactionFixture(
  overrides: Partial<BalanceTransaction> = {},
): BalanceTransaction {
  return {
    id: 'txn_1',
    object: 'balance_transaction',
    livemode: false,
    amount: '2500',
    fee: '105',
    net: '2395',
    currency: 'eur',
    type: 'charge',
    reporting_category: 'charge',
    status: 'available',
    available_on: CREATED + 604800,
    created: CREATED,
    description: null,
    exchange_rate: null,
    faircoin_quote: null,
    fee_details: [{ amount: '105', currency: 'eur', type: 'processing_fee' }],
    source: 'ch_1',
    payout: null,
    account: 'ca_merchant',
    ...overrides,
  };
}

export function payoutFixture(overrides: Partial<Payout> = {}): Payout {
  return {
    id: 'po_1',
    object: 'payout',
    livemode: false,
    account: 'ca_merchant',
    amount: '10000',
    currency: 'eur',
    status: 'pending',
    arrival_date: CREATED + 172800,
    automatic: false,
    method: 'standard',
    type: 'bank_account',
    description: null,
    statement_descriptor: null,
    failure_code: null,
    balance_transaction: null,
    metadata: {},
    created: CREATED,
    ...overrides,
  };
}

export function applicationFeeFixture(overrides: Partial<ApplicationFee> = {}): ApplicationFee {
  return {
    id: 'fee_1',
    object: 'application_fee',
    livemode: false,
    account: 'ca_seller',
    amount: '150',
    amount_refunded: '0',
    currency: 'eur',
    charge: 'ch_1',
    payment_intent: 'pi_1',
    refunded: false,
    refunds: {
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/application_fees/fee_1/refunds',
    },
    created: CREATED,
    ...overrides,
  };
}

export function payoutReconciliationFixture(
  overrides: Partial<PayoutReconciliationReport> = {},
): PayoutReconciliationReport {
  return {
    object: 'list',
    data: [balanceTransactionFixture({ payout: 'po_1' })],
    has_more: false,
    url: '/v1/reports/payout_reconciliation',
    payout: 'po_1',
    status: 'complete',
    currency: 'eur',
    summary: { count: 1, amount: '2500', fee: '105', net: '2395' },
    ...overrides,
  };
}

export function refundFixture(overrides: Partial<Refund> = {}): Refund {
  return {
    id: 're_1',
    object: 'refund',
    livemode: false,
    external_ref: 'refund_1',
    origin: 'merchant',
    payment_intent: 'pi_1',
    amount: '2500',
    currency: 'EUR',
    status: 'succeeded',
    reason: null,
    failure_code: null,
    metadata: {},
    created: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}
