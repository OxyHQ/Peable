import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import type { PaymentIntentLastPaymentError } from '@peable.to/shared-types';
import { customers, paymentMethods } from './customers';
import { merchants } from './merchants';
import { PROVIDER_IDS, SETUP_INTENT_STATUS_VALUES } from './valueSets';

const emptyMetadata = sql`'{}'::jsonb`;

/** How the saved card will be used — Stripe's two. */
export const SETUP_INTENT_USAGE_VALUES = ['on_session', 'off_session'] as const;

/** Why a SetupIntent was cancelled. NULL when nobody said. */
export const SETUP_INTENT_CANCELLATION_REASON_VALUES = [
  'abandoned',
  'duplicate',
  'requested_by_customer',
] as const;

/**
 * A SetupIntent (`seti_…`) — saving a card for later without charging it
 * (ADR 0016, ADR 0019).
 *
 * Card only: a FairCoin customer has no saved payment method (ADR 0016 D4), so
 * there is no FairCoin SetupIntent and the row carries a provider always.
 *
 * Written row FIRST, provider second — the two-step every provider object here
 * uses: a crash between them leaves a row with no `provider_object_id`, which a
 * retry finishes with the same idempotency key (`seti:<public id>`). The
 * provider SetupIntent is the BINDING (`provider_object_id`) and never reaches
 * the wire. Its success is what creates the Peable `pm_…`
 * (`payment_method_id`), in the same transaction as the status.
 */
export const setupIntents = pgTable(
  'setup_intents',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /** The customer the card is saved to. Required: a `pm_…` is born attached. */
    customerId: text().notNull(),
    status: text().notNull().default('requires_payment_method'),
    usage: text().notNull().default('off_session'),
    clientSecret: text().notNull(),
    description: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    lastSetupError: jsonb().$type<PaymentIntentLastPaymentError>(),
    cancellationReason: text(),
    /** The `pm_…` this SetupIntent saved, once `succeeded`. */
    paymentMethodId: text(),
    provider: text().notNull(),
    providerObjectId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('setup_intents_public_id_key').on(table.publicId),
    uniqueIndex('setup_intents_provider_object_key')
      .on(table.provider, table.providerObjectId)
      .where(sql`${table.providerObjectId} is not null`),
    index('setup_intents_merchant_id_idx').on(table.merchantId),
    index('setup_intents_customer_id_idx').on(table.customerId),
    foreignKey({
      name: 'setup_intents_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    /** The customer is this merchant's. */
    foreignKey({
      name: 'setup_intents_customer_merchant_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    /** ...and so is the payment method it saved. */
    foreignKey({
      name: 'setup_intents_payment_method_merchant_fkey',
      columns: [table.paymentMethodId, table.merchantId],
      foreignColumns: [paymentMethods.id, paymentMethods.merchantId],
    }).onDelete('restrict'),
    check(
      'setup_intents_status_check',
      sql.raw(`status in (${inList(SETUP_INTENT_STATUS_VALUES)})`),
    ),
    check('setup_intents_usage_check', sql.raw(`usage in (${inList(SETUP_INTENT_USAGE_VALUES)})`)),
    check(
      'setup_intents_cancellation_reason_check',
      sql.raw(
        `cancellation_reason is null or (status = 'canceled' and cancellation_reason in (${inList(SETUP_INTENT_CANCELLATION_REASON_VALUES)}))`,
      ),
    ),
    check('setup_intents_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('setup_intents_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    /** A saved method exists exactly when the SetupIntent succeeded. */
    check(
      'setup_intents_succeeded_saved_a_method_check',
      sql`(${table.status} = 'succeeded') = (${table.paymentMethodId} is not null)`,
    ),
  ],
);
