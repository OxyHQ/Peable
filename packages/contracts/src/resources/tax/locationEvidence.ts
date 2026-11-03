import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_EVIDENCE_STATUSES, TAX_LOCATION_EVIDENCE_TYPES } from '../../vocabulary/tax';
import { taxAddressParams } from './settings';
import { taxCountry, taxReferenceParam, taxState } from './shared';

/**
 * Customer location evidence (`taxloc_…`, ADR 0011): what places a customer
 * in a jurisdiction, judged against that jurisdiction's own rule. There is
 * deliberately no language, currency, locale or timezone evidence. An IP
 * address is never stored; at most its salted hash.
 */

/** An item as judged: the place it points at, never more of the customer than the rule needs. */
export const taxLocationEvidenceResultItemSchema = defineComponent(
  'TaxLocationEvidenceResultItem',
  z
    .object({
      type: z.enum(TAX_LOCATION_EVIDENCE_TYPES),
      country: taxCountry,
      state: taxState,
    })
    .strict(),
);

export const taxLocationEvidenceSchema = defineObject(
  'tax.location_evidence',
  'TaxLocationEvidence',
  z
    .object({
      object: z.literal('tax.location_evidence'),
      id: z.string().describe('`taxloc_…`.'),
      customer_ref: z.string().describe('The customer this evidence is about.'),
      status: z
        .enum(TAX_EVIDENCE_STATUSES)
        .describe('Only `sufficient` evidence can be calculated against.'),
      rule: z
        .string()
        .describe(
          'The jurisdiction rule applied: `eu_digital_two_items`, `gb_digital_two_items`, `us_billing_address`, `ca_billing_address`, `default_one_item`, or `none` when no item names a country.',
        ),
      country: taxCountry
        .nullable()
        .describe('Where the evidence places the customer, when it does.'),
      state: taxState,
      items: z.array(taxLocationEvidenceResultItemSchema),
      observed_at: unixSeconds,
      expires_at: unixSeconds.describe('Evidence stays usable for a day.'),
      livemode,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.location_evidence',
        id: 'taxloc_0193b8f2c1a87d3e9f4a',
        customer_ref: 'cus_0193b8f2c1a87d3e9f4a',
        status: 'sufficient',
        rule: 'eu_digital_two_items',
        country: 'DE',
        state: null,
        items: [
          { type: 'billing_address', country: 'DE', state: null },
          { type: 'ip_address', country: 'DE', state: null },
        ],
        observed_at: 1793750400,
        expires_at: 1793836800,
        livemode: false,
      },
    ],
  },
);
export type TaxLocationEvidence = Expand<z.output<typeof taxLocationEvidenceSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.location_evidence': TaxLocationEvidence;
  }
}

const evidenceCountry = z.string().regex(/^[A-Z]{2}$/);
const evidenceState = z
  .string()
  .regex(/^[A-Z0-9]{1,3}$/)
  .nullish();

const ipv4 = z.ipv4();
const ipv6 = z.ipv6();

/**
 * One piece of evidence. Strict: an item claiming a language, currency, locale
 * or timezone is not a smaller kind of evidence, it is refused.
 */
export const taxLocationEvidenceItemParams = z.discriminatedUnion('type', [
  z.object({ type: z.literal('billing_address'), address: taxAddressParams }).strict(),
  z
    .object({
      type: z.literal('ip_address'),
      ip_address: z
        .string()
        .refine(
          (value) => ipv4.safeParse(value).success || ipv6.safeParse(value).success,
          'Not an IP address',
        ),
      country: evidenceCountry,
      state: evidenceState,
    })
    .strict(),
  z
    .object({
      type: z.enum(['payment_method_country', 'bank_country', 'sim_country', 'landline_country']),
      country: evidenceCountry,
    })
    .strict(),
]);
/** One piece of evidence, as a request carries it. */
export type TaxLocationEvidenceItem = z.input<typeof taxLocationEvidenceItemParams>;

/** At least one item and at most six. */
export const taxLocationEvidenceItemsParam = z.array(taxLocationEvidenceItemParams).min(1).max(6);

export const createTaxLocationEvidenceParams = z
  .object({
    customer_ref: taxReferenceParam.describe(
      'The customer this evidence is about; for billing, the `storeId`.',
    ),
    evidence: taxLocationEvidenceItemsParam,
  })
  .strict();
export type CreateTaxLocationEvidenceParams = z.input<typeof createTaxLocationEvidenceParams>;

export const taxLocationEvidenceRoutes = [
  defineRoute({
    operationId: 'createTaxLocationEvidence',
    method: 'post',
    path: '/v1/tax/location_evidence',
    tag: 'Tax',
    summary: 'Record customer location evidence',
    description:
      "Judged at once against the customer's jurisdiction rule; the answer says whether it is `sufficient` to calculate against.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createTaxLocationEvidenceParams,
    response: taxLocationEvidenceSchema,
    status: 201,
    sdk: 'tax.locationEvidence.create',
  }),
  defineRoute({
    operationId: 'retrieveTaxLocationEvidence',
    method: 'get',
    path: '/v1/tax/location_evidence/{id}',
    tag: 'Tax',
    summary: 'Retrieve customer location evidence',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The evidence (`taxloc_…`).' },
    response: taxLocationEvidenceSchema,
    sdk: 'tax.locationEvidence.retrieve',
  }),
] as const;
