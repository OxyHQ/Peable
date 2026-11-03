import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent } from '../../common/objects';
import { defineRoute } from '../../route';

/** A product tax code Peable accepts (`txcd_…`, Stripe Tax's ids). */
export const taxCodeSchema = defineComponent(
  'TaxCode',
  z
    .object({
      id: z.string().describe('`txcd_…`.'),
      name: z.string(),
      description: z.string(),
    })
    .strict(),
  {
    examples: [
      {
        id: 'txcd_10103001',
        name: 'Software as a service (SaaS) - business use',
        description: 'Hosted software accessed online, sold to businesses for business use.',
      },
    ],
  },
);
export type TaxCode = z.output<typeof taxCodeSchema>;

export const taxCodeRoutes = [
  defineRoute({
    operationId: 'listTaxCodes',
    method: 'get',
    path: '/v1/tax/codes',
    tag: 'Tax',
    summary: 'List tax codes',
    description: 'Every product tax code Peable accepts: a complete list, `has_more` is `false`.',
    auth: 'service',
    scope: 'payments:read',
    response: listOf(taxCodeSchema),
    sdk: 'tax.listCodes',
  }),
] as const;
