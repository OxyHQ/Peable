import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { connectedAccounts } from './connectedAccounts';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  BALANCE_TRANSACTION_STATUSES,
  BALANCE_TRANSACTION_TYPES,
  BASE_UNIT_STRING_PATTERN,
  CURRENCY_CODES,
  FEE_PAYMENT_METHOD_TYPES,
  LEDGER_BALANCE_TYPES,
  LEDGER_JOURNAL_KINDS,
  PAYOUT_METHODS,
  PAYOUT_ORIGINS,
  PAYOUT_STATUSES,
  PAYOUT_TYPES,
  PROVIDER_IDS,
  RECONCILIATION_MISMATCH_KINDS,
  SIGNED_BASE_UNIT_STRING_PATTERN,
} from './valueSets';

/**
 * A settlement currency as the provider reports it, upper-cased. Deliberately
 * wider than `CURRENCY_CODES`: an account may settle in a currency Orbit does
 * not price in (`connected_accounts.default_currency` says why), and the mirror
 * must record it rather than refuse the provider's own figure.
 */
const SETTLEMENT_CURRENCY_PATTERN = '^[A-Z]{3,4}$';

/**
 * Orbit's fee for one merchant (ADR 0015 §3): percent in basis points plus a
 * fixed amount, per payment-method type and currency.
 *
 * Operator data — a merchant never writes its own fee. A merchant with no row
 * for a (method, currency) is charged the deployment default
 * (`ORBIT_FEE_PERCENT_BPS` / `ORBIT_FEE_FIXED`); an Oxy first-party merchant is
 * charged nothing whatever this table says (platform charges carry no fee).
 */
