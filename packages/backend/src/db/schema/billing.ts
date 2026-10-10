import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { merchants } from './merchants';
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
