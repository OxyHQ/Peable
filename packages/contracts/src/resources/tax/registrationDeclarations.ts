import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  TAX_FILING_FREQUENCIES,
  TAX_REGISTRATION_DECLARATION_STATUSES,
  TAX_REGISTRATION_SCHEMES,
} from '../../vocabulary/tax';
import {
  complianceCountryParam,
  complianceIdParam,
  complianceStateParam,
  complianceTextParam,
  taxCountry,
  taxInstantParam,
  taxState,
} from './shared';

/** No authority integration confirms anything yet: every declaration is `unverified`. */
export const taxDeclarationVerificationSchema = defineComponent(
  'TaxRegistrationDeclarationVerification',
  z
    .object({
      status: z.literal('unverified'),
      reason: z.literal('no_authority_integration'),
    })
    .strict(),
);

/**
 * A declared registration status (`taxrd_…`): where the business stands with a
 * tax authority, IN ITS OWN WORDS. Storing one is NOT registration with a
 * government, and it never makes Peable collect: collection needs a Peable Tax
 * registration (`taxreg_…`) the owner approved.
 */
export const taxRegistrationDeclarationSchema = defineObject(
  'tax.registration_declaration',
  'TaxRegistrationDeclaration',
  z
    .object({
      object: z.literal('tax.registration_declaration'),
      id: z.string().describe('`taxrd_…`.'),
      livemode,
      country: taxCountry,
      state: taxState,
      scheme: z
        .enum(TAX_REGISTRATION_SCHEMES)
        .nullable()
        .describe('The scheme, when the owner knows it; `null` for `unknown`.'),
      status: z.enum(TAX_REGISTRATION_DECLARATION_STATUSES),
      effective_from: unixSeconds.nullable(),
      effective_to: unixSeconds.nullable(),
      filing_frequency: z.enum(TAX_FILING_FREQUENCIES),
      collection_registration: nullableString.describe(
        'The Peable Tax collection registration (`taxreg_…`) it corresponds to, when there is one.',
      ),
      verification: taxDeclarationVerificationSchema,
      note: nullableString,
      metadata,
      created: unixSeconds,
      updated: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.registration_declaration',
        id: 'taxrd_0193b8f2c1a87d3e9f4a',
        livemode: false,
        country: 'ES',
        state: null,
        scheme: 'eu_oss_union',
        status: 'registered',
        effective_from: 1767225600,
        effective_to: null,
        filing_frequency: 'quarterly',
        collection_registration: 'taxreg_0193b8f2c1a87d3e9f4a',
        verification: { status: 'unverified', reason: 'no_authority_integration' },
        note: null,
        metadata: {},
        created: 1793750400,
        updated: 1793750400,
      },
    ],
  },
);
export type TaxRegistrationDeclaration = Expand<z.output<typeof taxRegistrationDeclarationSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.registration_declaration': TaxRegistrationDeclaration;
  }
}

const declarationFields = {
  scheme: z.enum(TAX_REGISTRATION_SCHEMES).nullable().optional(),
  status: z.enum(TAX_REGISTRATION_DECLARATION_STATUSES),
  effective_from: taxInstantParam.nullable().optional(),
  effective_to: taxInstantParam.nullable().optional(),
  filing_frequency: z.enum(TAX_FILING_FREQUENCIES).optional(),
  collection_registration: complianceIdParam.nullable().optional(),
  note: complianceTextParam(1000).optional(),
};

/** Orbit's new declaration (the owner's). */
export const createTaxRegistrationDeclarationParams = z
  .object({
    country: complianceCountryParam,
    state: complianceStateParam.optional(),
    ...declarationFields,
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateTaxRegistrationDeclarationParams = z.input<
  typeof createTaxRegistrationDeclarationParams
>;

/** Orbit's update (the owner's): the place is fixed; `metadata` is a patch. */
export const updateTaxRegistrationDeclarationParams = z
  .object({
    ...declarationFields,
    status: declarationFields.status.optional(),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateTaxRegistrationDeclarationParams = z.input<
  typeof updateTaxRegistrationDeclarationParams
>;

export const listTaxRegistrationDeclarationsQuery = listQuery({});
export type ListTaxRegistrationDeclarationsParams = z.input<
  typeof listTaxRegistrationDeclarationsQuery
>;

export const taxRegistrationDeclarationRoutes = [
  defineRoute({
    operationId: 'listTaxRegistrationDeclarations',
    method: 'get',
    path: '/v1/tax/registration_declarations',
    tag: 'Tax compliance',
    summary: 'List registration declarations',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxRegistrationDeclarationsQuery,
    response: listOf(taxRegistrationDeclarationSchema),
    sdk: 'tax.compliance.listRegistrationDeclarations',
    expandable: 'tax.registration_declaration',
  }),
  defineRoute({
    operationId: 'retrieveTaxRegistrationDeclaration',
    method: 'get',
    path: '/v1/tax/registration_declarations/{id}',
    tag: 'Tax compliance',
    summary: 'Retrieve a registration declaration',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The declaration (`taxrd_…`).' },
    query: expandOnlyQuery,
    response: taxRegistrationDeclarationSchema,
    sdk: 'tax.compliance.retrieveRegistrationDeclaration',
    expandable: 'tax.registration_declaration',
  }),
] as const;
