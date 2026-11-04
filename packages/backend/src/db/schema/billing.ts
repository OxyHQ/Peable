import type { BillingTaxCheckoutSnapshot } from '../../services/billing/tax-checkout';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { prices } from './catalog';
import { customers, paymentMethods } from './customers';
import { subscriptions } from './billingEngine';
import { merchants } from './merchants';
import { taxCalculations } from './tax';
import {
  BILLING_BINDING_KINDS,
  BILLING_OPERATIONS,
  BILLING_OPERATION_STATES,
  type BillingOperationResult,
} from '../../services/billing/contracts';

/** Insert-only identity through the repository; no metadata-based adoption. */
export const billingObjectBindings = pgTable(
  'billing_object_bindings',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    oxyAppId: text().notNull(),
    environment: text().notNull(),
    provider: text().notNull(),
    platformAccountId: text().notNull(),
    livemode: boolean().notNull(),
    kind: text({ enum: BILLING_BINDING_KINDS }).notNull(),
    providerRef: text().notNull(),
    /** A store reference in this app's namespace, NOT an Oxy account or merchant owner. */
    externalSubjectRef: text(),
    planRef: text(),
    customerBindingId: text().references((): AnyPgColumn => billingObjectBindings.id, {
      onDelete: 'restrict',
    }),
    priceBindingId: text().references((): AnyPgColumn => billingObjectBindings.id, {
      onDelete: 'restrict',
    }),
    bindingEvidenceRef: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'billing_bindings_merchant_identity_fk',
      columns: [table.merchantId, table.oxyAppId, table.environment],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('billing_bindings_provider_object_key').on(
      table.provider,
      table.platformAccountId,
      table.livemode,
      table.kind,
      table.providerRef,
    ),
    uniqueIndex('billing_bindings_customer_store_key')
      .on(
        table.provider,
        table.platformAccountId,
        table.livemode,
        table.merchantId,
        table.externalSubjectRef,
      )
      .where(sql`${table.kind} = 'customer'`),
    check('billing_bindings_provider_check', sql`${table.provider} = 'stripe'`),
    check('billing_bindings_kind_check', sql.raw(`kind in (${inList(BILLING_BINDING_KINDS)})`)),
    check(
      'billing_bindings_mode_check',
      sql`(${table.environment} = 'production') = ${table.livemode}`,
    ),
    check(
      'billing_bindings_shape_check',
      sql`(${table.kind} = 'customer' and ${table.externalSubjectRef} is not null and ${table.planRef} is null and ${table.customerBindingId} is null and ${table.priceBindingId} is null) or (${table.kind} = 'price' and ${table.externalSubjectRef} is null and ${table.planRef} is not null and ${table.customerBindingId} is null and ${table.priceBindingId} is null) or (${table.kind} = 'subscription' and ${table.externalSubjectRef} is not null and ${table.planRef} is not null and ${table.customerBindingId} is not null and ${table.priceBindingId} is not null)`,
    ),
  ],
);

