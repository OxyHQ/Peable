import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_REGISTRATION_SCHEMES, TAX_REGISTRATION_STATUSES } from '../../vocabulary/tax';
import { taxCountry, taxInstantParam, taxState } from './shared';

/**
 * A Peable Tax registration (`taxreg_…`, ADR 0011): where the seller says it
 * is registered to collect. Only registrations the owner approved make Peable
 * collect. Registering with a government is the seller's job, never Peable's.
 */
export const taxRegistrationSchema = defineObject(
  'tax.registration',
  'TaxRegistration',
  z
    .object({
      object: z.literal('tax.registration'),
      id: z.string().describe('`taxreg_…`.'),
      country: taxCountry,
      state: taxState,
      scheme: z.enum(TAX_REGISTRATION_SCHEMES),
      registration_number: nullableString.describe(
        'The government-issued number (VAT id, state permit), when there is one.',
      ),
      active_from: unixSeconds,
      expires_at: unixSeconds.nullable(),
      status: z
        .enum(TAX_REGISTRATION_STATUSES)
        .describe('`pending_approval` until the owner approves; `scheduled` before `active_from`.'),
      approved_at: unixSeconds.nullable(),
      provider_registration_ref: nullableString.describe(
        'The mirrored registration at the calculating provider, once synced.',
      ),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.registration',
        id: 'taxreg_0193b8f2c1a87d3e9f4a',
        country: 'ES',
        state: null,
        scheme: 'eu_oss_union',
        registration_number: 'ESB12345678',
        active_from: 1793750400,
        expires_at: null,
        status: 'active',
        approved_at: 1793750400,
        provider_registration_ref: 'taxreg_1QxYz2AbCdEf',
        created: 1793664000,
      },
    ],
  },
);
export type TaxRegistration = Expand<z.output<typeof taxRegistrationSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.registration': TaxRegistration;
  }
}

/** Orbit's new registration (the owner's): pending until the owner approves. */
export const createTaxRegistrationParams = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    state: z
      .string()
      .regex(/^[A-Z0-9]{1,3}$/)
      .nullish(),
    scheme: z.enum(TAX_REGISTRATION_SCHEMES),
    registration_number: z.string().trim().min(1).max(64).nullish(),
    active_from: taxInstantParam
      .optional()
      .describe('Unix seconds; omitted means immediately on approval.'),
    expires_at: taxInstantParam.nullish(),
  })
  .strict();
export type CreateTaxRegistrationParams = z.input<typeof createTaxRegistrationParams>;

/** Orbit's end of a registration at `expires_at`. */
export const endTaxRegistrationParams = z.object({ expires_at: taxInstantParam }).strict();
export type EndTaxRegistrationParams = z.input<typeof endTaxRegistrationParams>;

export const taxRegistrationRoutes = [
  defineRoute({
    operationId: 'listTaxRegistrations',
    method: 'get',
    path: '/v1/tax/registrations',
    tag: 'Tax',
    summary: 'List tax registrations',
    description:
      'Every registration of the merchant, oldest first: a complete list, `has_more` is `false`. Registrations are added and approved by the owner in Orbit.',
    auth: 'service',
    scope: 'payments:read',
    response: listOf(taxRegistrationSchema),
    sdk: 'tax.listRegistrations',
  }),
] as const;
