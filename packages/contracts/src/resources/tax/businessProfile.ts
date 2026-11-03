import { z } from 'zod';
import { defineObject, type Expand } from '../../common/objects';
import { metadataUpdateParam } from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_CUSTOMER_TYPES, TAX_LEGAL_ENTITY_TYPES, TAX_SUPPLY_TYPES } from '../../vocabulary/tax';
import { complianceCountryParam, complianceStateParam } from './shared';

/**
 * Peable Tax business compliance (ADR 0020): what a business tells Peable
 * about itself, what Peable works out from it against a VERSIONED rule set
 * (an assessment), and what needs a person's decision (the review queue).
 * Nothing here registers, files or pays anything with a government, and
 * nothing here turns tax collection on: that is still the owner's registration
 * plus approval (ADR 0011). The merchant API reads it and may run an
 * assessment; every onboarding fact and decision is the owner's, in Orbit.
 */

/**
 * The business behind a merchant. Deliberately carries NO government
 * identifier (company number, EIN): none is evidence of a tax obligation and
 * none is needed by any rule in the supported set.
 */
export const taxBusinessProfileSchema = defineObject(
  'tax.business_profile',
  'TaxBusinessProfile',
  z
    .object({
      object: z.literal('tax.business_profile'),
      livemode,
      legal_name: nullableString.describe(
        'Read from the tax settings, where editing it returns collection to draft.',
      ),
      entity_type: z
        .enum(TAX_LEGAL_ENTITY_TYPES)
        .describe('`unknown` is an answer: the owner does not know yet.'),
      incorporation_country: nullableString.describe(
        'ISO 3166-1 alpha-2, or `null` while not given. Never evidence of registration.',
      ),
      incorporation_state: nullableString,
      fiscal_year_end_month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .nullable()
        .describe('1–12, the month the fiscal year ends in.'),
      customer_types: z.enum(TAX_CUSTOMER_TYPES),
      supply_types: z.array(z.enum(TAX_SUPPLY_TYPES)),
      missing: z
        .array(z.string())
        .describe(
          'What onboarding still lacks before an assessment can be complete: `legal_name`, `entity_type`, `customer_types`, `establishment`, `sales_destinations`.',
        ),
      metadata,
      updated_by: nullableString,
      updated: unixSeconds.nullable(),
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.business_profile',
        livemode: false,
        legal_name: 'Example Software SL',
        entity_type: 'limited_liability_company',
        incorporation_country: 'ES',
        incorporation_state: null,
        fiscal_year_end_month: 12,
        customer_types: 'both',
        supply_types: ['software_as_a_service'],
        missing: [],
        metadata: {},
        updated_by: 'user_42',
        updated: 1793750400,
      },
    ],
  },
);
export type TaxBusinessProfile = Expand<z.output<typeof taxBusinessProfileSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.business_profile': TaxBusinessProfile;
  }
}

/** Orbit's profile update (the owner's); `metadata` is a patch. */
export const updateTaxBusinessProfileParams = z
  .object({
    entity_type: z.enum(TAX_LEGAL_ENTITY_TYPES).optional(),
    incorporation_country: complianceCountryParam.nullable().optional(),
    incorporation_state: complianceStateParam.optional(),
    fiscal_year_end_month: z.number().int().min(1).max(12).nullable().optional(),
    customer_types: z.enum(TAX_CUSTOMER_TYPES).optional(),
    supply_types: z
      .array(z.enum(TAX_SUPPLY_TYPES))
      .max(TAX_SUPPLY_TYPES.length)
      .refine((list) => new Set(list).size === list.length, 'supply_types must be distinct')
      .optional(),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateTaxBusinessProfileParams = z.input<typeof updateTaxBusinessProfileParams>;

export const taxBusinessProfileRoutes = [
  defineRoute({
    operationId: 'retrieveTaxBusinessProfile',
    method: 'get',
    path: '/v1/tax/business_profile',
    tag: 'Tax compliance',
    summary: 'Retrieve the business profile',
    description: 'Changed by the owner in Orbit; a service credential records no onboarding fact.',
    auth: 'service',
    scope: 'payments:read',
    response: taxBusinessProfileSchema,
    sdk: 'tax.compliance.retrieveBusinessProfile',
  }),
] as const;
