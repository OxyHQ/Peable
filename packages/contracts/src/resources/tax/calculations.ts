import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { livemode, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_BEHAVIORS, TAX_COLLECTIONS } from '../../vocabulary/tax';
import { taxCountry, taxMinorAmount, taxReferenceParam, taxState } from './shared';

/**
 * A tax calculation (`taxcalc_…`, ADR 0011): a frozen answer. Peable decides
 * whether a registration covers the customer's evidenced location and asks
 * the provider for the amount only when one does; the answer is stored exactly
 * as given and never recomputed.
 */

export const taxBreakdownEntrySchema = defineComponent(
  'TaxBreakdownEntry',
  z
    .object({
      country: taxCountry,
      state: taxState,
      level: nullableString.describe('The jurisdiction level (`country`, `state`, …).'),
      display_name: nullableString,
      tax_type: nullableString.describe('`vat`, `sales_tax`, …; `null` when no tax is imposed.'),
      rate_percentage: nullableString.describe(
        'Decimal string, e.g. `"20.0"`; `null` when no tax is imposed.',
      ),
      taxable_amount: taxMinorAmount,
      amount: taxMinorAmount,
      inclusive: z.boolean(),
      taxability_reason: z
        .string()
        .describe(
          "The provider's reason, or Peable's own `not_registered` / `product_nontaxable`.",
        ),
    })
    .strict(),
);
export type TaxBreakdownEntry = z.output<typeof taxBreakdownEntrySchema>;

export const taxCalculationLineItemSchema = defineComponent(
  'TaxCalculationLineItem',
  z
    .object({
      reference: z.string(),
      quantity: z.number().int(),
      tax_code: z.string(),
      tax_behavior: z.enum(TAX_BEHAVIORS),
      amount: taxMinorAmount.describe('As given: includes tax when inclusive.'),
      amount_tax: taxMinorAmount,
      amount_net: taxMinorAmount.describe('Excluding tax.'),
      breakdown: z.array(taxBreakdownEntrySchema),
    })
    .strict(),
);
export type TaxCalculationLineItem = z.output<typeof taxCalculationLineItemSchema>;

export const taxCalculationSchema = defineObject(
  'tax.calculation',
  'TaxCalculation',
  z
    .object({
      object: z.literal('tax.calculation'),
      id: z.string().describe('`taxcalc_…`.'),
      currency: z.string().describe('Uppercase ISO 4217.'),
      collection: z
        .enum(TAX_COLLECTIONS)
        .describe(
          'Why the tax is what it is: `collect` (a registration covers the customer and the provider calculated), `not_registered` (none does: zero tax, recorded as such), `nontaxable` (every line used the nontaxable code).',
        ),
      registration_id: nullableString.describe('The registration (`taxreg_…`) that collects.'),
      provider: nullableString,
      provider_calculation_ref: nullableString,
      customer_location_evidence_id: z.string().describe('`taxloc_…`.'),
      country: taxCountry,
      state: taxState,
      amount_total: taxMinorAmount.describe('What the customer pays.'),
      amount_net: taxMinorAmount,
      tax_amount_exclusive: taxMinorAmount,
      tax_amount_inclusive: taxMinorAmount,
      line_items: z.array(taxCalculationLineItemSchema),
      tax_date: unixSeconds,
      created: unixSeconds,
      expires_at: unixSeconds,
      livemode,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.calculation',
        id: 'taxcalc_0193b8f2c1a87d3e9f4a',
        currency: 'EUR',
        collection: 'collect',
        registration_id: 'taxreg_0193b8f2c1a87d3e9f4a',
        provider: 'stripe_tax',
        provider_calculation_ref: 'taxcalc_1QxYz2AbCdEf',
        customer_location_evidence_id: 'taxloc_0193b8f2c1a87d3e9f4a',
        country: 'DE',
        state: null,
        amount_total: 1190,
        amount_net: 1000,
        tax_amount_exclusive: 190,
        tax_amount_inclusive: 0,
        line_items: [
          {
            reference: 'plan_pro_monthly',
            quantity: 1,
            tax_code: 'txcd_10103001',
            tax_behavior: 'exclusive',
            amount: 1000,
            amount_tax: 190,
            amount_net: 1000,
            breakdown: [
              {
                country: 'DE',
                state: null,
                level: 'country',
                display_name: 'VAT',
                tax_type: 'vat',
                rate_percentage: '19.0',
                taxable_amount: 1000,
                amount: 190,
                inclusive: false,
                taxability_reason: 'standard_rated',
              },
            ],
          },
        ],
        tax_date: 1793750400,
        created: 1793750400,
        expires_at: 1793836800,
        livemode: false,
      },
    ],
  },
);
export type TaxCalculation = Expand<z.output<typeof taxCalculationSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.calculation': TaxCalculation;
  }
}

export const taxLineItemParams = z
  .object({
    reference: z.string().min(1).max(200),
    amount: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .describe('Unit amount × quantity, minor units. Includes tax when inclusive.'),
    quantity: z.number().int().positive().max(1_000_000).optional(),
    tax_code: z
      .string()
      .optional()
      .describe("Defaults to the product's tax code, then the merchant's default."),
    tax_behavior: z
      .enum(TAX_BEHAVIORS)
      .optional()
      .describe("Defaults to the merchant's default tax behavior."),
  })
  .strict();
export type TaxLineItemParams = z.input<typeof taxLineItemParams>;

export const createTaxCalculationParams = z
  .object({
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    customer_location_evidence_id: taxReferenceParam.describe(
      'Sufficient, unexpired evidence (`taxloc_…`).',
    ),
    line_items: z
      .array(taxLineItemParams)
      .min(1)
      .max(100)
      .refine(
        (lines) => new Set(lines.map((line) => line.reference)).size === lines.length,
        'Line references must be unique',
      ),
  })
  .strict();
export type CreateTaxCalculationParams = z.input<typeof createTaxCalculationParams>;

export const taxCalculationRoutes = [
  defineRoute({
    operationId: 'createTaxCalculation',
    method: 'post',
    path: '/v1/tax/calculations',
    tag: 'Tax',
    summary: 'Calculate tax',
    description:
      'Calculate and freeze. Refused with `tax_settings_not_active` until the owner approves; a covered sale the provider cannot price fails closed (`tax_calculation_unavailable`), never zero.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createTaxCalculationParams,
    response: taxCalculationSchema,
    status: 201,
    sdk: 'tax.calculations.create',
  }),
  defineRoute({
    operationId: 'retrieveTaxCalculation',
    method: 'get',
    path: '/v1/tax/calculations/{id}',
    tag: 'Tax',
    summary: 'Retrieve a tax calculation',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The calculation (`taxcalc_…`).' },
    response: taxCalculationSchema,
    sdk: 'tax.calculations.retrieve',
  }),
] as const;
