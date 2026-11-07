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
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { paymentIntents } from './payments';
import {
  RADAR_EVALUATION_PHASES,
  RADAR_LIMITS,
  RADAR_RULE_ACTIONS,
  REVIEW_CLOSED_REASONS,
  REVIEW_OPENED_REASONS,
} from './valueSets';

/**
 * A merchant's risk rules (`rule_…`, ADR 0022): data, never code. The
 * predicate is stored as the merchant wrote it and compiled at evaluation
 * against the closed fact registry (`services/radar/language.ts`); it never
 * reaches SQL. `version` moves with `action` or `predicate`, so an evaluation
 * and a review can name the rule AS IT WAS. A merchant row is one mode
 * (ADR 0017): the test and live rule sets are different merchants' rows.
 *
 * Deleted rules are deleted: what decided a payment is copied onto the
 * evaluation and the review, not referenced.
 */
export const radarRules = pgTable(
  'radar_rules',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    action: text().notNull(),
    predicate: text().notNull(),
    description: text(),
    enabled: boolean().notNull().default(true),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('radar_rules_public_id_key').on(table.publicId),
    foreignKey({
      name: 'radar_rules_merchant_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    /** The list walk and the evaluator's read of the merchant's rules. */
    index('radar_rules_merchant_id_id_idx').on(table.merchantId, table.id),
    check('radar_rules_action_check', sql.raw(`action in (${inList(RADAR_RULE_ACTIONS)})`)),
    check(
      'radar_rules_predicate_length_check',
      sql.raw(`length(predicate) between 1 and ${String(RADAR_LIMITS.predicateMax)}`),
    ),
    check(
      'radar_rules_description_length_check',
      sql.raw(
        `description is null or length(description) between 1 and ${String(RADAR_LIMITS.descriptionMax)}`,
      ),
    ),
    check('radar_rules_version_check', sql`${table.version} >= 1`),
  ],
);

/**
 * One evaluation in which a rule matched (`reval_…`): the phase, the decision,
 * the deciding rule as it was, and ONLY the facts that rule names — the
 * explanation of a decline or a review (ADR 0022 D4). Facts are strings
 * (integers in base 10) or null for unknown.
 */
export const radarEvaluations = pgTable(
  'radar_evaluations',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    paymentIntentId: text().notNull(),
    phase: text().notNull(),
    /** The deciding rule's action, which is the decision. */
    decision: text().notNull(),
    ruleId: text().notNull(),
    ruleVersion: integer().notNull(),
    rulePredicate: text().notNull(),
    facts: jsonb().$type<Record<string, string | null>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('radar_evaluations_public_id_key').on(table.publicId),
    foreignKey({
      name: 'radar_evaluations_merchant_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'radar_evaluations_payment_intent_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    index('radar_evaluations_merchant_id_id_idx').on(table.merchantId, table.id),
    index('radar_evaluations_payment_intent_id_idx').on(table.paymentIntentId),
    check(
      'radar_evaluations_phase_check',
      sql.raw(`phase in (${inList(RADAR_EVALUATION_PHASES)})`),
    ),
    check(
      'radar_evaluations_decision_check',
      sql.raw(`decision in (${inList(RADAR_RULE_ACTIONS)})`),
    ),
    check('radar_evaluations_facts_object_check', sql`jsonb_typeof(${table.facts}) = 'object'`),
  ],
);

/**
 * A review (`prv_…`, Stripe's Review): ONE per card payment, opened by a rule
 * after authorization (ADR 0022 D5). Open while `closed_reason` is null.
 *
 * `pending_closed_reason` is a refusal's CLAIM: set by a CAS on an open review
 * with no live claim, it serialises a refusal (which acts at the provider
 * before it can close) against an approval and a second refusal. The claim is
 * a lease (`pending_closed_until`); a refund still pending holds it until the
 * refund succeeds (the review closes) or fails (the claim is let go).
 */
export const reviews = pgTable(
  'reviews',
  {
    id: generatedId(),
    publicId: text().notNull(),
    merchantId: text().notNull(),
    paymentIntentId: text().notNull(),
    openedReason: text().notNull().default('rule'),
    closedReason: text(),
    pendingClosedReason: text(),
    /**
     * Until when a refusal's claim holds: a lease, so a refusal that crashed
     * between its claim and the provider does not lock the review for ever.
     * NULL with a claim: held until the refund it started settles.
     */
    pendingClosedUntil: timestamptz(),
    ruleId: text(),
    ruleVersion: integer(),
    ruleAction: text(),
    rulePredicate: text(),
    createdAt: createdAt(),
    closedAt: timestamptz(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('reviews_public_id_key').on(table.publicId),
    unique('reviews_payment_intent_id_key').on(table.paymentIntentId),
    foreignKey({
      name: 'reviews_merchant_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reviews_payment_intent_fkey',
      columns: [table.paymentIntentId],
      foreignColumns: [paymentIntents.id],
    }).onDelete('restrict'),
    index('reviews_merchant_id_id_idx').on(table.merchantId, table.id),
    check(
      'reviews_opened_reason_check',
      sql.raw(`opened_reason in (${inList(REVIEW_OPENED_REASONS)})`),
    ),
    check(
      'reviews_closed_reason_check',
      sql.raw(`closed_reason is null or closed_reason in (${inList(REVIEW_CLOSED_REASONS)})`),
    ),
    check(
      'reviews_pending_closed_reason_check',
      sql.raw(
        `pending_closed_reason is null or pending_closed_reason in (${inList(REVIEW_CLOSED_REASONS)})`,
      ),
    ),
    /** Closed ⇔ when; a closed review holds no pending claim; a lease needs a claim. */
    check(
      'reviews_closed_shape_check',
      sql`(${table.closedReason} is null) = (${table.closedAt} is null) and (${table.closedReason} is null or ${table.pendingClosedReason} is null) and (${table.pendingClosedUntil} is null or ${table.pendingClosedReason} is not null)`,
    ),
    /** The rule is all four or none. */
    check(
      'reviews_rule_shape_check',
      sql`(${table.ruleId} is null) = (${table.ruleVersion} is null) and (${table.ruleId} is null) = (${table.ruleAction} is null) and (${table.ruleId} is null) = (${table.rulePredicate} is null)`,
    ),
  ],
);
