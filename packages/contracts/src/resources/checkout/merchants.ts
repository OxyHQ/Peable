import { z } from 'zod';
import { defineObject, type Expand } from '../../common/objects';
import { livemode, network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  BRANDING_BORDER_STYLES,
  BRANDING_FONTS,
  MERCHANT_ENVIRONMENTS,
} from '../../vocabulary/merchants';

/**
 * The merchant (`merch_…`) — one per Oxy application and environment — with
 * its branding and customer-email settings. `next_derivation_index` is never
 * on the wire: it is an internal derivation counter with no meaning to an
 * integration. Where events go is not a merchant field: it is the
 * `webhook_endpoint` resource.
 */
export const merchantSchema = defineObject(
  'merchant',
  'Merchant',
  z
    .object({
      id: z.string(),
      object: z.literal('merchant'),
      livemode: livemode.describe('`true` for a `production` merchant (ADR 0017).'),
      oxy_app_id: z.string().describe('The Oxy application this merchant belongs to.'),
      environment: z.enum(MERCHANT_ENVIRONMENTS),
      network: network.describe(
        "The FairCoin network this merchant's payments use — its environment's: `mainnet` live, `testnet` otherwise (ADR 0021 D5).",
      ),
      owner_account: z
        .string()
        .nullable()
        .describe(
          'The Oxy account (a person or an organization) that owns the application — its Peable wallet receives the merchant’s FairCoin (ADR 0021 D5). No key is ever registered. `null` until Peable has seen the owner.',
        ),
      required_confirmations: z.number().int().positive(),
      display_name: z
        .string()
        .optional()
        .describe('Payer-facing name. Absent when unset: payer surfaces substitute a fallback.'),
      avatar_file_id: z
        .string()
        .optional()
        .describe(
          'The square identity image: a bare Oxy file id. Absent again once Oxy reports the file deleted or taken down.',
        ),
      business_logo: z
        .string()
        .optional()
        .describe('The wide wordmark payer surfaces show: a `file_…` of purpose `business_logo`.'),
      description: z.string().optional(),
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'merch_0193b8f2c1a87d3e9f4a',
        object: 'merchant',
        livemode: false,
        oxy_app_id: 'app_0193b8f2c1a87d3e9f4b',
        environment: 'development',
        network: 'testnet',
        owner_account: '0193b8f2-c1a8-7d3e-9f4a-5b6c7d8e9f01',
        required_confirmations: 6,
        display_name: 'Jenny’s Plants',
        created: 1793750400,
        updated_at: 1793750400,
      },
    ],
  },
);
export type Merchant = Expand<z.output<typeof merchantSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    merchant: Merchant;
    branding_settings: MerchantBranding;
    email_settings: MerchantEmailSettings;
  }
}

// The branding columns are bare `text()` with no CHECK, so these bounds are
// the ONLY thing between a merchant and an unbounded write. `display_name` is
// rendered in a payer's transaction history and on the checkout chip, so it is
// held to a chip-sized length rather than a paragraph.
const displayName = z.string().min(1).max(64);
const avatarFileId = z.string().min(1).max(128);
const merchantDescription = z.string().min(1).max(512);

/**
 * `POST /v1/merchants`. No FairCoin key and no network: the network is the
 * environment's, and FairCoin is received into the Peable wallet of the
 * account that owns the application (ADR 0021 D5).
 */
export const registerMerchantParams = z
  .object({
    required_confirmations: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Confirmations a FairCoin payment needs to succeed. Defaults to 6 for a live (mainnet) merchant, 1 on testnet.',
      ),
    display_name: displayName.optional(),
    avatar_file_id: avatarFileId.optional(),
    description: merchantDescription.optional(),
  })
  .strict();
export type RegisterMerchantParams = z.input<typeof registerMerchantParams>;

/**
 * `POST /v1/merchants/me`. `null` clears a field. The network and environment
 * never change: the test/live firewall depends on them.
 */
export const updateMerchantParams = z
  .object({
    required_confirmations: z.number().int().positive().optional(),
    display_name: displayName.nullable().optional(),
    avatar_file_id: avatarFileId.nullable().optional(),
    business_logo: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe('A `file_…` of purpose `business_logo` — set on an update, never at registration.'),
    description: merchantDescription.nullable().optional(),
  })
  .strict();
export type UpdateMerchantParams = z.input<typeof updateMerchantParams>;

// ---- Branding ----------------------------------------------------------------

/** A merchant's branding: what its hosted checkout, embedded checkout and receipts look like. */
export const merchantBrandingSchema = defineObject(
  'branding_settings',
  'BrandingSettings',
  z
    .object({
      object: z.literal('branding_settings'),
      livemode,
      use_avatar_as_icon: z
        .boolean()
        .describe('Show the merchant avatar (`avatar_file_id`) as the square icon.'),
      logo: z
        .string()
        .nullable()
        .describe(
          'The wide logo: a `file_…` of purpose `business_logo`, or `null` — the same field as `POST /v1/merchants/me {business_logo}`.',
        ),
      primary_color: z.string().nullable().describe('`#rrggbb`; `null` for Peable’s default.'),
      accent_color: z.string().nullable(),
      font: z.enum(BRANDING_FONTS).nullable(),
      border_style: z.enum(BRANDING_BORDER_STYLES).nullable(),
      terms_of_service_url: z
        .string()
        .nullable()
        .describe(
          'Your terms (`https://`). Required before a session or link can ask for terms acceptance.',
        ),
      updated_at: unixSeconds.nullable(),
    })
    .strict(),
);
export type MerchantBranding = z.output<typeof merchantBrandingSchema>;

