import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type PgTableExtraConfigValue,
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
import {
  BILLING_SETTINGS_LIMITS,
  type BillingPortalFeatures,
  type BillingPortalConfiguration,
  type InvoiceTaxAmount,
} from '@peable.to/shared-types';
import { prices, products, coupons, promotionCodes } from './catalog';
import { customers, paymentMethods } from './customers';
import { merchants } from './merchants';
import { testClocks } from './testClocks';
import { billingMeters } from './meters';
import { paymentIntents } from './payments';
import { refunds } from './refunds';
import {
  AUTOMATIC_TAX_STATUSES,
  BASE_UNIT_STRING_PATTERN,
  COLLECTION_METHODS,
  CREDIT_NOTE_LINE_TYPES,
  CREDIT_NOTE_REASONS,
  CREDIT_NOTE_STATUSES,
  CREDIT_NOTE_TYPES,
  CURRENCY_CODES,
  CUSTOMER_BALANCE_TRANSACTION_TYPES,
  DUNNING_FINAL_ACTIONS,
  DUNNING_INVOICE_ACTIONS,
  INVOICE_BILLING_REASONS,
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  PAUSE_COLLECTION_BEHAVIORS,
  SIGNED_BASE_UNIT_STRING_PATTERN,
  SUBSCRIPTION_CANCELLATION_REASONS,
  SUBSCRIPTION_STATUSES,
  TRIAL_END_BEHAVIORS,
} from './valueSets';

/**
 * Orbit's native billing engine (ADR 0018): subscriptions, invoices, credit
 * notes, customer balances, test clocks, dunning settings, meters,
 * entitlements and the customer portal — Peable rows with Peable ids and NO
 * provider binding. A provider only ever sees the PaymentIntent an invoice is
 * collected with (ADR 0016).
 *
 * Decisions a reader would otherwise undo are in `CONVENTIONS.md` §Billing
 * engine.
 */

const emptyMetadata = sql`'{}'::jsonb`;
const amountCheck = (column: string) => `${column} ~ '${BASE_UNIT_STRING_PATTERN}'`;
const signedCheck = (column: string) => `${column} ~ '${SIGNED_BASE_UNIT_STRING_PATTERN}'`;

/**
 * One merchant's billing settings AND its invoice counter. The counter lives
 * here so the finalize statement that takes a number is the derivation-index
 * pattern: one `INSERT … ON CONFLICT DO UPDATE … RETURNING next - 1` inside
 * the finalize's own transaction — a rollback gives the number back, so the
 * sequence is gapless per merchant (and so per mode, ADR 0017).
 */
export const billingSettings = pgTable(
  'billing_settings',
  {
    merchantId: text()
      .primaryKey()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    invoicePrefix: text().notNull(),
    nextInvoiceNumber: integer().notNull().default(1),
    defaultDaysUntilDue: integer().notNull().default(30),
    retryScheduleDays: integer().array().notNull().default(sql`'{1,3,5,7}'::integer[]`),
    finalAction: text().notNull().default('cancel'),
    invoiceAction: text().notNull().default('mark_uncollectible'),
    emailInvoiceFinalized: boolean().notNull().default(true),
    emailPaymentFailed: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check(
      'billing_settings_invoice_prefix_check',
      sql.raw(`invoice_prefix ~ '${BILLING_SETTINGS_LIMITS.invoicePrefixPattern}'`),
    ),
    check('billing_settings_next_invoice_number_check', sql.raw('next_invoice_number >= 1')),
    check(
      'billing_settings_days_until_due_check',
      sql.raw(`default_days_until_due between 0 and ${BILLING_SETTINGS_LIMITS.daysUntilDueMax}`),
    ),
    check(
      'billing_settings_retry_schedule_check',
      sql.raw(
        `cardinality(retry_schedule_days) <= ${BILLING_SETTINGS_LIMITS.retriesMax} and array_position(retry_schedule_days, null) is null and 1 <= all(retry_schedule_days) and ${BILLING_SETTINGS_LIMITS.retryDaysMax} >= all(retry_schedule_days)`,
      ),
    ),
    check(
      'billing_settings_final_action_check',
      sql.raw(`final_action in (${inList(DUNNING_FINAL_ACTIONS)})`),
    ),
    check(
      'billing_settings_invoice_action_check',
      sql.raw(`invoice_action in (${inList(DUNNING_INVOICE_ACTIONS)})`),
    ),
  ],
);

