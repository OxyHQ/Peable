import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  BASE_UNIT_STRING_PATTERN,
  CURRENCY_CODES,
  PROVIDER_IDS,
  REFUND_STATUSES,
} from './valueSets';

/**
 * Money going back to a payer.
 *
 * ## Why refunds are ROWS and not a column on the payment
 *
 * A payment can be refunded many times, partially, over months. A
 * `refunded_amount` column would answer "how much" and nothing else — not when,
 * not by whom, not which of three attempts failed, and not whether the fourth
 * is a duplicate of the second. Every one of those is a question a support
 * conversation actually asks.
 *
 * The intent's own `refunded`/`partially_refunded` status is DERIVED from these
 * rows, never the other way round.
 *
 * ## The merchant's own id is the idempotency, and it is durable
 *
 * `external_ref` is the merchant's refund record. Unique per merchant, so
 * "refund order 7" converges across a retry — and unlike an `Idempotency-Key`
 * header the merchant cannot lose it. Refunding twice is the failure that
 * matters here: the money is gone and no reversal of the second one is
 * automatic.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: generatedId(),
    /** The `re_…` the API returns. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    paymentIntentId: text().notNull(),
    /** The MERCHANT's own id for this refund. The idempotency. */
    externalRef: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull(),
    status: text().notNull().default('pending'),
    provider: text().notNull(),
    /**
     * The provider's own refund id. NULL between our insert and the provider
     * call returning — the same two-step every money movement here uses, so a
     * crash in that window leaves a row rather than an untracked refund.
     */
    providerObjectId: text(),
    /** The provider's machine-readable failure reason, when it failed. */
    failureCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('refunds_public_id_key').on(table.publicId),
    /**
     * ONE refund per (merchant, their refund id).
     *
     * The single most consequential constraint in this file. A retried refund
     * submission converges here instead of sending the payer their money a
     * second time — which nothing reverses automatically and which the payer
     * has no reason to report.
     */
    unique('refunds_merchant_external_ref_key').on(table.merchantId, table.externalRef),
    /** One row per provider refund, so an inbound refund event maps to one row. */
    unique('refunds_provider_object_key').on(table.provider, table.providerObjectId),
    /** "What has come back off this payment?" — the read the total is summed from. */
    index('refunds_payment_intent_idx').on(table.paymentIntentId),
    foreignKey({
      name: 'refunds_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'refunds_payment_intent_id_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    check('refunds_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('refunds_status_check', sql.raw(`status in (${inList(REFUND_STATUSES)})`)),
    check('refunds_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check('refunds_external_ref_check', sql`length(${table.externalRef}) > 0`),
    check('refunds_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    /**
     * A refund of nothing is not a refund.
     *
     * `amount ~ '^(0|[1-9][0-9]*)$'` above accepts `'0'` — it is the canonical
     * form of zero and legitimate for a cumulative total like
     * `transfers.amount_reversed`. It is not legitimate here: a zero refund
     * would consume the merchant's `external_ref`, so the REAL refund for that
     * order could never be created afterwards.
     */
    check('refunds_amount_positive_check', sql`${table.amount}::numeric > 0`),
    /** A succeeded refund HAS a provider object; a pending or failed one may not. */
    check(
      'refunds_succeeded_has_provider_object_check',
      sql`${table.status} <> 'succeeded' or ${table.providerObjectId} is not null`
    ),
  ]
);
