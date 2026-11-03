import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { listQuery } from '../../common/params';
import { livemode, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_ACTOR_TYPES } from '../../vocabulary/tax';
import { taxFacts } from './shared';

/** One recorded compliance change (`taxact_…`), written in the transaction of the change itself. */
export const taxComplianceActionSchema = defineObject(
  'tax.compliance_action',
  'TaxComplianceAction',
  z
    .object({
      object: z.literal('tax.compliance_action'),
      id: z.string().describe('`taxact_…`.'),
      livemode,
      action: z.string().describe('e.g. `business_profile.updated`, `review_item.resolved`.'),
      actor: z.object({ type: z.enum(TAX_ACTOR_TYPES), id: nullableString }).strict(),
      object_type: z.string(),
      object_id: nullableString,
      details: taxFacts.describe(
        'Field names and statuses that changed — never the values of a document or a number.',
      ),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.compliance_action',
        id: 'taxact_0193b8f2c1a87d3e9f4a',
        livemode: false,
        action: 'review_item.resolved',
        actor: { type: 'user', id: 'user_42' },
        object_type: 'tax.review_item',
        object_id: 'taxrev_0193b8f2c1a87d3e9f4a',
        details: { decision: 'will_register' },
        created: 1793750400,
      },
    ],
  },
);
export type TaxComplianceAction = Expand<z.output<typeof taxComplianceActionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.compliance_action': TaxComplianceAction;
  }
}

export const listTaxComplianceActionsQuery = listQuery({});
export type ListTaxComplianceActionsParams = z.input<typeof listTaxComplianceActionsQuery>;

export const taxComplianceActionRoutes = [
  defineRoute({
    operationId: 'listTaxComplianceActions',
    method: 'get',
    path: '/v1/tax/compliance_actions',
    tag: 'Tax compliance',
    summary: 'List compliance actions',
    description: 'The history of every compliance change, newest first.',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxComplianceActionsQuery,
    response: listOf(taxComplianceActionSchema),
    sdk: 'tax.compliance.listActions',
    expandable: 'tax.compliance_action',
  }),
] as const;
