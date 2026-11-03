import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { amount, currency, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_RULE_REVIEW_STATUSES, TAX_THRESHOLD_PERIODS, TAX_TYPES } from '../../vocabulary/tax';
import { taxCoverageLimitSchema, taxRuleSourceSchema, taxState } from './shared';

/**
 * The jurisdiction rule set (ADR 0020): versioned CODE, not data a request can
 * change. A version is immutable once published; an assessment stores the
 * version it ran under and replays through the same one. Only the rules listed
 * are supported; every other jurisdiction is `unsupported`, stated as such.
 */

export const taxRuleThresholdSchema = defineComponent(
  'TaxRuleThreshold',
  z
    .object({
      amount,
      currency,
      period: z.enum(TAX_THRESHOLD_PERIODS),
    })
    .strict(),
);

/**
 * One supported jurisdiction rule. `review.status` says whether a tax
 * professional has signed it off — an `unreviewed` rule's findings always go
 * to the review queue rather than standing on their own.
 */
export const taxJurisdictionRuleSchema = defineObject(
  'tax.jurisdiction_rule',
  'TaxJurisdictionRule',
  z
    .object({
      object: z.literal('tax.jurisdiction_rule'),
      id: z.string().describe('Stable, e.g. `eu_vat_b2c_cross_border`.'),
      rule_set_version: z.string(),
      name: z.string(),
      tax_type: z.enum(TAX_TYPES),
      countries: z.array(z.string()).describe('ISO 3166-1 alpha-2 codes the rule covers.'),
      state: taxState,
      effective_from: unixSeconds,
      threshold: taxRuleThresholdSchema.nullable(),
      sources: z.array(taxRuleSourceSchema),
      coverage_limits: z.array(taxCoverageLimitSchema),
      review: z.object({ status: z.enum(TAX_RULE_REVIEW_STATUSES), note: z.string() }).strict(),
    })
    .strict(),
);
export type TaxJurisdictionRule = Expand<z.output<typeof taxJurisdictionRuleSchema>>;

export const taxRuleSetSchema = defineObject(
  'tax.rule_set',
  'TaxRuleSet',
  z
    .object({
      object: z.literal('tax.rule_set'),
      version: z.string(),
      published: unixSeconds,
      rules: z.array(taxJurisdictionRuleSchema),
      unsupported: z
        .string()
        .describe('Everything not listed is `unsupported`, stated rather than implied.'),
    })
    .strict(),
);
export type TaxRuleSet = Expand<z.output<typeof taxRuleSetSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.jurisdiction_rule': TaxJurisdictionRule;
    'tax.rule_set': TaxRuleSet;
  }
}

export const taxRuleSetRoutes = [
  defineRoute({
    operationId: 'retrieveTaxRuleSet',
    method: 'get',
    path: '/v1/tax/rule_set',
    tag: 'Tax compliance',
    summary: 'Retrieve the current rule set',
    description: 'The rules assessments currently run under, with their sources and limits.',
    auth: 'service',
    scope: 'payments:read',
    response: taxRuleSetSchema,
    sdk: 'tax.compliance.retrieveRuleSet',
  }),
] as const;
