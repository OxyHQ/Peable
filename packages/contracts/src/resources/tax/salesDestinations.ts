import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_CUSTOMER_TYPES } from '../../vocabulary/tax';
import {
  complianceCountryParam,
  complianceStateParam,
  taxCountry,
  taxInstantParam,
  taxState,
} from './shared';

/**
 * Where the business SAYS it sells (`taxdest_…`). Actual sales come from Peable
 * Tax transactions; an assessment compares the two.
 */
export const taxSalesDestinationSchema = defineObject(
  'tax.sales_destination',
  'TaxSalesDestination',
  z
    .object({
      object: z.literal('tax.sales_destination'),
      id: z.string().describe('`taxdest_…`.'),
      livemode,
      country: taxCountry,
      state: taxState,
      customer_types: z.enum(TAX_CUSTOMER_TYPES),
      started: unixSeconds.nullable(),
      ended: unixSeconds.nullable(),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.sales_destination',
        id: 'taxdest_0193b8f2c1a87d3e9f4a',
        livemode: false,
        country: 'US',
        state: 'TX',
        customer_types: 'consumers',
        started: 1767225600,
        ended: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type TaxSalesDestination = Expand<z.output<typeof taxSalesDestinationSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.sales_destination': TaxSalesDestination;
  }
}

/** Orbit's new sales destination (the owner's). */
export const createTaxSalesDestinationParams = z
  .object({
    country: complianceCountryParam,
    state: complianceStateParam.optional(),
    customer_types: z.enum(TAX_CUSTOMER_TYPES).optional(),
    started: taxInstantParam.nullable().optional(),
    ended: taxInstantParam.nullable().optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateTaxSalesDestinationParams = z.input<typeof createTaxSalesDestinationParams>;

/** Orbit's update (the owner's): the place is fixed; `metadata` is a patch. */
export const updateTaxSalesDestinationParams = z
  .object({
    customer_types: z.enum(TAX_CUSTOMER_TYPES).optional(),
    started: taxInstantParam.nullable().optional(),
    ended: taxInstantParam.nullable().optional(),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateTaxSalesDestinationParams = z.input<typeof updateTaxSalesDestinationParams>;

export const listTaxSalesDestinationsQuery = listQuery({});
export type ListTaxSalesDestinationsParams = z.input<typeof listTaxSalesDestinationsQuery>;

export const taxSalesDestinationRoutes = [
  defineRoute({
    operationId: 'listTaxSalesDestinations',
    method: 'get',
    path: '/v1/tax/sales_destinations',
    tag: 'Tax compliance',
    summary: 'List sales destinations',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxSalesDestinationsQuery,
    response: listOf(taxSalesDestinationSchema),
    sdk: 'tax.compliance.listSalesDestinations',
    expandable: 'tax.sales_destination',
  }),
  defineRoute({
    operationId: 'retrieveTaxSalesDestination',
    method: 'get',
    path: '/v1/tax/sales_destinations/{id}',
    tag: 'Tax compliance',
    summary: 'Retrieve a sales destination',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The sales destination (`taxdest_…`).' },
    query: expandOnlyQuery,
    response: taxSalesDestinationSchema,
    sdk: 'tax.compliance.retrieveSalesDestination',
    expandable: 'tax.sales_destination',
  }),
] as const;