/** `#rgb` or `#rrggbb`, any case — stored as lowercase `#rrggbb`. */
const colorParam = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a #rrggbb colour')
  .transform((value) => {
    const hex = value.slice(1).toLowerCase();
    return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
  });

const httpsUrlParam = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/, 'must be an https URL');

export const updateMerchantBrandingParams = z
  .object({
    use_avatar_as_icon: z.boolean().optional(),
    logo: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe('A `file_…` of purpose `business_logo`; `null` removes it.'),
    primary_color: colorParam
      .nullable()
      .optional()
      .describe('`#rrggbb` (any case; stored lowercase), `null` for Peable’s default.'),
    accent_color: colorParam.nullable().optional(),
    font: z.enum(BRANDING_FONTS).nullable().optional(),
    border_style: z.enum(BRANDING_BORDER_STYLES).nullable().optional(),
    terms_of_service_url: httpsUrlParam.nullable().optional(),
  })
  .strict();
export type UpdateMerchantBrandingParams = z.input<typeof updateMerchantBrandingParams>;

/** Which customer emails Peable sends for this merchant. */
export const merchantEmailSettingsSchema = defineObject(
  'email_settings',
  'EmailSettings',
  z
    .object({
      object: z.literal('email_settings'),
      livemode,
      payment_receipts: z
        .boolean()
        .describe(
          'A receipt when a payment succeeds and has a `receipt_email` (or a collected one).',
        ),
      refund_notices: z.boolean().describe('A notice when a refund succeeds.'),
      checkout_confirmations: z
        .boolean()
        .describe('A confirmation when a checkout session completes.'),
      support_email: z
        .string()
        .nullable()
        .describe('The reply-to address shown on emails, or `null` for none.'),
      updated_at: unixSeconds.nullable(),
    })
    .strict(),
);
export type MerchantEmailSettings = z.output<typeof merchantEmailSettingsSchema>;

export const updateMerchantEmailSettingsParams = z
  .object({
    payment_receipts: z.boolean().optional(),
    refund_notices: z.boolean().optional(),
    checkout_confirmations: z.boolean().optional(),
    support_email: z
      .string()
      .trim()
      .max(254)
      .email('must be an email address')
      .nullable()
      .optional(),
  })
  .strict();
export type UpdateMerchantEmailSettingsParams = z.input<typeof updateMerchantEmailSettingsParams>;

export const merchantRoutes = [
  defineRoute({
    operationId: 'registerMerchant',
    method: 'post',
    path: '/v1/merchants',
    tag: 'Merchants',
    summary: 'Register the merchant',
    description:
      "Registers the calling application's merchant in the credential's environment. A non-production credential can register a testnet merchant only. A second registration for the same application and environment answers 409. Outside the generic idempotency layer: the merchant is the scope it keys on.",
    auth: 'service',
    scope: 'payments:write',
    body: registerMerchantParams,
    response: merchantSchema,
    status: 201,
    sdk: 'merchants.register',
  }),
  defineRoute({
    operationId: 'retrieveMerchant',
    method: 'get',
    path: '/v1/merchants/me',
    tag: 'Merchants',
    summary: 'Retrieve your merchant',
    auth: 'service',
    scope: 'payments:read',
    response: merchantSchema,
    sdk: 'merchants.retrieve',
  }),
  defineRoute({
    operationId: 'updateMerchant',
    method: 'post',
    path: '/v1/merchants/me',
    tag: 'Merchants',
    summary: 'Update your merchant',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: updateMerchantParams,
    response: merchantSchema,
    sdk: 'merchants.update',
  }),
  defineRoute({
    operationId: 'retrieveBrandingSettings',
    method: 'get',
    path: '/v1/merchants/me/branding',
    tag: 'Merchants',
    summary: 'Retrieve your branding',
    auth: 'service',
    scope: 'payments:read',
    response: merchantBrandingSchema,
    sdk: 'merchants.branding.retrieve',
  }),
  defineRoute({
    operationId: 'updateBrandingSettings',
    method: 'post',
    path: '/v1/merchants/me/branding',
    tag: 'Merchants',
    summary: 'Update your branding',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: updateMerchantBrandingParams,
    response: merchantBrandingSchema,
    sdk: 'merchants.branding.update',
  }),
  defineRoute({
    operationId: 'retrieveEmailSettings',
    method: 'get',
    path: '/v1/merchants/me/email_settings',
    tag: 'Merchants',
    summary: 'Retrieve your customer email settings',
    auth: 'service',
    scope: 'payments:read',
    response: merchantEmailSettingsSchema,
    sdk: 'merchants.emailSettings.retrieve',
  }),
  defineRoute({
    operationId: 'updateEmailSettings',
    method: 'post',
    path: '/v1/merchants/me/email_settings',
    tag: 'Merchants',
    summary: 'Update your customer email settings',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: updateMerchantEmailSettingsParams,
    response: merchantEmailSettingsSchema,
    sdk: 'merchants.emailSettings.update',
  }),
] as const;
