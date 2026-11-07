import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  queryBoolean,
} from '../../common/params';
import { livemode, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  RADAR_EVALUATION_PHASES,
  RADAR_LIMITS,
  RADAR_RULE_ACTIONS,
  REVIEW_CLOSED_REASONS,
  REVIEW_OPENED_REASONS,
  REVIEW_REASONS,
  REVIEW_REFUSAL_REASONS,
} from '../../vocabulary/radar';

/**
 * Risk rules and reviews (ADR 0022) — Stripe Radar's rules, Orbit-native: a
 * merchant's `allow` / `block` / `review` rules over a closed set of facts,
 * judged on CARD payments before and after authorization, and the review queue
 * they feed. FairCoin payments never consult them.
 */

/** A rule as it was when it decided: what an evaluation, an outcome and a review name. */
export const radarRuleReferenceSchema = defineComponent(
  'RadarRuleReference',
  z
    .object({
      id: z.string().describe('The rule (`rule_…`).'),
      action: z.enum(RADAR_RULE_ACTIONS),
      predicate: z.string(),
      version: z.number().int().describe('The version of the rule that matched.'),
    })
    .strict(),
);
export type RadarRuleReference = z.output<typeof radarRuleReferenceSchema>;

export const radarRuleSchema = defineObject(
  'radar.rule',
  'RadarRule',
  z
    .object({
      id: z.string(),
      object: z.literal('radar.rule'),
      livemode,
      action: z
        .enum(RADAR_RULE_ACTIONS)
        .describe('What a match does. Precedence: `allow` beats `block` beats `review`.'),
      predicate: z
        .string()
        .describe(
          "The condition, in Radar's language: `:amount: > 100000 and :card_country: not in ('US', 'CA')`.",
        ),
      description: nullableString,
      enabled: z.boolean(),
      version: z
        .number()
        .int()
        .describe('Moves on every change of `action` or `predicate`; evaluations name it.'),
      created: unixSeconds,
      updated: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'rule_0193b8f2c1a87d3e9f4a',
        object: 'radar.rule',
        livemode: false,
        action: 'block',
        predicate:
          ":currency: = 'EUR' and :amount: > 100000 and :card_country: not in ('ES', 'FR')",
        description: 'Large euro payments from cards issued outside our markets',
        enabled: true,
        version: 1,
        created: 1793750400,
        updated: 1793750400,
      },
    ],
  },
);
export type RadarRule = Expand<z.output<typeof radarRuleSchema>>;

/** What `DELETE /v1/radar/rules/{id}` answers. Evaluations keep the rule as it was. */
export const deletedRadarRuleSchema = defineComponent('DeletedRadarRule', deletedOf('radar.rule'));
export type DeletedRadarRule = z.output<typeof deletedRadarRuleSchema>;

export const radarEvaluationSchema = defineObject(
  'radar.evaluation',
  'RadarEvaluation',
  z
    .object({
      id: z.string(),
      object: z.literal('radar.evaluation'),
      livemode,
      payment_intent: expandable(
        'payment_intent',
        '`pi_…`, or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      phase: z
        .enum(RADAR_EVALUATION_PHASES)
        .describe(
          '`pre_authorization`: before the provider was asked (a confirm, or handing out the payer credential). `post_authorization`: once, when the charge was first read.',
        ),
      decision: z.enum(RADAR_RULE_ACTIONS).describe('What the rule set decided.'),
      rule: radarRuleReferenceSchema.describe('The rule that decided, as it was.'),
      facts: z
        .record(z.string(), z.union([z.string(), z.null()]))
        .describe(
          'The values of the facts that rule names when it was judged (integers as base-10 strings); `null` is unknown.',
        ),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'reval_0193b8f2c1a87d3e9f4a',
        object: 'radar.evaluation',
        livemode: false,
        payment_intent: 'pi_0193b8f2c1a87d3e9f4a',
        phase: 'pre_authorization',
        decision: 'block',
        rule: {
          id: 'rule_0193b8f2c1a87d3e9f4a',
          action: 'block',
          predicate: ':amount: > 100000',
          version: 1,
        },
        facts: { amount: '250000' },
        created: 1793750400,
      },
    ],
  },
);
export type RadarEvaluation = Expand<z.output<typeof radarEvaluationSchema>>;

