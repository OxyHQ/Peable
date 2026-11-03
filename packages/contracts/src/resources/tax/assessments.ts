import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, listQuery } from '../../common/params';
import {
  amount,
  currency,
  livemode,
  nullableString,
  signedAmount,
  unixSeconds,
} from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_OBLIGATION_OUTCOMES, TAX_TYPES } from '../../vocabulary/tax';
import {
  taxCoverageLimitSchema,
  taxFacts,
  taxInstantParam,
  taxRuleSourceSchema,
  taxState,
} from './shared';

/**
 * An assessment (`taxasm_…`, ADR 0020): the recorded facts judged against a
 * VERSIONED rule set at one instant. It stores the version and its exact
 * inputs, so `replay` can re-run them and show the same answer. Every finding
 * goes to the review queue for a person to decide; none activates collection.
 */

export const taxAssessmentReasonSchema = defineComponent(
  'TaxAssessmentReason',
  z
    .object({
      code: z.string(),
      message: z.string(),
      evidence: taxFacts.describe(
        'The facts the reason rests on — amounts, counts, ids. Never personal data.',
      ),
    })
    .strict(),
);
export type TaxAssessmentReason = z.output<typeof taxAssessmentReasonSchema>;

/** Net sales measured against a rule's threshold. */
export const taxAssessmentMeasuredSchema = defineComponent(
  'TaxAssessmentMeasured',
  z
    .object({
      amount: signedAmount.describe('Net sales in `currency`: reversals are netted in.'),
      currency,
      transactions: z.number().int().nonnegative(),
      from: unixSeconds,
      to: unixSeconds,
      excluded_currencies: z
        .array(z.string())
        .describe('Sales in other currencies: counted nowhere, named here.'),
    })
    .strict(),
);

export const taxAssessmentResultSchema = defineComponent(
  'TaxAssessmentResult',
  z
    .object({
      rule: nullableString.describe('The rule applied, or `null` for an unsupported jurisdiction.'),
      country: nullableString,
      state: taxState,
      tax_type: z.enum(TAX_TYPES).nullable(),
      outcome: z.enum(TAX_OBLIGATION_OUTCOMES),
      reasons: z.array(taxAssessmentReasonSchema),
      measured: taxAssessmentMeasuredSchema
        .nullable()
        .describe('Net sales measured against the threshold, when the rule has one.'),
      threshold: z.object({ amount, currency }).strict().nullable(),
      deadline: z
        .object({
          kind: z.literal('registration'),
          due: unixSeconds,
          source: taxRuleSourceSchema,
        })
        .strict()
        .nullable()
        .describe('A deadline the rule itself sets (a Texas permit after crossing).'),
      coverage_limits: z.array(taxCoverageLimitSchema),
      review_items: z
        .array(z.string())
        .describe('The review items (`taxrev_…`) this result opened or kept open.'),
    })
    .strict(),
);
export type TaxAssessmentResult = z.output<typeof taxAssessmentResultSchema>;

const outcomeCount = z.number().int().nonnegative();

export const taxAssessmentSchema = defineObject(
  'tax.assessment',
  'TaxAssessment',
  z
    .object({
      object: z.literal('tax.assessment'),
      id: z.string().describe('`taxasm_…`.'),
      livemode,
      rule_set_version: z.string(),
      as_of: unixSeconds.describe('The instant the facts were judged at.'),
      inputs_digest: z
        .string()
        .describe('SHA-256 of the canonical inputs — what a replay is checked against.'),
      results: z.array(taxAssessmentResultSchema),
      summary: z
        .object({
          registration_declared: outcomeCount,
          likely_required: outcomeCount,
          approaching_threshold: outcomeCount,
          not_indicated: outcomeCount,
          uncertain: outcomeCount,
          unsupported: outcomeCount,
        })
        .strict()
        .describe('How many results have each outcome.'),
      created_by: z.object({ type: z.enum(['user', 'service']), id: nullableString }).strict(),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.assessment',
        id: 'taxasm_0193b8f2c1a87d3e9f4a',
        livemode: false,
        rule_set_version: '2026-11-03.1',
        as_of: 1793750400,
        inputs_digest: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        results: [
          {
            rule: 'us_tx_sales_tax',
            country: 'US',
            state: 'TX',
            tax_type: 'sales_tax',
            outcome: 'approaching_threshold',
            reasons: [
              {
                code: 'approaching_threshold',
                message: 'Texas revenue is at or above 80% of the safe-harbor threshold.',
                evidence: { measured_minor: '41000000', threshold_minor: '50000000' },
              },
            ],
            measured: {
              amount: '41000000',
              currency: 'USD',
              transactions: 812,
              from: 1762041600,
              to: 1793577600,
              excluded_currencies: [],
            },
            threshold: { amount: '50000000', currency: 'USD' },
            deadline: null,
            coverage_limits: [],
            review_items: ['taxrev_0193b8f2c1a87d3e9f4a'],
          },
        ],
        summary: {
          registration_declared: 0,
          likely_required: 0,
          approaching_threshold: 1,
          not_indicated: 0,
          uncertain: 0,
          unsupported: 0,
        },
        created_by: { type: 'service', id: 'app_42' },
        created: 1793750400,
      },
    ],
  },
);
export type TaxAssessment = Expand<z.output<typeof taxAssessmentSchema>>;

