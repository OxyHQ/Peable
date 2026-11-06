import { z } from 'zod';
import { defineComponent } from '../../common/objects';
import { queryInteger } from '../../common/params';

/** The highest BIP32 non-hardened child index, `int4`'s ceiling (`schema/valueSets.ts`). */
const MAX_DERIVATION_INDEX = 2_147_483_647;
import { network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  ENRICH_MAX_ADDRESSES,
  ENRICHMENT_KINDS,
  SOCIAL_PAYMENT_DIRECTIONS,
  SOCIAL_RECEIVE_ADDRESSES_PAGE_DEFAULT,
  SOCIAL_RECEIVE_ADDRESSES_PAGE_MAX,
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
      address: z
        .string()
        .describe(
          "A single-use address of the recipient's: the one this sender already holds and has not paid, or a fresh one.",
        ),
      index: z.number().int().nonnegative().describe('Its social-receive derivation index.'),
    })
    .strict(),
);
export type SocialNextAddressResponse = z.output<typeof socialNextAddressSchema>;

const networkQuery = z.object({ network });

export const socialReceiveCursorQuery = networkQuery;
export type SocialReceiveCursorParams = z.input<typeof socialReceiveCursorQuery>;

/**
 * The caller's cursor and keys. The addresses to watch are
 * `GET /v1/social/me/receive_addresses` (ADR 0021 D9, amended 2026-11-06);
 * `reserved_through` only says how far the cursor went, and the device
 * compares its key with `account_identity_public_key`.
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
          'The identity public key (hex) those addresses derive from — the key recorded at the LAST reservation; `null` exactly when no address was ever reserved.',
        ),
      account_identity_public_key: z
        .string()
        .nullable()
        .describe(
          "The caller's CURRENT identity public key: their DID's `#key-1`, read from Oxy at request time (never cached), as lowercase hex of the key exactly as the DID publishes it (`publicKeyHex`, the compressed secp256k1 key) — the same encoding as `identity_public_key`. Compare the device's key with THIS, not with `identity_public_key`, which only says what the last reservation used. `null` for a keyless (custodial) account.",
        ),
    })
    .strict(),
);
export type SocialReceiveCursorResponse = z.output<typeof socialReceiveCursorSchema>;

/**
 * The caller's receive addresses after a sync cursor (ADR 0021 D9, amended
 * 2026-11-06). `after` is the `sync_cursor` of the previous answer, `0` (the
 * default) from the start.
 */
export const socialReceiveAddressesQuery = z
  .object({
    network,
    after: queryInteger({ min: 0, max: MAX_DERIVATION_INDEX })
      .optional()
      .describe(
        'The `sync_cursor` of the previous page or sync; absent (or `0`) lists from the first address.',
      ),
    limit: queryInteger({ min: 1, max: SOCIAL_RECEIVE_ADDRESSES_PAGE_MAX })
      .optional()
      .describe(
        `At most this many addresses (default ${SOCIAL_RECEIVE_ADDRESSES_PAGE_DEFAULT}); a page exceeds it only by addresses sharing its last index.`,
      ),
  })
  .strict();
export type SocialReceiveAddressesParams = z.input<typeof socialReceiveAddressesQuery>;

/**
 * One FairCoin address the gateway handed out in the caller's Peable wallet —
 * for a payment (merchant, seller, invoice, raw intent, one output of a split
 * payment) or an `@username` request — under ANY key the account has had.
 * Addresses are never reused: each is a fresh index of the account's one
 * cursor (ADR 0002, ADR 0021 D5, D9).
 */
export const socialReceiveAddressSchema = defineComponent(
  'SocialReceiveAddress',
  z
    .object({
      address: z.string().describe('The FairCoin address.'),
      derivation_index: z
        .number()
        .int()
        .positive()
        .describe(
          "Its index in the account's social-receive tree (`deriveSocialReceiveAddress(key, index)`); index 0, the stable default address, is never handed out.",
        ),
      identity_public_key: z
        .string()
        .nullable()
        .describe(
          "The identity public key the address was derived from, in the encoding of the cursor's `identity_public_key` (lowercase hex of the DID `#key-1` bytes). It may be a key the account has since replaced. `null` only for an address handed out before keys were recorded.",
        ),
      network,
      created: unixSeconds.describe('When the address was handed out.'),
    })
    .strict(),
);
export type SocialReceiveAddress = z.output<typeof socialReceiveAddressSchema>;

export const socialReceiveAddressesSchema = defineComponent(
  'SocialReceiveAddresses',
  z
    .object({
      addresses: z
        .array(socialReceiveAddressSchema)
        .describe('In ascending `derivation_index`, each address once.'),
      has_more: z.boolean().describe('More addresses follow `sync_cursor`: ask again with it.'),
      sync_cursor: z
        .number()
        .int()
        .nonnegative()
        .describe(
          'Pass as `after` to continue — the highest `derivation_index` in this page, or `after` when the page is empty. Monotonic: an address handed out later always has a higher index, so a wallet that stored it misses nothing by asking from it.',
        ),
    })
    .strict(),
);
export type SocialReceiveAddressesResponse = z.output<typeof socialReceiveAddressesSchema>;

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
      "A fresh address of the recipient's, derived from their Oxy identity key — or the one this sender already holds and has not paid. Limited per sender and per (sender, recipient) pair; a recipient without an identity answers 409 `keyless_recipient`, and one handed too many fresh `@username` addresses in the last day 503 `faircoin_capacity_reached`; paying yourself is refused.",
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
    description:
      "How far the caller's receive tree has been reserved, the key the last reservation used, and the caller's current `#key-1` read fresh from Oxy (ADR 0002). A 503 when Oxy cannot be asked for the current key.",
    auth: 'user',
    query: socialReceiveCursorQuery,
    response: socialReceiveCursorSchema,
  }),
  defineRoute({
    operationId: 'listSocialReceiveAddresses',
    method: 'get',
    path: '/v1/social/me/receive_addresses',
    tag: 'Social payments',
    summary: "List the caller's receive addresses",
    description:
      "Every FairCoin address handed out in the caller's Peable wallet on `network` — payments and `@username` alike, under every key the account has had — after `after`, in ascending index, for whoever the session acts as (an organization's, when acting as it). The wallet watches exactly this set (ADR 0021 D9). Read-only.",
    auth: 'user',
    query: socialReceiveAddressesQuery,
    response: socialReceiveAddressesSchema,
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