/** No raw requests or provider payloads. Hosted URLs are sensitive owner-only results. */
export const billingOperations = pgTable(
  'billing_operations',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    oxyAppId: text().notNull(),
    environment: text().notNull(),
    provider: text().notNull(),
    platformAccountId: text().notNull(),
    livemode: boolean().notNull(),
    operation: text({ enum: BILLING_OPERATIONS }).notNull(),
    idempotencyKey: text().notNull(),
    requestDigest: text().notNull(),
    /** Immutable fiscal checkout evidence; legacy operations intentionally have none. */
    taxQuoteRef: text(),
    taxCheckoutSnapshot: jsonb().$type<BillingTaxCheckoutSnapshot>(),
    /** Only ensure_customer: prevents another key creating a second customer after a timeout. */
    subjectClaimRef: text(),
    remoteIdempotencyKey: text().notNull(),
    customerBindingId: text().references(() => billingObjectBindings.id, { onDelete: 'restrict' }),
    priceBindingId: text().references(() => billingObjectBindings.id, { onDelete: 'restrict' }),
    state: text({ enum: BILLING_OPERATION_STATES }).notNull().default('pending'),
    leaseToken: text(),
    leaseExpiresAt: timestamptz(),
    retryUntil: timestamptz().notNull(),
    result: jsonb().$type<BillingOperationResult>(),
    resultExpiresAt: timestamptz(),
    /** Checkout reference needed for verified completion; no provider payload. */
    providerObjectRef: text(),
    /** Immutable first subscription_create invoice; never overwritten by renewal/latest. */
    initialInvoiceRef: text(),
    createdAt: createdAt(),
    completedAt: timestamptz(),
  },
  (table) => [
    foreignKey({
      name: 'billing_operations_merchant_identity_fk',
      columns: [table.merchantId, table.oxyAppId, table.environment],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    // Deliberately excludes caller/merchant/operation: a key cannot name another financial intent.
    unique('billing_operations_global_key').on(
      table.provider,
      table.platformAccountId,
      table.livemode,
      table.idempotencyKey,
    ),
    uniqueIndex('billing_operations_customer_claim_key')
      .on(
        table.provider,
        table.platformAccountId,
        table.livemode,
        table.merchantId,
        table.subjectClaimRef,
      )
      .where(sql`${table.operation} = 'ensure_customer' and ${table.state} <> 'succeeded'`),
    uniqueIndex('billing_operations_checkout_ref_key')
      .on(table.provider, table.platformAccountId, table.livemode, table.providerObjectRef)
      .where(sql`${table.operation} = 'checkout' and ${table.providerObjectRef} is not null`),
    uniqueIndex('billing_operations_tax_quote_key')
      .on(
        table.provider,
        table.platformAccountId,
        table.livemode,
        table.merchantId,
        table.taxQuoteRef,
      )
      .where(sql`${table.taxQuoteRef} is not null`),
    check(
      'billing_operations_tax_quote_shape_check',
      sql`(${table.taxQuoteRef} is null and ${table.taxCheckoutSnapshot} is null) or (${table.operation} = 'checkout' and ${table.taxQuoteRef} is not null and ${table.taxCheckoutSnapshot} is not null and jsonb_typeof(${table.taxCheckoutSnapshot}) = 'object' and coalesce(${table.taxCheckoutSnapshot}->'taxQuote'->'quote'->>'id' = ${table.taxQuoteRef}, false))`,
    ),
    check(
      'billing_operations_checkout_bindings_check',
      sql`(${table.operation} = 'checkout' and ${table.customerBindingId} is not null and ${table.priceBindingId} is not null) or (${table.operation} <> 'checkout' and ${table.customerBindingId} is null and ${table.priceBindingId} is null)`,
    ),
    check(
      'billing_operations_checkout_result_check',
      sql`${table.operation} <> 'checkout' or ${table.state} <> 'succeeded' or ${table.providerObjectRef} is not null`,
    ),
    check('billing_operations_provider_check', sql`${table.provider} = 'stripe'`),
    check(
      'billing_operations_operation_check',
      sql.raw(`operation in (${inList(BILLING_OPERATIONS)})`),
    ),
    check(
      'billing_operations_state_check',
      sql.raw(`state in (${inList(BILLING_OPERATION_STATES)})`),
    ),
    check(
      'billing_operations_mode_check',
      sql`(${table.environment} = 'production') = ${table.livemode}`,
    ),
    check('billing_operations_digest_check', sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'billing_operations_subject_check',
      sql`(${table.operation} = 'ensure_customer') = (${table.subjectClaimRef} is not null)`,
    ),
    check(
      'billing_operations_lease_check',
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      'billing_operations_result_check',
      sql`(${table.state} = 'succeeded' and ${table.result} is not null and jsonb_typeof(${table.result}) = 'object' and ${table.completedAt} is not null and ${table.leaseToken} is null) or (${table.state} <> 'succeeded' and ${table.result} is null and ${table.completedAt} is null)`,
    ),
  ],
);

/**
 * Peable Tax on a card renewal (ADR 0013): the fresh, signed quote a draft
 * renewal invoice was repriced with before it finalized. One per provider
 * invoice; insert-only. The paid invoice commits `calculation_id` as its tax
 * transaction, and the signed final invoice of a renewal is built from
 * `snapshot` (the same shape as a quoted checkout's), never from the
 * checkout's quote.
 */
export const billingRenewalTaxes = pgTable(
  'billing_renewal_taxes',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    provider: text().notNull(),
    livemode: boolean().notNull(),
    invoiceRef: text().notNull(),
    subscriptionRef: text().notNull(),
    calculationId: text()
      .notNull()
      .references(() => taxCalculations.id, { onDelete: 'restrict' }),
    /** The manual provider tax rate carrying the frozen amount; null for zero tax. */
    taxRateRef: text(),
    snapshot: jsonb().$type<BillingTaxCheckoutSnapshot>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('billing_renewal_taxes_invoice_key').on(
      table.provider,
      table.livemode,
      table.invoiceRef,
    ),
    check('billing_renewal_taxes_provider_check', sql`${table.provider} = 'stripe'`),
    check('billing_renewal_taxes_snapshot_check', sql`jsonb_typeof(${table.snapshot}) = 'object'`),
  ],
);

