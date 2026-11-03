import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { files } from './files';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  BASE_UNIT_STRING_PATTERN,
  CURRENCY_CODES,
  DISPUTE_FILE_EVIDENCE_FIELDS,
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
 * The merchant hears about it through `charge.dispute.*` events, and reads the
 * detail from these rows.
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
    /**
     * When the merchant's response was SUBMITTED to the network, if it was.
     *
     * The timestamp and nothing else. The evidence itself — a customer's name,
     * their email, a billing address, correspondence — is forwarded to the
     * provider and never stored: `provider_events`' whole redaction posture
     * exists because this gateway does not keep that class of data, and a
     * dispute response is the single richest example of it this system ever
     * handles.
     *
     * What a merchant needs from this table afterwards is whether they
     * responded and when, which is what an operator asks too. What the response
     * SAID is at the acquirer, readable by someone with their own authorization
     * — the same split `redactProviderPayload` makes for everything else.
     *
     * Also the idempotency: submitting is one-way at the network, so a second
     * attempt is refused by reading this rather than by asking the provider.
     */
    evidenceSubmittedAt: timestamptz(),
    /**
     * Whether evidence has been STAGED — the provider's own answer
     * (`evidence_details.has_evidence`) after the last draft, recorded as a
     * boolean. The draft itself lives at the provider and only there: the
     * provider is the store of a response in progress, and this gateway keeps
     * the fact that one exists, never its words.
     */
    hasEvidence: boolean().notNull().default(false),
    /** The provider's `is_charge_refundable`, as its last event or answer said. */
    isChargeRefundable: boolean().notNull().default(false),
    /** The merchant's own bookkeeping (Stripe's limits, ADR 0014 D1). */
    metadata: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('disputes_public_id_key').on(table.publicId),
    /** The target of `dispute_evidence_files`' same-merchant reference. */
    unique('disputes_id_merchant_id_key').on(table.id, table.merchantId),
    check('disputes_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
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
      sql`${table.status} not in ('won', 'lost') or ${table.evidenceDueAt} is null`,
    ),
    /**
     * The operator read this exists for: what is still owed a response.
     *
     * PARTIAL, and it replaced a plain index on the same column. That one was
     * written for this exact query before `evidence_submitted_at` existed —
     * with no way to record an answer, "has a deadline" WAS "still owed a
     * response". Once answering became possible the plain index was strictly
     * worse for the only query either served: it carries every dispute ever
     * opened, including the answered and the closed, so the scan reads rows the
     * predicate then throws away. Keeping both would have meant two indexes
     * maintained on every dispute write and one of them never chosen.
     */
    index('disputes_unanswered_idx')
      .on(table.evidenceDueAt)
      .where(sql`${table.evidenceSubmittedAt} is null`),
  ],
);

/**
 * The FILES a merchant attached to a dispute's response — one per evidence
 * field, by id only (`file_…`). The text evidence is not here and never is: a
 * draft lives at the provider, and a submission is forwarded and forgotten.
 *
 * A file's BYTES go to the provider at submission time and only then
 * (`services/disputeEvidence.ts`); the provider's own file ids are not kept,
 * because nothing here ever needs to name them again.
 *
 * The composite references make the two rules structural: the dispute and the
 * file belong to the SAME merchant, and the file's purpose is
 * `dispute_evidence` — a merchant cannot attach another merchant's upload, nor
 * submit their identity document to a card network by naming its id.
 */
export const disputeEvidenceFiles = pgTable(
  'dispute_evidence_files',
  {
    disputeId: text().notNull(),
    merchantId: text().notNull(),
    field: text().notNull(),
    fileId: text().notNull(),
    /** Always `dispute_evidence`: the purpose half of the file reference. */
    filePurpose: text().notNull().default('dispute_evidence'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'dispute_evidence_files_pkey',
      columns: [table.disputeId, table.field],
    }),
    index('dispute_evidence_files_file_id_idx').on(table.fileId),
    foreignKey({
      name: 'dispute_evidence_files_dispute_fkey',
      columns: [table.disputeId, table.merchantId],
      foreignColumns: [disputes.id, disputes.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'dispute_evidence_files_file_fkey',
      columns: [table.fileId, table.merchantId, table.filePurpose],
      foreignColumns: [files.id, files.merchantId, files.purpose],
    }).onDelete('restrict'),
    check(
      'dispute_evidence_files_field_check',
      sql.raw(`field in (${inList(DISPUTE_FILE_EVIDENCE_FIELDS)})`),
    ),
    check('dispute_evidence_files_purpose_check', sql`${table.filePurpose} = 'dispute_evidence'`),
  ],
);