/** One movement of a customer's balance (`cbtxn_…`). Append-only. */
export const customerBalanceTransactions = pgTable(
  'customer_balance_transactions',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    customerId: text().notNull(),
    type: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull(),
    endingBalance: text().notNull(),
    description: text(),
    invoiceId: text().references((): AnyPgColumn => invoices.id, { onDelete: 'restrict' }),
    creditNoteId: text().references((): AnyPgColumn => creditNotes.id, { onDelete: 'restrict' }),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('customer_balance_transactions_public_id_key').on(table.publicId),
    foreignKey({
      name: 'customer_balance_transactions_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    index('customer_balance_transactions_customer_id_id_idx').on(table.customerId, table.id),
    check(
      'customer_balance_transactions_type_check',
      sql.raw(`type in (${inList(CUSTOMER_BALANCE_TRANSACTION_TYPES)})`),
    ),
    check(
      'customer_balance_transactions_amounts_check',
      sql.raw(`${signedCheck('amount')} and amount <> '0' and ${signedCheck('ending_balance')}`),
    ),
    check(
      'customer_balance_transactions_currency_check',
      sql.raw(`currency in (${inList(CURRENCY_CODES)})`),
    ),
    check(
      'customer_balance_transactions_metadata_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  ],
);

/**
 * A subscription (`sub_…`).
 *
 * `status` moves only through `transitionSubscription` (compare-and-swap on the
 * source status, row + event + webhook in one transaction, ADR 0018 §4).
 * `next_action_at` is when the engine must next look at it (trial reminder,
 * trial end, period end, cancel_at, incomplete expiry, pause resumption) and
 * `lease_expires_at` the scheduler's claim on it.
 *
 * `test_clock_id` is the CUSTOMER's, copied at creation (a customer with a
 * subscription cannot change clocks), so the scheduler's due-work predicate
 * needs no join through customers.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    customerId: text().notNull(),
    testClockId: text(),
    status: text().notNull(),
    currency: text().notNull(),
    collectionMethod: text().notNull(),
    daysUntilDue: integer(),
    defaultPaymentMethodId: text(),
    description: text(),
    billingCycleAnchor: timestamptz().notNull(),
    currentPeriodStart: timestamptz().notNull(),
    currentPeriodEnd: timestamptz().notNull(),
    startDate: timestamptz().notNull(),
    trialStart: timestamptz(),
    trialEnd: timestamptz(),
    trialWillEndSentAt: timestamptz(),
    /** When `invoice.upcoming` was last sent (once per period). */
    upcomingNoticeSentAt: timestamptz(),
    trialEndBehavior: text().notNull().default('create_invoice'),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    cancelAt: timestamptz(),
    canceledAt: timestamptz(),
    endedAt: timestamptz(),
    cancellationReason: text(),
    cancellationComment: text(),
    pauseBehavior: text(),
    pauseResumesAt: timestamptz(),
    automaticTax: boolean().notNull().default(false),
    discountCouponId: text(),
    discountPromotionCodeId: text(),
    discountStart: timestamptz(),
    discountEnd: timestamptz(),
    latestInvoiceId: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    /**
     * An ADOPTED subscription (ADR 0018 §7, the Stripe-Billing migration):
     * its current period was billed by the previous provider up to this
     * instant, so no engine line covers it and nothing before it can be
     * credited by a proration. NULL for every subscription the engine billed.
     */
    providerBilledUntil: timestamptz(),
    /**
     * The previous provider still holds renewal authority: until the
     * migration has stopped it renewing, the engine neither renews this
     * subscription nor ends its trial — exactly one system bills the next
     * period. Written true only at adoption and false only by the release.
     */
    providerHandoffPending: boolean().notNull().default(false),
    nextActionAt: timestamptz(),
    leaseExpiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('subscriptions_public_id_key').on(table.publicId),
    unique('subscriptions_id_merchant_id_key').on(table.id, table.merchantId),
    unique('subscriptions_id_customer_id_key').on(table.id, table.customerId),
    foreignKey({
      name: 'subscriptions_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'subscriptions_test_clock_fkey',
      columns: [table.testClockId, table.merchantId],
      foreignColumns: [testClocks.id, testClocks.merchantId],
    }).onDelete('restrict'),
    /** The default method is one of the CUSTOMER's own (MATCH SIMPLE: none set). */
    foreignKey({
      name: 'subscriptions_default_payment_method_fkey',
      columns: [table.defaultPaymentMethodId, table.customerId],
      foreignColumns: [paymentMethods.id, paymentMethods.customerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'subscriptions_discount_coupon_fkey',
      columns: [table.discountCouponId, table.merchantId],
      foreignColumns: [coupons.id, coupons.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'subscriptions_discount_promotion_code_fkey',
      columns: [table.discountPromotionCodeId],
      foreignColumns: [promotionCodes.id],
    }).onDelete('restrict'),
    /** The latest invoice is one of THIS subscription's. */
    foreignKey({
      name: 'subscriptions_latest_invoice_fkey',
      columns: [table.latestInvoiceId, table.id],
      foreignColumns: [invoicesColumns().id, invoicesColumns().subscriptionId],
    }).onDelete('restrict'),
    index('subscriptions_merchant_id_id_idx').on(table.merchantId, table.id),
    index('subscriptions_customer_id_id_idx').on(table.customerId, table.id),
    /** The scheduler's due-work scan. */
    index('subscriptions_next_action_at_idx')
      .on(table.nextActionAt)
      .where(sql`${table.nextActionAt} is not null`),
    check('subscriptions_status_check', sql.raw(`status in (${inList(SUBSCRIPTION_STATUSES)})`)),
    check('subscriptions_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'subscriptions_collection_method_check',
      sql.raw(
        `collection_method in (${inList(COLLECTION_METHODS)}) and (collection_method = 'send_invoice') = (days_until_due is not null) and (days_until_due is null or days_until_due between 0 and ${BILLING_SETTINGS_LIMITS.daysUntilDueMax})`,
      ),
    ),
    /** FairCoin cannot be debited (ADR 0016 §4): a FAIR subscription sends its invoices. */
    check(
      'subscriptions_faircoin_sends_invoices_check',
      sql.raw(
        `currency <> 'FAIR' or (collection_method = 'send_invoice' and default_payment_method_id is null)`,
      ),
    ),
    check('subscriptions_period_check', sql.raw('current_period_end > current_period_start')),
    check(
      'subscriptions_trial_check',
      sql.raw(
        `(trial_start is null) = (trial_end is null) and (trial_end is null or trial_end >= trial_start) and trial_end_behavior in (${inList(TRIAL_END_BEHAVIORS)})`,
      ),
    ),
    check(
      'subscriptions_canceled_check',
      sql.raw(
        `(status in ('canceled', 'incomplete_expired')) = (ended_at is not null) and (status <> 'canceled' or canceled_at is not null) and (cancellation_reason is null or cancellation_reason in (${inList(SUBSCRIPTION_CANCELLATION_REASONS)}))`,
      ),
    ),
    check(
      'subscriptions_pause_check',
      sql.raw(
        `(pause_behavior is null or pause_behavior in (${inList(PAUSE_COLLECTION_BEHAVIORS)})) and (pause_resumes_at is null or pause_behavior is not null)`,
      ),
    ),
    check(
      'subscriptions_discount_check',
      sql.raw(
        `(discount_coupon_id is null) = (discount_start is null) and (discount_promotion_code_id is null or discount_coupon_id is not null) and (discount_end is null or discount_coupon_id is not null)`,
      ),
    ),
    check('subscriptions_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    /** A held renewal names the instant the previous provider billed through. */
    check(
      'subscriptions_provider_handoff_check',
      sql.raw('not provider_handoff_pending or provider_billed_until is not null'),
    ),
  ],
);

/**
 * A subscription item (`si_…`). Removing one is a tombstone (`deleted_at`):
 * invoice lines keep naming it. One live item per price per subscription.
 */
export const subscriptionItems = pgTable(
  'subscription_items',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    subscriptionId: text().notNull(),
    priceId: text().notNull(),
    quantity: integer().notNull().default(1),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    deletedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('subscription_items_public_id_key').on(table.publicId),
    foreignKey({
      name: 'subscription_items_subscription_fkey',
      columns: [table.subscriptionId, table.merchantId],
      foreignColumns: [subscriptions.id, subscriptions.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'subscription_items_price_fkey',
      columns: [table.priceId, table.merchantId],
      foreignColumns: [prices.id, prices.merchantId],
    }).onDelete('restrict'),
    uniqueIndex('subscription_items_subscription_price_key')
      .on(table.subscriptionId, table.priceId)
      .where(sql`${table.deletedAt} is null`),
    index('subscription_items_subscription_id_id_idx').on(table.subscriptionId, table.id),
    index('subscription_items_price_id_idx').on(table.priceId),
    check('subscription_items_quantity_check', sql.raw('quantity >= 0')),
    check('subscription_items_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/** `invoices`' columns, typed by hand for the `subscriptions` ↔ `invoices` cycle. */
function invoicesColumns(): { id: AnyPgColumn; subscriptionId: AnyPgColumn } {
  return { id: invoices.id, subscriptionId: invoices.subscriptionId };
}

/**
 * An invoice (`in_…`).
 *
 * `status` moves only through `transitionInvoice`. A draft's lines may change
 * and its totals are recomputed with them; from `open` on, every amount is
 * frozen except `amount_paid`/`amount_remaining` and the credit-note totals.
 * `number` is assigned in the finalize transaction (gapless, see
 * `billing_settings`) and is unique per merchant.
 *
 * `hosted_token` is the payer's bearer credential for the hosted page and the
 * PDF, like a payment link id: unguessable, minted at finalization.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    customerId: text().notNull(),
    subscriptionId: text(),
    testClockId: text(),
    status: text().notNull().default('draft'),
    billingReason: text().notNull(),
    collectionMethod: text().notNull(),
    currency: text().notNull(),
    number: text(),
    description: text(),
    autoAdvance: boolean().notNull(),
    automaticallyFinalizesAt: timestamptz(),
    daysUntilDue: integer(),
    dueDate: timestamptz(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    defaultPaymentMethodId: text(),
    discountCouponId: text(),
    discountPromotionCodeId: text(),
    automaticTax: boolean().notNull().default(false),
    automaticTaxStatus: text(),
    taxCalculationId: text(),
    /** The lines' fingerprint the tax was calculated for; finalize refuses a draft that moved since. */
    taxedLinesDigest: text(),
    subtotal: text().notNull().default('0'),
    totalDiscount: text().notNull().default('0'),
    tax: text(),
    total: text().notNull().default('0'),
    totalExcludingTax: text().notNull().default('0'),
    startingBalance: text().notNull().default('0'),
    endingBalance: text(),
    amountDue: text().notNull().default('0'),
    amountPaid: text().notNull().default('0'),
    prePaymentCreditNotesAmount: text().notNull().default('0'),
    postPaymentCreditNotesAmount: text().notNull().default('0'),
    attemptCount: integer().notNull().default(0),
    nextPaymentAttempt: timestamptz(),
    paymentIntentId: text().references(() => paymentIntents.id, { onDelete: 'restrict' }),
    paidOutOfBand: boolean().notNull().default(false),
    customerEmail: text(),
    customerName: text(),
    hostedToken: text(),
    finalizedAt: timestamptz(),
    paidAt: timestamptz(),
    voidedAt: timestamptz(),
    markedUncollectibleAt: timestamptz(),
    sentAt: timestamptz(),
    /** Dunning is over for this invoice: its final action ran. */
    dunningExhaustedAt: timestamptz(),
    lastFinalizationError: jsonb().$type<{ code: string; message: string }>(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    nextActionAt: timestamptz(),
    leaseExpiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('invoices_public_id_key').on(table.publicId),
    unique('invoices_id_merchant_id_key').on(table.id, table.merchantId),
    /** The target of `subscriptions_latest_invoice_fkey`. */
    unique('invoices_id_subscription_id_key').on(table.id, table.subscriptionId),
    unique('invoices_hosted_token_key').on(table.hostedToken),
    uniqueIndex('invoices_merchant_number_key')
      .on(table.merchantId, table.number)
      .where(sql`${table.number} is not null`),
    /**
     * One engine invoice per subscription period and reason: two workers
     * renewing the same period cannot both create one.
     */
    uniqueIndex('invoices_subscription_period_reason_key')
      .on(table.subscriptionId, table.billingReason, table.periodStart)
      .where(
        sql`${table.subscriptionId} is not null and ${table.billingReason} in ('subscription_create', 'subscription_cycle')`,
      ),
    foreignKey({
      name: 'invoices_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_subscription_fkey',
      columns: [table.subscriptionId, table.customerId],
      foreignColumns: [subscriptions.id, subscriptions.customerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_test_clock_fkey',
      columns: [table.testClockId, table.merchantId],
      foreignColumns: [testClocks.id, testClocks.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_default_payment_method_fkey',
      columns: [table.defaultPaymentMethodId, table.customerId],
      foreignColumns: [paymentMethods.id, paymentMethods.customerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_discount_coupon_fkey',
      columns: [table.discountCouponId, table.merchantId],
      foreignColumns: [coupons.id, coupons.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_discount_promotion_code_fkey',
      columns: [table.discountPromotionCodeId],
      foreignColumns: [promotionCodes.id],
    }).onDelete('restrict'),
    index('invoices_merchant_id_id_idx').on(table.merchantId, table.id),
    index('invoices_customer_id_id_idx').on(table.customerId, table.id),
    index('invoices_subscription_id_id_idx').on(table.subscriptionId, table.id),
    index('invoices_payment_intent_id_idx').on(table.paymentIntentId),
    index('invoices_next_action_at_idx')
      .on(table.nextActionAt)
      .where(sql`${table.nextActionAt} is not null`),
    check('invoices_status_check', sql.raw(`status in (${inList(INVOICE_STATUSES)})`)),
    check(
      'invoices_billing_reason_check',
      sql.raw(`billing_reason in (${inList(INVOICE_BILLING_REASONS)})`),
    ),
    check('invoices_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'invoices_collection_method_check',
      sql.raw(`collection_method in (${inList(COLLECTION_METHODS)})`),
    ),
    check(
      'invoices_faircoin_sends_check',
      sql.raw(
        `currency <> 'FAIR' or (collection_method = 'send_invoice' and default_payment_method_id is null)`,
      ),
    ),
    check(
      'invoices_amounts_check',
      sql.raw(
        [
          signedCheck('subtotal'),
          signedCheck('total_discount'),
          `(tax is null or ${signedCheck('tax')})`,
          signedCheck('total'),
          signedCheck('total_excluding_tax'),
          signedCheck('starting_balance'),
          `(ending_balance is null or ${signedCheck('ending_balance')})`,
          amountCheck('amount_due'),
          amountCheck('amount_paid'),
          amountCheck('pre_payment_credit_notes_amount'),
          amountCheck('post_payment_credit_notes_amount'),
        ].join(' and '),
      ),
    ),
    /** A number, a token and a finalization instant exist exactly from `open` on. */
    check(
      'invoices_finalized_check',
      sql.raw(
        `(status = 'draft') = (number is null) and (number is null) = (hosted_token is null) and (number is null) = (finalized_at is null) and (number is null) = (ending_balance is null)`,
      ),
    ),
    check(
      'invoices_status_transitions_check',
      sql.raw(
        `(status = 'paid') = (paid_at is not null) and (status = 'void') = (voided_at is not null) and (marked_uncollectible_at is not null or status <> 'uncollectible')`,
      ),
    ),
    check(
      'invoices_automatic_tax_check',
      sql.raw(
        `(automatic_tax_status is null or automatic_tax_status in (${inList(AUTOMATIC_TAX_STATUSES)})) and (automatic_tax or (automatic_tax_status is null and tax_calculation_id is null)) and (status = 'draft' or not automatic_tax or automatic_tax_status = 'complete')`,
      ),
    ),
    check(
      'invoices_days_until_due_check',
      sql.raw(
        `days_until_due is null or days_until_due between 0 and ${BILLING_SETTINGS_LIMITS.daysUntilDueMax}`,
      ),
    ),
    check('invoices_attempt_count_check', sql.raw('attempt_count >= 0')),
    check('invoices_period_check', sql.raw('period_end >= period_start')),
    check('invoices_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/**
 * A pending or drafted charge (`ii_…`). Pending while `invoice_id` is NULL;
 * pulled into a draft by setting it. Engine-made prorations may be negative
 * (a credit for unused time); a merchant-made item never is (`createInvoiceItem`
 * is the chokepoint).
 */
export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    customerId: text().notNull(),
    invoiceId: text(),
    subscriptionId: text(),
    subscriptionItemId: text().references(() => subscriptionItems.id, { onDelete: 'restrict' }),
    priceId: text(),
    quantity: integer().notNull().default(1),
    unitAmount: text(),
    amount: text().notNull(),
    currency: text().notNull(),
    description: text(),
    discountable: boolean().notNull().default(true),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    proration: boolean().notNull().default(false),
    /** A proration credit: the invoice line whose unused time it gives back (tax follows it). */
    creditsLineId: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('invoice_items_public_id_key').on(table.publicId),
    foreignKey({
      name: 'invoice_items_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_items_invoice_fkey',
      columns: [table.invoiceId, table.merchantId],
      foreignColumns: [invoices.id, invoices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_items_subscription_fkey',
      columns: [table.subscriptionId, table.customerId],
      foreignColumns: [subscriptions.id, subscriptions.customerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_items_price_fkey',
      columns: [table.priceId, table.merchantId],
      foreignColumns: [prices.id, prices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_items_credits_line_fkey',
      columns: [table.creditsLineId],
      foreignColumns: [invoiceLineItemsColumns().id],
    }).onDelete('restrict'),
    index('invoice_items_merchant_id_id_idx').on(table.merchantId, table.id),
    index('invoice_items_customer_pending_idx')
      .on(table.customerId, table.id)
      .where(sql`${table.invoiceId} is null`),
    index('invoice_items_invoice_id_idx').on(table.invoiceId),
    check('invoice_items_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'invoice_items_amounts_check',
      sql.raw(
        `${signedCheck('amount')} and (unit_amount is null or ${amountCheck('unit_amount')}) and quantity >= 0 and (amount !~ '^-' or proration)`,
      ),
    ),
    check('invoice_items_period_check', sql.raw('period_end >= period_start')),
    check('invoice_items_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

function invoiceLineItemsColumns(): { id: AnyPgColumn } {
  return { id: invoiceLineItems.id };
}

/**
 * One line of an invoice (`il_…`), written when the draft is built and frozen
 * when it finalizes. `amount` is signed and pre-discount; `discount_amount`
 * and `tax_amounts` are what the finalize computed.
 */
export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    invoiceId: text().notNull(),
    type: text().notNull(),
    subscriptionId: text(),
    subscriptionItemId: text().references(() => subscriptionItems.id, { onDelete: 'restrict' }),
    invoiceItemId: text().references((): AnyPgColumn => invoiceItems.id, { onDelete: 'restrict' }),
    priceId: text(),
    quantity: integer(),
    amount: text().notNull(),
    discountAmount: text().notNull().default('0'),
    taxAmounts: jsonb().$type<InvoiceTaxAmount[]>().notNull().default(sql`'[]'::jsonb`),
    currency: text().notNull(),
    description: text(),
    discountable: boolean().notNull().default(true),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    proration: boolean().notNull().default(false),
    creditsLineId: text(),
    /** Metered: the quantity is the meter's aggregate over the period. */
    metered: boolean().notNull().default(false),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    createdAt: createdAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('invoice_line_items_public_id_key').on(table.publicId),
    foreignKey({
      name: 'invoice_line_items_invoice_fkey',
      columns: [table.invoiceId, table.merchantId],
      foreignColumns: [invoices.id, invoices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_line_items_price_fkey',
      columns: [table.priceId, table.merchantId],
      foreignColumns: [prices.id, prices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_line_items_credits_line_fkey',
      columns: [table.creditsLineId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
    /** An invoice item is drafted onto ONE invoice line. */
    uniqueIndex('invoice_line_items_invoice_item_key')
      .on(table.invoiceItemId)
      .where(sql`${table.invoiceItemId} is not null`),
    index('invoice_line_items_invoice_id_idx').on(table.invoiceId, table.id),
    index('invoice_line_items_subscription_item_id_idx').on(table.subscriptionItemId),
    check('invoice_line_items_type_check', sql.raw(`type in (${inList(INVOICE_LINE_TYPES)})`)),
    check(
      'invoice_line_items_source_check',
      sql.raw(
        `(type = 'invoiceitem') = (invoice_item_id is not null) and (type <> 'subscription' or subscription_item_id is not null)`,
      ),
    ),
    check(
      'invoice_line_items_amounts_check',
      sql.raw(
        `${signedCheck('amount')} and ${signedCheck('discount_amount')} and jsonb_typeof(tax_amounts) = 'array' and (quantity is null or quantity >= 0)`,
      ),
    ),
    check('invoice_line_items_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check('invoice_line_items_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/**
 * A credit note (`cn_…`) against one invoice. Issued, then optionally voided —
 * never deleted. `number` is the invoice's plus a per-invoice sequence.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    invoiceId: text().notNull(),
    customerId: text().notNull(),
    number: text().notNull(),
    status: text().notNull().default('issued'),
    type: text().notNull(),
    reason: text(),
    currency: text().notNull(),
    subtotal: text().notNull(),
    tax: text().notNull(),
    total: text().notNull(),
    refundAmount: text().notNull().default('0'),
    creditAmount: text().notNull().default('0'),
    outOfBandAmount: text().notNull().default('0'),
    refundId: text().references(() => refunds.id, { onDelete: 'restrict' }),
    memo: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    voidedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('credit_notes_public_id_key').on(table.publicId),
    unique('credit_notes_merchant_number_key').on(table.merchantId, table.number),
    foreignKey({
      name: 'credit_notes_invoice_fkey',
      columns: [table.invoiceId, table.merchantId],
      foreignColumns: [invoices.id, invoices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credit_notes_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    index('credit_notes_merchant_id_id_idx').on(table.merchantId, table.id),
    index('credit_notes_invoice_id_idx').on(table.invoiceId),
    check('credit_notes_status_check', sql.raw(`status in (${inList(CREDIT_NOTE_STATUSES)})`)),
    check('credit_notes_type_check', sql.raw(`type in (${inList(CREDIT_NOTE_TYPES)})`)),
    check(
      'credit_notes_reason_check',
      sql.raw(`reason is null or reason in (${inList(CREDIT_NOTE_REASONS)})`),
    ),
    check('credit_notes_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'credit_notes_amounts_check',
      sql.raw(
        `${['subtotal', 'tax', 'total', 'refund_amount', 'credit_amount', 'out_of_band_amount']
          .map(amountCheck)
          .join(' and ')} and total <> '0'`,
      ),
    ),
    /** Only a post-payment note gives anything back; a pre-payment one reduces what is due. */
    check(
      'credit_notes_distribution_check',
      sql.raw(
        `type = 'post_payment' or (refund_amount = '0' and credit_amount = '0' and out_of_band_amount = '0')`,
      ),
    ),
    check('credit_notes_voided_check', sql.raw(`(status = 'void') = (voided_at is not null)`)),
    check('credit_notes_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/** One line of a credit note (`cnli_…`). */
export const creditNoteLines = pgTable(
  'credit_note_lines',
  {
    id: generatedId(),
    publicId: text().notNull(),
    creditNoteId: text()
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'restrict' }),
    type: text().notNull(),
    invoiceLineItemId: text().references(() => invoiceLineItems.id, { onDelete: 'restrict' }),
    description: text(),
    quantity: integer(),
    amount: text().notNull(),
    taxAmount: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('credit_note_lines_public_id_key').on(table.publicId),
    index('credit_note_lines_credit_note_id_idx').on(table.creditNoteId),
    index('credit_note_lines_invoice_line_item_id_idx').on(table.invoiceLineItemId),
    check('credit_note_lines_type_check', sql.raw(`type in (${inList(CREDIT_NOTE_LINE_TYPES)})`)),
    check(
      'credit_note_lines_source_check',
      sql.raw(`(type = 'invoice_line_item') = (invoice_line_item_id is not null)`),
    ),
    check(
      'credit_note_lines_amounts_check',
      sql.raw(`${amountCheck('amount')} and ${amountCheck('tax_amount')}`),
    ),
  ],
);

/**
 * One usage event. `identifier` is the idempotency: one row per merchant and
 * identifier, forever — a retried report is the same event.
 */
export const billingMeterEvents = pgTable(
  'billing_meter_events',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    meterId: text().notNull(),
    customerId: text().notNull(),
    identifier: text().notNull(),
    eventName: text().notNull(),
    value: text().notNull(),
    payload: jsonb().$type<Record<string, string>>().notNull(),
    timestamp: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('billing_meter_events_merchant_identifier_key').on(table.merchantId, table.identifier),
    foreignKey({
      name: 'billing_meter_events_meter_fkey',
      columns: [table.meterId, table.merchantId],
      foreignColumns: [billingMeters.id, billingMeters.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'billing_meter_events_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    /** The per-period aggregate: one meter, one customer, a time window. */
    index('billing_meter_events_meter_customer_timestamp_idx').on(
      table.meterId,
      table.customerId,
      table.timestamp,
    ),
    check('billing_meter_events_value_check', sql.raw(amountCheck('value'))),
    check(
      'billing_meter_events_identifier_check',
      sql.raw(`char_length(identifier) between 1 and 100`),
    ),
    check('billing_meter_events_payload_check', sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);

/** An entitlement feature (`feat_…`). `lookup_key` is unique per merchant, forever. */
export const entitlementFeatures = pgTable(
  'entitlement_features',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    lookupKey: text().notNull(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('entitlement_features_public_id_key').on(table.publicId),
    unique('entitlement_features_id_merchant_id_key').on(table.id, table.merchantId),
    unique('entitlement_features_merchant_lookup_key_key').on(table.merchantId, table.lookupKey),
    index('entitlement_features_merchant_id_id_idx').on(table.merchantId, table.id),
    check(
      'entitlement_features_lookup_key_check',
      sql.raw(`lookup_key ~ '^[A-Za-z0-9_.:-]{1,80}$'`),
    ),
    check('entitlement_features_name_check', sql.raw(`char_length(name) between 1 and 80`)),
    check('entitlement_features_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

/**
 * A feature attached to a product (`prodft_…`). Several products may grant the
 * same feature — Mention Plus by the Plus product AND by Oxy One (ADR 0018 §6).
 */
export const productFeatures = pgTable(
  'product_features',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    productId: text().notNull(),
    featureId: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('product_features_public_id_key').on(table.publicId),
    unique('product_features_product_feature_key').on(table.productId, table.featureId),
    foreignKey({
      name: 'product_features_product_fkey',
      columns: [table.productId, table.merchantId],
      foreignColumns: [products.id, products.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'product_features_feature_fkey',
      columns: [table.featureId, table.merchantId],
      foreignColumns: [entitlementFeatures.id, entitlementFeatures.merchantId],
    }).onDelete('restrict'),
    index('product_features_feature_id_idx').on(table.featureId),
  ],
);

/**
 * The last active-entitlement answer published for a customer — the compare
 * half of `entitlements.active_entitlement_summary.updated`: an event is
 * recorded only when the set of feature lookup keys actually moved.
 */
export const customerEntitlementSummaries = pgTable('customer_entitlement_summaries', {
  customerId: text()
    .primaryKey()
    .references(() => customers.id, { onDelete: 'restrict' }),
  featureIds: text().array().notNull(),
  updatedAt: updatedAt(),
});

/** A portal configuration (`bpc_…`). At most one default per merchant. */
export const billingPortalConfigurations = pgTable(
  'billing_portal_configurations',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    active: boolean().notNull().default(true),
    isDefault: boolean().notNull().default(false),
    businessProfile: jsonb().$type<BillingPortalConfiguration['business_profile']>().notNull(),
    defaultReturnUrl: text(),
    features: jsonb().$type<BillingPortalFeatures>().notNull(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('billing_portal_configurations_public_id_key').on(table.publicId),
    unique('billing_portal_configurations_id_merchant_id_key').on(table.id, table.merchantId),
    uniqueIndex('billing_portal_configurations_merchant_default_key')
      .on(table.merchantId)
      .where(sql`${table.isDefault}`),
    index('billing_portal_configurations_merchant_id_id_idx').on(table.merchantId, table.id),
    check(
      'billing_portal_configurations_json_check',
      sql`jsonb_typeof(${table.businessProfile}) = 'object' and jsonb_typeof(${table.features}) = 'object' and jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    check(
      'billing_portal_configurations_default_active_check',
      sql.raw('active or not is_default'),
    ),
    check(
      'billing_portal_configurations_return_url_check',
      sql.raw(
        `default_return_url is null or (default_return_url ~ '^https?://' and char_length(default_return_url) <= 2048)`,
      ),
    ),
  ],
);

/**
 * A portal session (`bps_…`). The URL's token is a bearer credential to one
 * customer's billing, so only its SHA-256 is stored.
 */
export const billingPortalSessions = pgTable(
  'billing_portal_sessions',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    customerId: text().notNull(),
    configurationId: text().notNull(),
    tokenHash: text().notNull(),
    returnUrl: text(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('billing_portal_sessions_public_id_key').on(table.publicId),
    unique('billing_portal_sessions_token_hash_key').on(table.tokenHash),
    foreignKey({
      name: 'billing_portal_sessions_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'billing_portal_sessions_configuration_fkey',
      columns: [table.configurationId, table.merchantId],
      foreignColumns: [billingPortalConfigurations.id, billingPortalConfigurations.merchantId],
    }).onDelete('restrict'),
    index('billing_portal_sessions_customer_id_idx').on(table.customerId),
    check('billing_portal_sessions_token_hash_check', sql.raw(`token_hash ~ '^[0-9a-f]{64}$'`)),
    check(
      'billing_portal_sessions_return_url_check',
      sql.raw(
        `return_url is null or (return_url ~ '^https?://' and char_length(return_url) <= 2048)`,
      ),
    ),
  ],
);
