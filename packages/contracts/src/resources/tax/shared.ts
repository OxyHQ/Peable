import { z } from 'zod';
import { defineComponent } from '../../common/objects';
import { unixSecondsParam } from '../../common/params';

/**
 * Building blocks every Peable Tax resource shares.
 *
 * Every tax amount — a calculation's, a transaction's, a reversal's, a report
 * row's, a compliance measure's — is a base-unit integer STRING of its
 * `currency`, as ADR 0014 D1 has it for every amount on the wire: `amount`
 * where it cannot be negative, `signedAmount` where a reversal makes it so
 * (a line item and its breakdown carry a reversal's negative share, and a
 * report row nets them in).
 */

/** ISO 3166-1 alpha-2, as returned. */
export const taxCountry = z.string().describe('ISO 3166-1 alpha-2.');

/** An ISO 3166-2 subdivision without its country prefix (`CA`, `QC`), as returned. */
export const taxState = z
  .string()
  .nullable()
  .describe('ISO 3166-2 subdivision without the country prefix (`CA`, `QC`).');

/** A Peable-side reference: a product, a customer, a refund. */
export const taxReferenceParam = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

/** An instant in a tax request body. */
export const taxInstantParam = unixSecondsParam;

/** An official source a rule rests on. */
export const taxRuleSourceSchema = defineComponent(
  'TaxRuleSource',
  z
    .object({
      title: z.string(),
      publisher: z.string(),
      url: z.string(),
    })
    .strict(),
);
export type TaxRuleSource = z.output<typeof taxRuleSourceSchema>;

/** What a rule cannot see or decide, stated rather than implied. */
export const taxCoverageLimitSchema = defineComponent(
  'TaxCoverageLimit',
  z.object({ code: z.string(), message: z.string() }).strict(),
);
export type TaxCoverageLimit = z.output<typeof taxCoverageLimitSchema>;

/** The facts a finding or a change rests on: field names, counts, ids — never personal data. */
export const taxFacts = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

// ── Business compliance request fields (ADR 0020) ────────────────────────────

/** A country in a compliance request. */
export const complianceCountryParam = z
  .string()
  .regex(/^[A-Z]{2}$/, 'a country is an ISO 3166-1 alpha-2 code');

/** A subdivision in a compliance request; `null` for the whole country. */
export const complianceStateParam = z
  .string()
  .regex(/^[A-Z0-9]{1,3}$/, 'a state is its ISO 3166-2 subdivision code')
  .nullable();

/** Free text in a compliance request: trimmed, never empty (`null` clears it). */
export const complianceTextParam = (max: number) => z.string().trim().min(1).max(max).nullable();

/** An id another compliance object is linked by (`taxrd_…`, `taxreg_…`, `file_…`). */
export const complianceIdParam = z.string().min(1).max(64);