/** Re-running a stored assessment's inputs through its own rule set version. */
export const taxAssessmentReplaySchema = defineObject(
  'tax.assessment_replay',
  'TaxAssessmentReplay',
  z
    .object({
      object: z.literal('tax.assessment_replay'),
      assessment: z.string().describe('The assessment replayed (`taxasm_…`).'),
      rule_set_version: z.string(),
      inputs_digest: z.string(),
      matches: z
        .boolean()
        .describe('`true` when the replayed results are identical to the stored ones.'),
      results: z
        .array(taxAssessmentResultSchema)
        .describe('A replay opens no review items: every `review_items` is empty.'),
    })
    .strict(),
);
export type TaxAssessmentReplay = Expand<z.output<typeof taxAssessmentReplaySchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.assessment': TaxAssessment;
    'tax.assessment_replay': TaxAssessmentReplay;
  }
}

export const createTaxAssessmentParams = z
  .object({
    as_of: taxInstantParam.optional().describe('Unix seconds; default now. Never in the future.'),
  })
  .strict();
export type CreateTaxAssessmentParams = z.input<typeof createTaxAssessmentParams>;

export const listTaxAssessmentsQuery = listQuery({});
export type ListTaxAssessmentsParams = z.input<typeof listTaxAssessmentsQuery>;

export const taxAssessmentRoutes = [
  defineRoute({
    operationId: 'listTaxAssessments',
    method: 'get',
    path: '/v1/tax/assessments',
    tag: 'Tax compliance',
    summary: 'List assessments',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxAssessmentsQuery,
    response: listOf(taxAssessmentSchema),
    sdk: 'tax.compliance.listAssessments',
    expandable: 'tax.assessment',
  }),
  defineRoute({
    operationId: 'createTaxAssessment',
    method: 'post',
    path: '/v1/tax/assessments',
    tag: 'Tax compliance',
    summary: 'Run an assessment',
    description:
      'Judges the recorded facts against the current rule set, opening review items for what needs a person. Activates nothing.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createTaxAssessmentParams,
    response: taxAssessmentSchema,
    sdk: 'tax.compliance.createAssessment',
  }),
  defineRoute({
    operationId: 'retrieveTaxAssessment',
    method: 'get',
    path: '/v1/tax/assessments/{id}',
    tag: 'Tax compliance',
    summary: 'Retrieve an assessment',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The assessment (`taxasm_…`).' },
    query: expandOnlyQuery,
    response: taxAssessmentSchema,
    sdk: 'tax.compliance.retrieveAssessment',
    expandable: 'tax.assessment',
  }),
  defineRoute({
    operationId: 'replayTaxAssessment',
    method: 'get',
    path: '/v1/tax/assessments/{id}/replay',
    tag: 'Tax compliance',
    summary: 'Replay an assessment',
    description:
      "Re-runs the stored inputs through the assessment's own rule set version; `matches` says whether the answer is the same.",
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The assessment (`taxasm_…`).' },
    response: taxAssessmentReplaySchema,
    sdk: 'tax.compliance.replayAssessment',
  }),
] as const;
