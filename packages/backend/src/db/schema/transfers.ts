import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { connectedAccounts } from './connectedAccounts';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  BASE_UNIT_STRING_PATTERN,
  CURRENCY_CODES,
  PROVIDER_IDS,
  TRANSFER_STATUSES,
} from './valueSets';

/**
 * Money moving from a settled payment to one seller.
 *
 * One payment funds N transfers, which is the whole of "separate charges and
 * transfers": a single PaymentIntent can only ever pay one connected account
 * directly, so a multi-seller cart charges once and transfers N times.
 *
 * ## The gateway is never asked to SPLIT anything
 *
 * A transfer is created with an amount the merchant states. Peable does not
 * compute shares, does not know a marketplace's fee schedule, and must never
 * learn one: Mercaria's ADR 0001 insists the split has exactly one definition,
 * and a gateway that computed it would be a second. What this table holds is
 * the record that a stated amount was moved, and whether it came back.
 *
 * ## Reversal is an AMOUNT, not a flag
 *
 * `amount_reversed` is cumulative and `status` is derived from it, because a
 * partial refund can happen twice. A boolean `reversed` would make the second
 * partial reversal indistinguishable from the first, and the seller's balance
 * would be wrong by exactly one leg with nothing recording which.
 */
export const transfers = pgTable(
  'transfers',
  {
    id: generatedId(),
    /** The `tr_…` the API returns. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /** The payment this transfer is funded BY. Internal id, never the `pi_…`. */
    paymentIntentId: text().notNull(),
    connectedAccountId: text().notNull(),
    /**
     * The MERCHANT's own id for what this transfer settles — a Mercaria order
     * id. Unique per merchant, so "settle order 7" is idempotent across a
     * retry and cannot pay a seller twice.
     */
    externalRef: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull(),
    /** Cumulative, in the same units as `amount`. Never a per-leg figure. */
    amountReversed: text().notNull().default('0'),
    status: text().notNull().default('pending'),
    provider: text().notNull(),
    /**
     * The provider's own `tr_…`. NULL between our insert and the provider call
     * returning — the same two-step create `payment_intents` uses, for the same
     * reason: a crash in that window must leave a row, not an untracked
     * movement of a seller's money.
     */
    providerObjectId: text(),
    /**
     * The provider's id for the CHARGE this transfer draws on.
     *
     * Stored because it is what makes the transfer wait for the charge's funds
     * (`source_transaction`). Without it a transfer created moments after a
     * charge fails against a platform balance that is real but not yet
     * available — an intermittent failure that reads as a provider outage.
     */
    sourcePaymentObjectId: text(),
    /** Operator-facing, redacted. Why the provider refused. */
    failureMessage: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('transfers_public_id_key').on(table.publicId),
    /**
     * ONE transfer per (merchant, their order). The idempotency that matters
     * most in this file: a retried settlement converges on this rather than
     * paying a seller twice, and unlike an `Idempotency-Key` the merchant
     * cannot lose it — it is their own order id.
     */
    unique('transfers_merchant_external_ref_key').on(table.merchantId, table.externalRef),
    /**
     * One row per provider object, so an inbound transfer event maps to exactly
     * one row.
     *
     * `provider_object_id` is NULL for the whole window between our insert and
     * the provider call returning, and PostgreSQL treats NULLs as distinct — so
     * any number of unlinked transfers coexist, which is what is wanted here.
     * (`provider_events` needs the OPPOSITE and says `NULLS NOT DISTINCT`; the
     * two are different questions about the same-looking column.)
     */
    unique('transfers_provider_object_key').on(table.provider, table.providerObjectId),
    /** "What did this payment settle?" — the reconciliation read. */
    index('transfers_payment_intent_idx').on(table.paymentIntentId),
    index('transfers_connected_account_idx').on(table.connectedAccountId),
    foreignKey({
      name: 'transfers_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transfers_payment_intent_id_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transfers_connected_account_id_fkey',
      columns: [table.connectedAccountId],
      foreignColumns: [connectedAccounts.id],
    }).onDelete('restrict'),
    check('transfers_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('transfers_status_check', sql.raw(`status in (${inList(TRANSFER_STATUSES)})`)),
    check('transfers_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check('transfers_external_ref_check', sql`length(${table.externalRef}) > 0`),
    check('transfers_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check(
      'transfers_amount_reversed_check',
      sql.raw(`amount_reversed ~ '${BASE_UNIT_STRING_PATTERN}'`)
    ),
    /**
     * More cannot come back than went out.
     *
     * Compared as NUMERIC rather than as text, because these are canonical
     * integer strings and `'9' > '10'` lexically — which would let a reversal
     * of 9 pass against an amount of 10 and refuse a legitimate one of 10
     * against 100. The canonical form makes the cast total.
     */
    check(
      'transfers_reversed_within_amount_check',
      sql`${table.amountReversed}::numeric <= ${table.amount}::numeric`
    ),
    /**
     * A fully-reversed transfer has reversed everything, and a partially
     * reversed one has reversed SOMETHING but not everything.
     *
     * Stated structurally because `status` is derived: a writer that set the
     * status without the amount, or the amount without the status, would leave
     * a seller's balance disagreeing with the row that explains it.
     */
    check(
      'transfers_reversal_status_agrees_check',
      sql`(${table.status} <> 'reversed' or ${table.amountReversed}::numeric = ${table.amount}::numeric)
          and (${table.status} <> 'partially_reversed'
               or (${table.amountReversed}::numeric > 0
                   and ${table.amountReversed}::numeric < ${table.amount}::numeric))`
    ),
    /** A paid or reversed transfer HAS a provider object; a pending one may not yet. */
    check(
      'transfers_settled_has_provider_object_check',
      sql`${table.status} = 'pending' or ${table.status} = 'failed'
          or ${table.providerObjectId} is not null`
    ),
  ]
);
