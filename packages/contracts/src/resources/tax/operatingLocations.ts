import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_OPERATING_LOCATION_KINDS } from '../../vocabulary/tax';
import {
  complianceCountryParam,
  complianceStateParam,
  complianceTextParam,
  taxCountry,
  taxInstantParam,
  taxState,
} from './shared';

/**
 * Where the business ACTUALLY operates (`taxol_…`). `head_office` and
 * `fixed_establishment` are the owner's statement of establishment (the EU
 * rule reads them); any location in a US state is physical presence there.
 */
export const taxOperatingLocationSchema = defineObject(
  'tax.operating_location',
  'TaxOperatingLocation',
  z
    .object({
      object: z.literal('tax.operating_location'),
      id: z.string().describe('`taxol_…`.'),
      livemode,
      kind: z.enum(TAX_OPERATING_LOCATION_KINDS),
      country: taxCountry,
      state: taxState,
      description: nullableString,
      started: unixSeconds.nullable(),
      ended: unixSeconds.nullable().describe('Set once the business no longer operates there.'),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.operating_location',
        id: 'taxol_0193b8f2c1a87d3e9f4a',
        livemode: false,
        kind: 'head_office',
        country: 'ES',
        state: null,
        description: 'Registered office, Barcelona',
        started: 1735689600,
        ended: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type TaxOperatingLocation = Expand<z.output<typeof taxOperatingLocationSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.operating_location': TaxOperatingLocation;
  }
}

/** Orbit's new operating location (the owner's). */
export const createTaxOperatingLocationParams = z
  .object({
    kind: z.enum(TAX_OPERATING_LOCATION_KINDS),
    country: complianceCountryParam,
    state: complianceStateParam.optional(),
    description: complianceTextParam(500).optional(),
    started: taxInstantParam.nullable().optional(),
    ended: taxInstantParam.nullable().optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateTaxOperatingLocationParams = z.input<typeof createTaxOperatingLocationParams>;

/** Orbit's update (the owner's): `kind` and the place are fixed; `metadata` is a patch. */
export const updateTaxOperatingLocationParams = z
  .object({
    description: complianceTextParam(500).optional(),
    started: taxInstantParam.nullable().optional(),
    ended: taxInstantParam.nullable().optional(),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateTaxOperatingLocationParams = z.input<typeof updateTaxOperatingLocationParams>;

export const listTaxOperatingLocationsQuery = listQuery({});
export type ListTaxOperatingLocationsParams = z.input<typeof listTaxOperatingLocationsQuery>;

export const taxOperatingLocationRoutes = [
  defineRoute({
    operationId: 'listTaxOperatingLocations',
    method: 'get',
    path: '/v1/tax/operating_locations',
    tag: 'Tax compliance',
    summary: 'List operating locations',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxOperatingLocationsQuery,
    response: listOf(taxOperatingLocationSchema),
    sdk: 'tax.compliance.listOperatingLocations',
    expandable: 'tax.operating_location',
  }),
  defineRoute({
    operationId: 'retrieveTaxOperatingLocation',
    method: 'get',
    path: '/v1/tax/operating_locations/{id}',
    tag: 'Tax compliance',
    summary: 'Retrieve an operating location',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The operating location (`taxol_…`).' },
    query: expandOnlyQuery,
    response: taxOperatingLocationSchema,
    sdk: 'tax.compliance.retrieveOperatingLocation',
    expandable: 'tax.operating_location',
  }),
] as const;
