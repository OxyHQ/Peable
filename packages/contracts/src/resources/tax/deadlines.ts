import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_DEADLINE_KINDS, TAX_DEADLINE_STATUSES } from '../../vocabulary/tax';
import { taxRuleSourceSchema, taxState } from './shared';

/**
 * A due date the rule set can compute. `filing_status` is `not_tracked`:
 * Peable files nothing, so it never claims a return was or was not filed.
 */
export const taxDeadlineSchema = defineObject(
  'tax.deadline',
  'TaxDeadline',
  z
    .object({
      object: z.literal('tax.deadline'),
      kind: z.enum(TAX_DEADLINE_KINDS),
      rule: z.string().describe('The rule that sets it.'),
      country: nullableString,
      state: taxState,
      period_start: unixSeconds.nullable(),
      period_end: unixSeconds.nullable(),
      due: unixSeconds,
      status: z.enum(TAX_DEADLINE_STATUSES),
      filing_status: z.literal('not_tracked'),
      description: z.string(),
      source: taxRuleSourceSchema,
    })
    .strict(),
);
export type TaxDeadline = Expand<z.output<typeof taxDeadlineSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.deadline': TaxDeadline;
  }
}

/** Where a deadline exists but the rule set cannot compute it, and why. */
export const taxDeadlineUnavailableSchema = defineComponent(
  'TaxDeadlineUnavailable',
  z
    .object({
      rule: nullableString,
      country: nullableString,
      state: taxState,
      reason: z.string(),
    })
    .strict(),
);
export type TaxDeadlineUnavailable = z.output<typeof taxDeadlineUnavailableSchema>;

/** A complete list (`has_more` is `false`), with what could not be computed beside it. */
export const taxDeadlineListSchema = defineComponent(
  'TaxDeadlineList',
  listOf(taxDeadlineSchema).extend({
    unavailable: z
      .array(taxDeadlineUnavailableSchema)
      .describe('Where a deadline exists but the rule set cannot compute it, and why.'),
  }),
);
export type TaxDeadlineList = Expand<z.output<typeof taxDeadlineListSchema>>;

export const taxDeadlineRoutes = [
  defineRoute({
    operationId: 'listTaxDeadlines',
    method: 'get',
    path: '/v1/tax/deadlines',
    tag: 'Tax compliance',
    summary: 'List tax deadlines',
    description:
      'Due dates the rule set computes from declared registrations and the latest assessment, soonest first.',
    auth: 'service',
    scope: 'payments:read',
    response: taxDeadlineListSchema,
    sdk: 'tax.compliance.listDeadlines',
  }),
] as const;
