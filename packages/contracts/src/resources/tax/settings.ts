import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  TAX_BEHAVIORS,
  TAX_CALCULATION_ACCOUNTS,
  TAX_SETTINGS_STATUSES,
} from '../../vocabulary/tax';
import { taxCountry } from './shared';

/**
 * Peable Tax settings (ADR 0011): the seller's legal identity and defaults, and
 * whether the owner has approved collection. Changed and approved by the owner
 * in Orbit only; the merchant API reads them.
 */

/** An address as Peable Tax stores it: only `country` is always present. */
export const taxAddressSchema = defineComponent(
  'TaxAddress',
  z
    .object({
      country: taxCountry,
      state: z
        .string()
        .nullable()
        .optional()
        .describe('ISO 3166-2 subdivision without the country prefix (`CA`, `QC`).'),
      postal_code: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      line1: z.string().nullable().optional(),
      line2: z.string().nullable().optional(),
    })
    .strict(),
);
export type TaxAddress = z.output<typeof taxAddressSchema>;

const addressLine = z.string().trim().min(1).max(200).nullish();

/** An address in a tax request. */
export const taxAddressParams = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    state: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .nullish(),
    postal_code: z.string().trim().min(1).max(20).nullish(),
    city: addressLine,
    line1: addressLine,
    line2: addressLine,
  })
  .strict();
export type TaxAddressParams = z.input<typeof taxAddressParams>;

export const taxSettingsSchema = defineObject(
  'tax.settings',
  'TaxSettings',
  z
    .object({
      object: z.literal('tax.settings'),
      merchant_id: z.string().describe('The merchant (`merch_…`) these settings belong to.'),
      status: z
        .enum(TAX_SETTINGS_STATUSES)
        .describe('`active` once the owner approved; any edit returns it to `draft`.'),
      legal_name: nullableString,
      head_office: taxAddressSchema.nullable(),
      default_tax_code: z.string().describe('The `txcd_…` a line without its own code uses.'),
      default_tax_behavior: z.enum(TAX_BEHAVIORS),
      calculation_account: z
        .enum(TAX_CALCULATION_ACCOUNTS)
        .describe(
          "`platform`: Peable's own provider account (official Oxy applications only). `none`: registered sales cannot be calculated and fail closed.",
        ),
      provider: nullableString.describe(
        'The provider that calculates registered sales, when one is reachable.',
      ),
      approved_at: unixSeconds.nullable(),
      approved_by: nullableString.describe('The Oxy user who approved collection.'),
      updated_at: unixSeconds.nullable(),
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.settings',
        merchant_id: 'merch_0193b8f2c1a87d3e9f4a',
        status: 'active',
        legal_name: 'Example Software SL',
        head_office: { country: 'ES', state: null, postal_code: '08001', city: 'Barcelona' },
        default_tax_code: 'txcd_10103001',
        default_tax_behavior: 'exclusive',
        calculation_account: 'platform',
        provider: 'stripe_tax',
        approved_at: 1793750400,
        approved_by: 'user_42',
        updated_at: 1793750400,
      },
    ],
  },
);
export type TaxSettings = Expand<z.output<typeof taxSettingsSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.settings': TaxSettings;
  }
}

/** Orbit's settings update (the owner's, never the merchant API's). Any change returns the settings to `draft`. */
export const updateTaxSettingsParams = z
  .object({
    legal_name: z.string().trim().min(1).max(200).nullable().optional(),
    head_office: taxAddressParams.nullable().optional(),
    default_tax_code: z.string().optional(),
    default_tax_behavior: z.enum(TAX_BEHAVIORS).optional(),
  })
  .strict();
export type UpdateTaxSettingsParams = z.input<typeof updateTaxSettingsParams>;

export const taxSettingsRoutes = [
  defineRoute({
    operationId: 'retrieveTaxSettings',
    method: 'get',
    path: '/v1/tax/settings',
    tag: 'Tax',
    summary: 'Retrieve tax settings',
    description:
      'Settings are changed, and collection approved, by the owner in Orbit. Until approved, `POST /v1/tax/calculations` refuses with `tax_settings_not_active`.',
    auth: 'service',
    scope: 'payments:read',
    response: taxSettingsSchema,
    sdk: 'tax.retrieveSettings',
  }),
] as const;
