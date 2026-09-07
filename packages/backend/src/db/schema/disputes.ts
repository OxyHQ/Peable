import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  BASE_UNIT_STRING_PATTERN,
  CURRENCY_CODES,
  DISPUTE_STATUSES,
  PROVIDER_IDS,
} from './valueSets';

/**
 * A cardholder contesting a payment, and the network holding the money.
 *
 * ## The direction is inverted from every other money table here
 *
 * `refunds`, `transfers` and `payment_intents` are all things the gateway
 * DECIDES to create: a merchant asks, a row is written, a provider is called.
 * Nobody asks for a dispute. It arrives as an event about a decision the card
 * network already took, and the gateway's job is to record it faithfully and
 * tell the merchant in time to respond.
 *
 * That inversion decides the idempotency. `refunds` converges on
 * `(merchant, external_ref)` — the merchant's own id, which they cannot lose —
 * because refunding twice sends a payer their money twice and nothing reverses
 * it. There is no such id here and there cannot be: the merchant did not
 * initiate this, so `(provider, provider_object_id)` is the only key, and it is
 * the network's. A redelivered `charge.dispute.created` converges on it.
 *
 * It also decides what a missing row means. `handleRefundEvent` treats "no
 * refund row for this provider object" as `unmatched` and retries, because
 * Peable writes the row BEFORE calling the provider, so absence means the write
 * has not landed yet. Here absence is the NORMAL first state — Peable never
 * writes a dispute in advance — so the handler CREATES rather than waits.
 *
 * ## Not a payment-intent status
 *
 * A dispute is the network's process running alongside the payment, not a stage
 * of it: the payment was `settled` when the dispute opened and may still be
 * `settled` when it closes, whatever the outcome. Giving `PaymentIntentStatus`
 * a `disputed` member would mean widening the published contract, the `ALLOWED`
 * transition table, `LEGAL_SOURCES` and a CHECK, to express something these
 * rows already say — and it would make "settled, then disputed, then settled
 * again" a round trip through the state machine rather than a fact about a
 * separate object. Stripe models it the same way: a Charge is `disputed`; a
 * PaymentIntent has no such status.
 *
 * The merchant hears about it through `payment_intent.disputed` and
 * `payment_intent.dispute_closed`, and reads the detail from these rows.
 *
 * ## `amount` is what is being HELD, not what was paid
 *
 * A dispute can contest part of a payment, and the disputed amount is what the
 * network withholds. It is therefore not derivable from the intent and has to
 * be stored — the same reason `refunds.amount` exists rather than a boolean.
 */
export const disputes = pgTable(
  'disputes',
  {
    id: generatedId(),
    /** The `dp_…` the API returns. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    paymentIntentId: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull(),
    status: text().notNull().default('needs_response'),
    provider: text().notNull(),
    /**
     * The network's own dispute id. NOT NULL, unlike `refunds.providerObjectId`.
     *
     * The refund column is nullable because a refund row exists before its
     * provider call returns. A dispute row is only ever created FROM a provider
     * event that already carries the id, so there is no window in which it is
     * unknown — and making it nullable would leave the unique index below
     * unable to dedupe the redelivery it exists for.
     */
    providerObjectId: text().notNull(),
    /**
     * The network's stated reason, verbatim and unmapped.
     *
     * Deliberately NOT a closed value set. Reason codes are the one part of a
     * dispute a merchant argues against, they differ per network and per card
     * scheme, and they change without notice — a CHECK here would refuse a real
     * dispute in production the first time a scheme added a code. The STATUS is
     * ours and closed; the reason is theirs and open.
     */
    reason: text(),
    /** When the network stops accepting evidence. Absent once closed. */
    evidenceDueAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('disputes_public_id_key').on(table.publicId),
    /**
     * ONE row per network dispute. The whole idempotency of this table.
     *
     * A redelivered `charge.dispute.created` — which the provider WILL send,
     * since receipt is acknowledged before processing — converges here instead
     * of enqueueing the merchant a second `payment_intent.disputed` for one
     * dispute. There is no merchant-supplied key to fall back on.
     */
    unique('disputes_provider_object_key').on(table.provider, table.providerObjectId),
    /** "What is being contested on this payment?" */
    index('disputes_payment_intent_idx').on(table.paymentIntentId),
    /** The operator read: everything still owed a response, oldest deadline first. */
    index('disputes_evidence_due_idx').on(table.evidenceDueAt),
    foreignKey({
      name: 'disputes_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'disputes_payment_intent_id_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    check('disputes_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    check('disputes_status_check', sql.raw(`status in (${inList(DISPUTE_STATUSES)})`)),
    check('disputes_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check('disputes_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    /**
     * A dispute over nothing is not a dispute.
     *
     * The pattern above accepts `'0'`, which is legitimate for a cumulative
     * total like `transfers.amount_reversed` and is not legitimate here: a
     * zero-amount dispute would occupy the network's dispute id with a row that
     * describes no money, and the real one could never be created.
     */
    check('disputes_amount_positive_check', sql`${table.amount}::numeric > 0`),
    /**
     * A CLOSED dispute has no deadline left to meet.
     *
     * Checked rather than assumed because the two halves are written by
     * different events — `created` sets the deadline, `closed` sets the
     * outcome — and an update that changed the status without clearing the
     * deadline would leave an operator queue permanently showing a dispute that
     * needs a response it can no longer give.
     */
    check(
      'disputes_closed_has_no_deadline_check',
      sql`${table.status} not in ('won', 'lost') or ${table.evidenceDueAt} is null`
    ),
  ]
);
