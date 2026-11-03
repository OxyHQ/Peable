import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, listQuery } from '../../common/params';
import { livemode, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  TAX_REVIEW_DECISIONS,
  TAX_REVIEW_ITEM_STATUSES,
  TAX_REVIEW_SEVERITIES,
} from '../../vocabulary/tax';
import { complianceTextParam, taxState } from './shared';

/** The owner's recorded decision, with who and when. */
export const taxReviewDecisionSchema = defineComponent(
  'TaxReviewDecision',
  z
    .object({
      decision: z.enum(TAX_REVIEW_DECISIONS),
      note: nullableString,
      decided_by: z.string().describe('The Oxy user who decided.'),
      decided_at: unixSeconds,
    })
    .strict(),
);

/**
 * A finding that needs a person (`taxrev_…`): opened by an assessment, kept
 * open while later ones find it again, and closed only by the owner's
 * decision in Orbit. No decision activates collection.
 */
export const taxReviewItemSchema = defineObject(
  'tax.review_item',
  'TaxReviewItem',
  z
    .object({
      object: z.literal('tax.review_item'),
      id: z.string().describe('`taxrev_…`.'),
      livemode,
      code: z
        .string()
        .describe('Machine reason, e.g. `threshold_exceeded`, `registration_status_unknown`.'),
      severity: z.enum(TAX_REVIEW_SEVERITIES),
      status: z.enum(TAX_REVIEW_ITEM_STATUSES),
      rule: nullableString,
      country: nullableString,
      state: taxState,
      message: z.string(),
      first_assessment: nullableString.describe('The assessment (`taxasm_…`) that opened it.'),
      latest_assessment: nullableString.describe(
        'The latest assessment (`taxasm_…`) that found it again.',
      ),
      decision: taxReviewDecisionSchema.nullable(),
      created: unixSeconds,
      updated: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.review_item',
        id: 'taxrev_0193b8f2c1a87d3e9f4a',
        livemode: false,
        code: 'threshold_approaching',
        severity: 'review',
        status: 'open',
        rule: 'us_tx_sales_tax',
        country: 'US',
        state: 'TX',
        message: 'Texas revenue is at or above 80% of the safe-harbor threshold.',
        first_assessment: 'taxasm_0193b8f2c1a87d3e9f4a',
        latest_assessment: 'taxasm_0193b8f2c1a87d3e9f4a',
        decision: null,
        created: 1793750400,
        updated: 1793750400,
      },
    ],
  },
);
export type TaxReviewItem = Expand<z.output<typeof taxReviewItemSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.review_item': TaxReviewItem;
  }
}

/** Orbit's decision on an open item (the owner's, never a service credential's). */
export const resolveTaxReviewItemParams = z
  .object({
    decision: z.enum(TAX_REVIEW_DECISIONS),
    note: complianceTextParam(1000)
      .optional()
      .describe("Required for `not_required` and `accepted_risk`: the owner's reason."),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.decision === 'not_required' || input.decision === 'accepted_risk') && !input.note)
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: `a ${input.decision} decision records the owner's reason in note`,
      });
  });
export type ResolveTaxReviewItemParams = z.input<typeof resolveTaxReviewItemParams>;

export const listTaxReviewItemsQuery = listQuery({
  status: z.enum(TAX_REVIEW_ITEM_STATUSES).optional().describe('Only items in this status.'),
});
export type ListTaxReviewItemsParams = z.input<typeof listTaxReviewItemsQuery>;

export const taxReviewItemRoutes = [
  defineRoute({
    operationId: 'listTaxReviewItems',
    method: 'get',
    path: '/v1/tax/review_items',
    tag: 'Tax compliance',
    summary: 'List review items',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxReviewItemsQuery,
    response: listOf(taxReviewItemSchema),
    sdk: 'tax.compliance.listReviewItems',
    expandable: 'tax.review_item',
  }),
  defineRoute({
    operationId: 'retrieveTaxReviewItem',
    method: 'get',
    path: '/v1/tax/review_items/{id}',
    tag: 'Tax compliance',
    summary: 'Retrieve a review item',
    description: "Deciding an item is the owner's, in Orbit; a service credential only reads it.",
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The review item (`taxrev_…`).' },
    query: expandOnlyQuery,
    response: taxReviewItemSchema,
    sdk: 'tax.compliance.retrieveReviewItem',
    expandable: 'tax.review_item',
  }),
] as const;