/** What a proxied subscription's migration (ADR 0018 §7) has reached. */
export const BILLING_PROXY_MIGRATION_STATES = ['adopted', 'released'] as const;
export type BillingProxyMigrationState = (typeof BILLING_PROXY_MIGRATION_STATES)[number];

/**
 * The auditable record of moving ONE proxied Stripe subscription onto a native
 * one (`services/billing/proxyMigration.ts`), and its per-subscription marker:
 * a binding with a row here is never adopted again.
 *
 * `adopted` — the native subscription exists (written in the same transaction
 * as this row) and is HELD (`subscriptions.provider_handoff_pending`): Stripe
 * still renews it. `released` — Stripe was told not to renew (cancel at period
 * end, collection voided) and the engine holds renewal authority. Nothing
 * else: the blocked and skipped subscriptions are the dry run's report, not
 * rows.
 *
 * Every reference is composite, so the customer, its card, the price and the
 * subscription are one merchant's and one customer's by construction.
 */
export const billingProxyMigrations = pgTable(
  'billing_proxy_migrations',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    livemode: boolean().notNull(),
    subscriptionBindingId: text()
      .notNull()
      .references(() => billingObjectBindings.id, { onDelete: 'restrict' }),
    customerBindingId: text()
      .notNull()
      .references(() => billingObjectBindings.id, { onDelete: 'restrict' }),
    /** The Stripe `sub_…` it replaced — the binding's, kept beside it for the audit. */
    providerSubscriptionRef: text().notNull(),
    customerId: text().notNull(),
    paymentMethodId: text().notNull(),
    priceId: text().notNull(),
    subscriptionId: text().notNull(),
    state: text({ enum: BILLING_PROXY_MIGRATION_STATES }).notNull(),
    adoptedAt: timestamptz().notNull(),
    releasedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('billing_proxy_migrations_subscription_binding_key').on(table.subscriptionBindingId),
    unique('billing_proxy_migrations_subscription_key').on(table.subscriptionId),
    index('billing_proxy_migrations_customer_binding_idx').on(table.customerBindingId),
    index('billing_proxy_migrations_merchant_state_idx').on(table.merchantId, table.state),
    foreignKey({
      name: 'billing_proxy_migrations_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'billing_proxy_migrations_payment_method_fkey',
      columns: [table.paymentMethodId, table.customerId],
      foreignColumns: [paymentMethods.id, paymentMethods.customerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'billing_proxy_migrations_price_fkey',
      columns: [table.priceId, table.merchantId],
      foreignColumns: [prices.id, prices.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'billing_proxy_migrations_subscription_fkey',
      columns: [table.subscriptionId, table.customerId],
      foreignColumns: [subscriptions.id, subscriptions.customerId],
    }).onDelete('restrict'),
    check(
      'billing_proxy_migrations_state_check',
      sql.raw(`state in (${inList(BILLING_PROXY_MIGRATION_STATES)})`),
    ),
    check(
      'billing_proxy_migrations_released_check',
      sql.raw(`(state = 'released') = (released_at is not null)`),
    ),
  ],
);