export const reviewSchema = defineObject(
  'review',
  'Review',
  z
    .object({
      id: z.string(),
      object: z.literal('review'),
      livemode,
      open: z.boolean(),
      reason: z
        .enum(REVIEW_REASONS)
        .describe('Why it is open (`rule`), or, once closed, why it closed.'),
      opened_reason: z.enum(REVIEW_OPENED_REASONS),
      closed_reason: z.enum(REVIEW_CLOSED_REASONS).nullable(),
      payment_intent: expandable(
        'payment_intent',
        '`pi_…`, or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      charge: expandable('charge', '`ch_…`, or the Charge with `expand[]=charge`.').nullable(),
      rule: radarRuleReferenceSchema.nullable().describe('The rule that opened it, as it was.'),
      created: unixSeconds,
      closed_at: unixSeconds.nullable(),
    })
    .strict(),
  {
    examples: [
      {
        id: 'prv_0193b8f2c1a87d3e9f4a',
        object: 'review',
        livemode: false,
        open: true,
        reason: 'rule',
        opened_reason: 'rule',
        closed_reason: null,
        payment_intent: 'pi_0193b8f2c1a87d3e9f4a',
        charge: 'ch_0193b8f2c1a87d3e9f4a',
        rule: {
          id: 'rule_0193b8f2c1a87d3e9f4a',
          action: 'review',
          predicate: ":risk_level: = 'elevated'",
          version: 2,
        },
        created: 1793750400,
        closed_at: null,
      },
    ],
  },
);
export type Review = Expand<z.output<typeof reviewSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'radar.rule': RadarRule;
    'radar.evaluation': RadarEvaluation;
    review: Review;
  }
}

const predicate = z
  .string()
  .min(1)
  .max(RADAR_LIMITS.predicateMax)
  .describe("Radar's language over the fact registry; see the risk rules guide.");
const description = z.string().max(RADAR_LIMITS.descriptionMax);

