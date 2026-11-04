import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { queryUnixSeconds } from '../../common/params';
import { nullableString, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_COLLECTIONS, TAX_REGISTRATION_SCHEMES } from '../../vocabulary/tax';
import { taxCountry, taxState } from './shared';

/**
 * The Peable Tax summary report: totals per jurisdiction, registration, tax
 * type and rate — the lines a return (an OSS return, a state filing) is
 * prepared from. A report is not a filed return.
 */

/** One filing line. Reversals are netted in: `taxable_amount` and `tax_amount` are net. */
export const taxReportRowSchema = defineComponent(
  'TaxReportRow',
  z
    .object({
      country: taxCountry,
      state: taxState,
      registration_id: nullableString.describe('The registration (`taxreg_…`) that collected.'),
      scheme: z.enum(TAX_REGISTRATION_SCHEMES).nullable(),
      collection: z.enum(TAX_COLLECTIONS),
      tax_type: nullableString,
      rate_percentage: nullableString.describe('Decimal string, e.g. `"20.0"`.'),
      currency: z.string().describe('Uppercase ISO 4217.'),
      transactions: z.number().int().nonnegative(),
      reversals: z.number().int().nonnegative().describe('Reversals netted into this row.'),
      taxable_amount: signedAmount,
      tax_amount: signedAmount,
    })
    .strict(),
);
export type TaxReportRow = z.output<typeof taxReportRowSchema>;

export const taxReportSchema = defineObject(
  'tax.report',
  'TaxReport',
  z
    .object({
      object: z.literal('tax.report'),
      from: unixSeconds.describe('Inclusive.'),
      to: unixSeconds.describe('Exclusive.'),
      rows: z.array(taxReportRowSchema),
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.report',
        from: 1790812800,
        to: 1798761600,
        rows: [
          {
            country: 'DE',
            state: null,
            registration_id: 'taxreg_0193b8f2c1a87d3e9f4a',
            scheme: 'eu_oss_union',
            collection: 'collect',
            tax_type: 'vat',
            rate_percentage: '19.0',
            currency: 'EUR',
            transactions: 42,
            reversals: 1,
            taxable_amount: '41000',
            tax_amount: '7790',
          },
        ],
      },
    ],
  },
);
export type TaxReport = Expand<z.output<typeof taxReportSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.report': TaxReport;
  }
}

/** The filing window: `from` inclusive, `to` exclusive, Unix seconds. */
export const taxReportQuery = z
  .object({
    // Not `.describe()`d: a described copy would lose the integer spelling the
    // OpenAPI document gives `queryUnixSeconds`. The route says what they mean.
    from: queryUnixSeconds,
    to: queryUnixSeconds,
    format: z
      .enum(['json', 'csv'])
      .optional()
      .describe(
        '`csv` answers the rows as a `text/csv` attachment (a filing export) instead of JSON.',
      ),
  })
  .strict();
export type TaxReportParams = z.input<typeof taxReportQuery>;

export const taxReportRoutes = [
  defineRoute({
    operationId: 'retrieveTaxReportSummary',
    method: 'get',
    path: '/v1/tax/reports/summary',
    tag: 'Tax',
    summary: 'Summarize collected tax',
    description:
      'Totals per jurisdiction, registration, tax type and rate over `[from, to)` (Unix seconds, `from` inclusive, `to` exclusive, on `committed_at`), reversals netted in. With `format=csv`, the same rows as a `text/csv` attachment.',
    auth: 'service',
    scope: 'payments:read',
    query: taxReportQuery,
    response: taxReportSchema,
    sdk: 'tax.reports.summary',
  }),
] as const;
