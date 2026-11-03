import { z } from 'zod';
import { defineComponent } from '../../common/objects';
import { network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  ENRICH_MAX_ADDRESSES,
  ENRICHMENT_KINDS,
  SOCIAL_PAYMENT_DIRECTIONS,
  SOCIAL_SOURCE_APP_MAX_LENGTH,
  SOCIAL_SOURCE_REF_MAX_LENGTH,
} from '../../vocabulary/payments';

/**
 * Social payments (pay a person by `@username`) and transaction enrichment —
 * the wallet's routes, called with the person's own Oxy session. Display-only
 * context throughout: nothing here decides where money goes; the address comes
 * from the recipient's identity key and their reservation cursor.
 */

/**
 * Display-only context for one social payment: which app the payer was in, and
 * that app's own opaque id for what it was for (a Mention post, say). Peable
 * never parses, resolves or links `ref`; it stores a string and hands the same
 * string back.
 */
export const socialPaymentSourceSchema = defineComponent(
  'SocialPaymentSource',
  z
    .object({
      app: z.string().describe("The calling app's slug, e.g. `mention`."),
      ref: z
        .string()
        .optional()
        .describe(
          "That app's own opaque id for what the payment was for; absent when it named none.",
        ),
    })
    .strict(),
);
export type SocialPaymentSource = z.output<typeof socialPaymentSourceSchema>;

/**
 * Display-only counterparty identity for one address, as `POST /v1/enrich`
 * resolves it. A failed or partial resolution degrades to `{ kind: 'unknown' }`.
 */
export const enrichmentResultSchema = defineComponent(
  'EnrichmentResult',
  z
    .object({
      kind: z.enum(ENRICHMENT_KINDS),
      display_name: z
        .string()
        .optional()
        .describe("The merchant's name, or the user's display name (else handle)."),
      avatar_file_id: z
        .string()
        .optional()
        .describe('A bare Oxy file id — render through the media chokepoint, never as a URL.'),
      username: z.string().optional().describe("`kind: 'user'` only."),
      description: z.string().optional().describe("`kind: 'merchant'` only."),
    })
    .strict(),
);
export type EnrichmentResult = z.output<typeof enrichmentResultSchema>;

/**
 * `.strict()` is load-bearing: `{ app, postId }` — the obvious misspelling of
 * `ref` — would otherwise reserve an address and record a context missing the
 * only part the recipient cares about, with a 200. `ref` is validated for SHAPE
 * (printable non-space ASCII) and never for meaning, so it cannot become a
 * free-text memo the gateway stores on behalf of two users.
 */
export const socialPaymentSourceParams = z
  .object({
    app: z
      .string()
      .min(1)
      .max(SOCIAL_SOURCE_APP_MAX_LENGTH)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'source.app must be a lowercase app slug'),
    ref: z
      .string()
      .min(1)
      .max(SOCIAL_SOURCE_REF_MAX_LENGTH)
      .regex(/^[\x21-\x7e]+$/, 'source.ref must be an opaque id, without spaces')
      .optional(),
  })
  .strict();

/** `source` is OPTIONAL and stays that way: most person-to-person payments are for nothing in particular. */
export const socialNextAddressParams = z
  .object({
    network,
    source: socialPaymentSourceParams.optional(),
  })
  .strict();
export type SocialNextAddressRequest = z.input<typeof socialNextAddressParams>;

export const socialNextAddressSchema = defineComponent(
  'SocialNextAddress',
  z
    .object({
      address: z.string().describe("A fresh single-use address of the recipient's."),
      index: z.number().int().nonnegative().describe('Its social-receive derivation index.'),
    })
    .strict(),
);
export type SocialNextAddressResponse = z.output<typeof socialNextAddressSchema>;

const networkQuery = z.object({ network });

export const socialReceiveCursorQuery = networkQuery;
export type SocialReceiveCursorParams = z.input<typeof socialReceiveCursorQuery>;

/**
 * Lets the caller's device resync its watch window: every `next_address`
 * advances a monotonic index whether or not it is ever paid, so a burst of
 * reservations can outrun a device that widens only on payment. Watch
 * `0..reserved_through + gap`.
 */