export const createRadarRuleParams = z
  .object({
    action: z.enum(RADAR_RULE_ACTIONS),
    predicate,
    description: description.min(1).optional(),
    enabled: z.boolean().optional().describe('Default `true`.'),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateRadarRuleParams = z.input<typeof createRadarRuleParams>;

export const updateRadarRuleParams = z
  .object({
    action: z.enum(RADAR_RULE_ACTIONS).optional(),
    predicate: predicate.optional(),
    description: description.optional().describe('`""` clears it.'),
    enabled: z.boolean().optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateRadarRuleParams = z.input<typeof updateRadarRuleParams>;

export const listRadarRulesQuery = listQuery({
  action: z.enum(RADAR_RULE_ACTIONS).optional(),
  enabled: queryBoolean.optional(),
});
export type RadarRuleListParams = z.input<typeof listRadarRulesQuery>;

export const listRadarEvaluationsQuery = listQuery({
  payment_intent: idParam.optional().describe("Only this payment's evaluations (`pi_…`)."),
});
export type RadarEvaluationListParams = z.input<typeof listRadarEvaluationsQuery>;

export const listReviewsQuery = listQuery({
  open: queryBoolean.optional().describe('Only open (`true`) or closed (`false`) reviews.'),
});
export type ReviewListParams = z.input<typeof listReviewsQuery>;

export const approveReviewParams = z.object({ expand: expandParam.optional() }).strict();
export type ApproveReviewParams = z.input<typeof approveReviewParams>;

export const refuseReviewParams = z
  .object({
    reason: z
      .enum(REVIEW_REFUSAL_REASONS)
      .optional()
      .describe('`fraudulent` closes it `refunded_as_fraud` when the payment was captured.'),
    expand: expandParam.optional(),
  })
  .strict();
export type RefuseReviewParams = z.input<typeof refuseReviewParams>;

const ruleId = { id: 'The rule (`rule_…`).' };
const reviewId = { id: 'The review (`prv_…`).' };

export const radarRoutes = [
  defineRoute({
    operationId: 'createRadarRule',
    method: 'post',
    path: '/v1/radar/rules',
    tag: 'Risk rules',
    summary: 'Create a risk rule',
    description:
      'Parsed and checked against the fact registry: a predicate that does not parse is a 400 with `param: predicate` and the position.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createRadarRuleParams,
    response: radarRuleSchema,
    sdk: 'radar.rules.create',
    expandable: 'radar.rule',
  }),
  defineRoute({
    operationId: 'listRadarRules',
    method: 'get',
    path: '/v1/radar/rules',
    tag: 'Risk rules',
    summary: 'List risk rules',
    auth: 'service',
    scope: 'payments:read',
    query: listRadarRulesQuery,
    response: listOf(radarRuleSchema),
    sdk: 'radar.rules.list',
    expandable: 'radar.rule',
  }),
  defineRoute({
    operationId: 'retrieveRadarRule',
    method: 'get',
    path: '/v1/radar/rules/{id}',
    tag: 'Risk rules',
    summary: 'Retrieve a risk rule',
    auth: 'service',
    scope: 'payments:read',
    params: ruleId,
    query: expandOnlyQuery,
    response: radarRuleSchema,
    sdk: 'radar.rules.retrieve',
    expandable: 'radar.rule',
  }),
  defineRoute({
    operationId: 'updateRadarRule',
    method: 'post',
    path: '/v1/radar/rules/{id}',
    tag: 'Risk rules',
    summary: 'Update a risk rule',
    description:
      'A new `action` or `predicate` is a new `version`; `enabled` and `description` are not.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: ruleId,
    body: updateRadarRuleParams,
    response: radarRuleSchema,
    sdk: 'radar.rules.update',
    expandable: 'radar.rule',
  }),
  defineRoute({
    operationId: 'deleteRadarRule',
    method: 'delete',
    path: '/v1/radar/rules/{id}',
    tag: 'Risk rules',
    summary: 'Delete a risk rule',
    description: 'Evaluations and reviews keep the rule as it was when it decided.',
    auth: 'service',
    scope: 'payments:write',
    params: ruleId,
    response: deletedRadarRuleSchema,
    sdk: 'radar.rules.del',
  }),
  defineRoute({
    operationId: 'listRadarEvaluations',
    method: 'get',
    path: '/v1/radar/evaluations',
    tag: 'Risk rules',
    summary: 'List rule evaluations',
    description:
      'Every evaluation in which a rule matched: which rule, its version and the facts it named.',
    auth: 'service',
    scope: 'payments:read',
    query: listRadarEvaluationsQuery,
    response: listOf(radarEvaluationSchema),
    sdk: 'radar.evaluations.list',
    expandable: 'radar.evaluation',
  }),
  defineRoute({
    operationId: 'listReviews',
    method: 'get',
    path: '/v1/reviews',
    tag: 'Reviews',
    summary: 'List reviews',
    auth: 'service',
    scope: 'payments:read',
    query: listReviewsQuery,
    response: listOf(reviewSchema),
    sdk: 'reviews.list',
    expandable: 'review',
  }),
  defineRoute({
    operationId: 'retrieveReview',
    method: 'get',
    path: '/v1/reviews/{id}',
    tag: 'Reviews',
    summary: 'Retrieve a review',
    auth: 'service',
    scope: 'payments:read',
    params: reviewId,
    query: expandOnlyQuery,
    response: reviewSchema,
    sdk: 'reviews.retrieve',
    expandable: 'review',
  }),
  defineRoute({
    operationId: 'approveReview',
    method: 'post',
    path: '/v1/reviews/{id}/approve',
    tag: 'Reviews',
    summary: 'Approve a review',
    description: 'Closes it `approved`; a held capture may proceed.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: reviewId,
    body: approveReviewParams,
    response: reviewSchema,
    sdk: 'reviews.approve',
    expandable: 'review',
  }),
  defineRoute({
    operationId: 'refuseReview',
    method: 'post',
    path: '/v1/reviews/{id}/refuse',
    tag: 'Reviews',
    summary: 'Refuse a review',
    description:
      'Releases an uncaptured authorization (`canceled`) or refunds a captured payment in full (`refunded`, `refunded_as_fraud`).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: reviewId,
    body: refuseReviewParams,
    response: reviewSchema,
    sdk: 'reviews.refuse',
    expandable: 'review',
  }),
] as const;