export const feeSchedules = pgTable(
  'fee_schedules',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    paymentMethodType: text().notNull(),
    currency: text().notNull(),
    /** 0–10000: 290 is 2.9%. `integer` — a rate is bounded and never a string. */
    percentBps: integer().notNull(),
    /** Base units, added after the percentage. */
    fixedAmount: text().notNull().default('0'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('fee_schedules_merchant_method_currency_key').on(
      table.merchantId,
      table.paymentMethodType,
      table.currency,
    ),
    foreignKey({
      name: 'fee_schedules_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'fee_schedules_payment_method_type_check',
      sql.raw(`payment_method_type in (${inList(FEE_PAYMENT_METHOD_TYPES)})`),
    ),
    check('fee_schedules_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'fee_schedules_percent_bps_check',
      sql`${table.percentBps} >= 0 and ${table.percentBps} <= 10000`,
    ),
    check(
      'fee_schedules_fixed_amount_check',
      sql.raw(`fixed_amount ~ '${BASE_UNIT_STRING_PATTERN}'`),
    ),
  ],
);

/**
 * Orbit's fee on one payment (`fee_…`), as the PROVIDER took it.
 *
 * Written only from the provider's own application-fee object (the event drain
 * re-reads it), never computed here: the instruction is
 * `payment_intents.application_fee_amount`, and the fee actually taken is this
 * row. `amount_refunded` is NOT stored — it is the sum of the refund rows, read
 * in the same statement, like a payment's `amount_refunded`.
 */
export const applicationFees = pgTable(
  'application_fees',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    paymentIntentId: text().notNull(),
    /** The account the fee was taken from — the destination of the charge. */
    connectedAccountId: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('application_fees_public_id_key').on(table.publicId),
    unique('application_fees_provider_object_key').on(table.provider, table.providerObjectId),
    /** ONE fee per payment: a charge carries one `application_fee_amount`. */
    unique('application_fees_payment_intent_id_key').on(table.paymentIntentId),
    unique('application_fees_id_merchant_id_key').on(table.id, table.merchantId),
    foreignKey({
      name: 'application_fees_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'application_fees_payment_intent_id_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    /** The account is THIS merchant's (its own, or one of its sellers). */
    foreignKey({
      name: 'application_fees_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    check('application_fees_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('application_fees_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check(
      'application_fees_currency_check',
      sql.raw(`currency ~ '${SETTLEMENT_CURRENCY_PATTERN}'`),
    ),
  ],
);

/** A refund of an application fee (`fr_…`), as the provider recorded it. */
export const applicationFeeRefunds = pgTable(
  'application_fee_refunds',
  {
    id: generatedId(),
    publicId: text().notNull(),
    applicationFeeId: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull(),
    provider: text().notNull(),
    providerObjectId: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('application_fee_refunds_public_id_key').on(table.publicId),
    unique('application_fee_refunds_provider_object_key').on(
      table.provider,
      table.providerObjectId,
    ),
    index('application_fee_refunds_application_fee_id_idx').on(table.applicationFeeId),
    foreignKey({
      name: 'application_fee_refunds_application_fee_id_fkey',
      columns: [table.applicationFeeId],
      foreignColumns: [applicationFees.id],
    }).onDelete('restrict'),
    check(
      'application_fee_refunds_provider_check',
      sql.raw(`provider in (${inList(PROVIDER_IDS)})`),
    ),
    check(
      'application_fee_refunds_amount_check',
      sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}' and amount <> '0'`),
    ),
  ],
);

/**
 * A payout (`po_…`) of one account — the provider moving its balance to the
 * merchant's bank. MIRRORED: the provider executes every payout (ADR 0015 §4);
 * a `merchant` row is an instruction this API sent, written BEFORE the provider
 * call (`provider_object_id` NULL until it answers, like every money movement
 * here) so a retry resumes under the same idempotency key.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    connectedAccountId: text().notNull(),
    origin: text().notNull(),
    provider: text().notNull(),
    providerObjectId: text(),
    amount: text().notNull(),
    currency: text().notNull(),
    status: text().notNull(),
    method: text().notNull().default('standard'),
    type: text().notNull().default('bank_account'),
    automatic: boolean().notNull(),
    arrivalDate: timestamptz(),
    description: text(),
    statementDescriptor: text(),
    /** The provider's failure code; never its prose. */
    failureCode: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** When the provider created it; `null` for an instruction it has not answered yet. */
    providerCreatedAt: timestamptz(),
    /**
     * When the payout's balance transactions were last read from the provider
     * (`payout=` filter) — the payout reconciliation report is `complete` only
     * once this is set after the payout was `paid`.
     */
    transactionsSyncedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('payouts_public_id_key').on(table.publicId),
    uniqueIndex('payouts_provider_object_key')
      .on(table.provider, table.providerObjectId)
      .where(sql`${table.providerObjectId} is not null`),
    unique('payouts_id_merchant_id_key').on(table.id, table.merchantId),
    index('payouts_connected_account_id_idx').on(table.connectedAccountId),
    foreignKey({
      name: 'payouts_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payouts_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    check('payouts_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('payouts_origin_check', sql.raw(`origin in (${inList(PAYOUT_ORIGINS)})`)),
    check('payouts_status_check', sql.raw(`status in (${inList(PAYOUT_STATUSES)})`)),
    check('payouts_method_check', sql.raw(`method in (${inList(PAYOUT_METHODS)})`)),
    check('payouts_type_check', sql.raw(`type in (${inList(PAYOUT_TYPES)})`)),
    check('payouts_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check('payouts_currency_check', sql.raw(`currency ~ '${SETTLEMENT_CURRENCY_PATTERN}'`)),
    /** A payout the schedule created is the provider's from birth: it has an id. */
    check(
      'payouts_provider_origin_has_object_check',
      sql`${table.origin} <> 'provider' or ${table.providerObjectId} is not null`,
    ),
    check(
      'payouts_automatic_agrees_check',
      sql`${table.automatic} = (${table.origin} = 'provider')`,
    ),
  ],
);

/**
 * One movement of a merchant's mirrored balance (`txn_…`) — the provider's own
 * balance transaction, or a FairCoin payment recorded for information.
 *
 * NEVER INVENTED. A provider row carries the provider's amount, fee and net
 * verbatim; a figure the source did not give is NULL, never zero. Ingestion is
 * idempotent on `ingestion_key` (`<provider>:<provider balance transaction id>`
 * for a provider row, `faircoin:<payment>:<n>` for an informational one), so a
 * re-read of the same provider page posts nothing twice.
 *
 * `source_type` / `source_id` name the ORBIT object that caused it by its public
 * id, when Orbit holds one; there is deliberately no foreign key, because the
 * source is any of six tables and a provider source Orbit never saw (a manual
 * adjustment) is a legitimate NULL.
 */
export const balanceTransactions = pgTable(
  'balance_transactions',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /** The account whose balance moved. NULL for an Oxy first-party merchant's platform charge. */
    connectedAccountId: text(),
    ingestionKey: text().notNull(),
    provider: text(),
    providerObjectId: text(),
    amount: text().notNull(),
    fee: text(),
    net: text(),
    currency: text().notNull(),
    type: text().notNull(),
    reportingCategory: text().notNull(),
    status: text().notNull(),
    availableOn: timestamptz(),
    /** When it happened at its source — the wire's `created`. */
    occurredAt: timestamptz().notNull(),
    description: text(),
    /** The provider's rate, as text so a decimal survives byte for byte. */
    exchangeRate: text(),
    feeDetails: jsonb()
      .$type<{ amount: string; currency: string; type: string }[]>()
      .notNull()
      .default([]),
    sourceType: text(),
    sourceId: text(),
    /** The payment it belongs to, when there is one (FairCoin entries always). */
    paymentIntentId: text(),
    /** The payout that paid it out, once the provider said so. */
    payoutId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('balance_transactions_public_id_key').on(table.publicId),
    unique('balance_transactions_ingestion_key_key').on(table.ingestionKey),
    uniqueIndex('balance_transactions_provider_object_key')
      .on(table.provider, table.providerObjectId)
      .where(sql`${table.providerObjectId} is not null`),
    unique('balance_transactions_id_merchant_id_key').on(table.id, table.merchantId),
    index('balance_transactions_merchant_account_idx').on(
      table.merchantId,
      table.connectedAccountId,
      table.occurredAt,
    ),
    index('balance_transactions_payout_id_idx').on(table.payoutId),
    index('balance_transactions_source_idx').on(table.sourceType, table.sourceId),
    foreignKey({
      name: 'balance_transactions_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'balance_transactions_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'balance_transactions_payment_intent_id_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'balance_transactions_payout_merchant_fkey',
      columns: [table.payoutId, table.merchantId],
      foreignColumns: [payouts.id, payouts.merchantId],
    }).onDelete('restrict'),
    check(
      'balance_transactions_provider_check',
      sql.raw(`provider is null or provider in (${inList(PROVIDER_IDS)})`),
    ),
    check(
      'balance_transactions_type_check',
      sql.raw(`type in (${inList(BALANCE_TRANSACTION_TYPES)})`),
    ),
    check(
      'balance_transactions_status_check',
      sql.raw(`status in (${inList(BALANCE_TRANSACTION_STATUSES)})`),
    ),
    check(
      'balance_transactions_amounts_check',
      sql.raw(
        `amount ~ '${SIGNED_BASE_UNIT_STRING_PATTERN}' and (fee is null or fee ~ '${SIGNED_BASE_UNIT_STRING_PATTERN}') and (net is null or net ~ '${SIGNED_BASE_UNIT_STRING_PATTERN}')`,
      ),
    ),
    /** An unknown fee makes the net unknown too; a known pair agrees with the gross. */
    check(
      'balance_transactions_net_agrees_check',
      sql`(${table.fee} is null) = (${table.net} is null)
          and (${table.fee} is null or ${table.amount}::numeric - ${table.fee}::numeric = ${table.net}::numeric)`,
    ),
    check(
      'balance_transactions_currency_check',
      sql.raw(`currency ~ '${SETTLEMENT_CURRENCY_PATTERN}'`),
    ),
    /** A provider row names its object; an informational row has no provider. */
    check(
      'balance_transactions_provider_fields_agree_check',
      sql`(${table.provider} is null) = (${table.providerObjectId} is null)`,
    ),
    /**
     * Informational ⇔ FairCoin ⇔ no provider (ADR 0015 §5): Orbit never held
     * those coins, so no provider balance can carry them and no payout can draw
     * on them.
     */
    check(
      'balance_transactions_informational_agrees_check',
      sql`(${table.status} = 'informational')
          = (${table.type} in ('faircoin_payment', 'faircoin_payment_reversal'))
          and (${table.status} = 'informational') = (${table.provider} is null)`,
    ),
    check(
      'balance_transactions_source_agrees_check',
      sql`(${table.sourceType} is null) = (${table.sourceId} is null)`,
    ),
  ],
);

/**
 * The double-entry ledger (ADR 0015 §4). Every balance transaction posts one
 * `recognized` journal and, when the provider later makes its funds available,
 * one `released` journal; each journal's entries SUM TO ZERO (a balance account
 * against `external`, or pending against available).
 *
 * The zero sum spans rows, so no CHECK can carry it: it holds at the one writer
 * (`postJournal`, which refuses an unbalanced set before inserting) and the
 * daily reconciliation re-proves it over the table (`unbalanced_journal`).
 *
 * The account is `(merchant, connected account, currency, balance_type)`; the
 * balance is the sum of the `available` / `pending` / `informational` entries.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: generatedId(),
    /** Groups the entries of one journal. Generated by the writer; not a reference. */
    journalId: text().notNull(),
    kind: text().notNull(),
    balanceTransactionId: text().notNull(),
    merchantId: text().notNull(),
    connectedAccountId: text(),
    currency: text().notNull(),
    balanceType: text().notNull(),
    amount: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * ONE journal of each kind per balance transaction, per balance type — what
     * makes a re-ingestion post nothing twice even if two readers race past the
     * transaction row's own key.
     */
    unique('ledger_entries_transaction_kind_balance_type_key').on(
      table.balanceTransactionId,
      table.kind,
      table.balanceType,
    ),
    index('ledger_entries_account_idx').on(
      table.merchantId,
      table.connectedAccountId,
      table.currency,
      table.balanceType,
    ),
    index('ledger_entries_journal_id_idx').on(table.journalId),
    foreignKey({
      name: 'ledger_entries_balance_transaction_merchant_fkey',
      columns: [table.balanceTransactionId, table.merchantId],
      foreignColumns: [balanceTransactions.id, balanceTransactions.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ledger_entries_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    check('ledger_entries_kind_check', sql.raw(`kind in (${inList(LEDGER_JOURNAL_KINDS)})`)),
    check(
      'ledger_entries_balance_type_check',
      sql.raw(`balance_type in (${inList(LEDGER_BALANCE_TYPES)})`),
    ),
    check(
      'ledger_entries_amount_check',
      sql.raw(`amount ~ '${SIGNED_BASE_UNIT_STRING_PATTERN}' and amount <> '0'`),
    ),
    check('ledger_entries_currency_check', sql.raw(`currency ~ '${SETTLEMENT_CURRENCY_PATTERN}'`)),
  ],
);

/**
 * What the daily reconciliation found disagreeing between the provider and the
 * ledger (ADR 0015 §4). RECORDED, never auto-corrected: a mismatch is evidence
 * for an operator, and a job that "fixed" the ledger silently would destroy it.
 * `resolved_at` is set when a later run no longer sees the difference.
 *
 * `subject` is what the mismatch is about — a provider object id or a journal
 * id — and is never serialized (ADR 0016: provider ids stay internal).
 */
export const reconciliationMismatches = pgTable(
  'reconciliation_mismatches',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    connectedAccountId: text(),
    kind: text().notNull(),
    subject: text().notNull(),
    /** The Orbit object concerned (`txn_…`, `po_…`), when Orbit holds one. */
    objectPublicId: text(),
    expected: jsonb().$type<Record<string, unknown>>(),
    actual: jsonb().$type<Record<string, unknown>>(),
    detectedAt: timestamptz().notNull(),
    lastSeenAt: timestamptz().notNull(),
    resolvedAt: timestamptz(),
  },
  (table) => [
    unique('reconciliation_mismatches_public_id_key').on(table.publicId),
    /** One OPEN mismatch per (kind, subject): a repeat run refreshes it rather than duplicating. */
    uniqueIndex('reconciliation_mismatches_open_key')
      .on(table.kind, table.subject)
      .where(sql`${table.resolvedAt} is null`),
    index('reconciliation_mismatches_merchant_idx').on(table.merchantId, table.resolvedAt),
    foreignKey({
      name: 'reconciliation_mismatches_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reconciliation_mismatches_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    check(
      'reconciliation_mismatches_kind_check',
      sql.raw(`kind in (${inList(RECONCILIATION_MISMATCH_KINDS)})`),
    ),
  ],
);