export const socialReceiveCursorSchema = defineComponent(
  'SocialReceiveCursor',
  z
    .object({
      reserved_through: z
        .number()
        .int()
        .nonnegative()
        .describe(
          'The highest social-receive index ever reserved for the caller on this network; `0` when none was.',
        ),
      identity_public_key: z
        .string()
        .nullable()
        .describe(
          'The identity public key (hex) those addresses derive from; `null` exactly when no address was ever reserved.',
        ),
    })
    .strict(),
);
export type SocialReceiveCursorResponse = z.output<typeof socialReceiveCursorSchema>;

export const socialPaymentsQuery = networkQuery;
export type SocialPaymentsParams = z.input<typeof socialPaymentsQuery>;

/**
 * One social payment as the CALLER saw it — the address-free view, and the
 * only history a surface without a key can ask for. Carries NO amount: the
 * attribution records which address was minted, not what was paid; the amount
 * is on-chain at `address`.
 */
export const socialPaymentSchema = defineComponent(
  'SocialPayment',
  z
    .object({
      address: z
        .string()
        .describe('The single-use social-receive address minted for this payment.'),
      direction: z.enum(SOCIAL_PAYMENT_DIRECTIONS),
      counterparty: enrichmentResultSchema.describe(
        "The other party; `{ kind: 'unknown' }` when the identity lookup failed.",
      ),
      source: socialPaymentSourceSchema
        .optional()
        .describe('What it was for, as the paying app named it; absent when it named nothing.'),
      created: unixSeconds.describe('When the address was minted.'),
    })
    .strict(),
);
export type SocialPayment = z.output<typeof socialPaymentSchema>;

export const socialPaymentsSchema = defineComponent(
  'SocialPayments',
  z.object({ payments: z.array(socialPaymentSchema).describe('Newest first.') }).strict(),
);
export type SocialPaymentsResponse = z.output<typeof socialPaymentsSchema>;

export const enrichParams = z
  .object({
    addresses: z.array(z.string().min(1)).min(1).max(ENRICH_MAX_ADDRESSES),
  })
  .strict();
export type EnrichRequest = z.input<typeof enrichParams>;

export const enrichSchema = defineComponent(
  'Enrichment',
  z
    .object({
      data: z
        .record(z.string(), enrichmentResultSchema)
        .describe('Every address asked for → who is behind it.'),
    })
    .strict(),
);
export type EnrichResponse = z.output<typeof enrichSchema>;

export const socialRoutes = [
  defineRoute({
    operationId: 'reserveSocialAddress',
    method: 'post',
    path: '/v1/social/{username}/next_address',
    tag: 'Social payments',
    summary: 'Reserve an address to pay a person',
    description:
      "A fresh address of the recipient's, derived from their Oxy identity key. Limited per (sender, recipient) pair; a recipient without an identity answers 409 `keyless_recipient`; paying yourself is refused.",
    auth: 'user',
    params: { username: 'The recipient’s Oxy username.' },
    body: socialNextAddressParams,
    response: socialNextAddressSchema,
  }),
  defineRoute({
    operationId: 'retrieveSocialReceiveCursor',
    method: 'get',
    path: '/v1/social/me/cursor',
    tag: 'Social payments',
    summary: "Retrieve the caller's receive cursor",
    auth: 'user',
    query: socialReceiveCursorQuery,
    response: socialReceiveCursorSchema,
  }),
  defineRoute({
    operationId: 'listSocialPayments',
    method: 'get',
    path: '/v1/social/me/payments',
    tag: 'Social payments',
    summary: "List the caller's social payments",
    auth: 'user',
    query: socialPaymentsQuery,
    response: socialPaymentsSchema,
  }),
  defineRoute({
    operationId: 'enrichAddresses',
    method: 'post',
    path: '/v1/enrich',
    tag: 'Social payments',
    summary: 'Resolve who is behind addresses',
    description:
      'Display-only counterparty identity for the caller’s own payments; never affects custody.',
    auth: 'user',
    body: enrichParams,
    response: enrichSchema,
  }),
] as const;
