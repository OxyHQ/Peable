import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  ACCOUNT_BUSINESS_TYPES,
  ACCOUNT_CAPABILITY_STATUSES,
  ACCOUNT_LINK_TYPES,
  ACCOUNT_TYPES,
  PAYOUT_INTERVALS,
  PAYOUT_WEEKLY_ANCHORS,
} from '../../vocabulary/connect';

/**
 * The merchant's fiat account (ADR 0015 §1) — `GET /v1/account`.
 *
 * Orbit's funds never reach a Peable bank account: a merchant that takes fiat
 * has its OWN provider account, opened and onboarded through Peable, and this
 * object mirrors it. Everything here is what the provider last reported; the
 * provider is the authority and Orbit never decides readiness itself. The
 * provider's own `acct_…` never crosses (ADR 0016 D2).
 *
 * A marketplace's sellers (`/v1/connected_accounts`) are provider accounts too,
 * and a platform reads one of them in this same shape by sending
 * `Peable-Account: ca_…` to `GET /v1/account`.
 */

const capabilityStatus = z.enum(ACCOUNT_CAPABILITY_STATUSES);

/**
 * What the provider is waiting on. Requirement IDENTIFIERS only
 * (`individual.verification.document`), never their values: the gateway
 * records that a document is owed and never learns what it says.
 */
export const accountRequirementsSchema = defineComponent(
  'AccountRequirements',
  z
    .object({
      currently_due: z.array(z.string()),
      eventually_due: z.array(z.string()),
      past_due: z.array(z.string()),
      pending_verification: z
        .array(z.string())
        .describe('Submitted and being checked — nothing for the merchant to do.'),
      disabled_reason: z
        .string()
        .nullable()
        .describe("Why charges or payouts are disabled, in the provider's own code, or `null`."),
    })
    .strict(),
);
export type AccountRequirements = z.output<typeof accountRequirementsSchema>;

export const accountBusinessProfileSchema = defineComponent(
  'AccountBusinessProfile',
  z
    .object({
      name: z.string().nullable(),
      url: z.string().nullable(),
      support_email: z.string().nullable(),
      support_url: z.string().nullable(),
      product_description: z.string().nullable(),
      mcc: z.string().nullable().describe('Merchant category code.'),
    })
    .strict(),
);
export type AccountBusinessProfile = z.output<typeof accountBusinessProfileSchema>;

/**
 * When the provider pays the balance out. `manual` means only an explicit
 * `POST /v1/payouts` does — the provider still executes it; Orbit never moves
 * the money itself (ADR 0015 §4).
 */
export const accountPayoutScheduleSchema = defineComponent(
  'AccountPayoutSchedule',
  z
    .object({
      interval: z.enum(PAYOUT_INTERVALS),
      delay_days: z
        .number()
        .int()
        .nullable()
        .describe(
          'Days between a payment and its funds becoming payable; `null` when not reported.',
        ),
      weekly_anchor: z.enum(PAYOUT_WEEKLY_ANCHORS).nullable().describe('`weekly` only.'),
      monthly_anchor: z
        .number()
        .int()
        .nullable()
        .describe('`monthly` only: the day of the month, 1–31.'),
    })
    .strict(),
);
export type AccountPayoutSchedule = z.output<typeof accountPayoutScheduleSchema>;

export const accountSettingsSchema = defineComponent(
  'AccountSettings',
  z
    .object({
      payouts: z
        .object({
          schedule: accountPayoutScheduleSchema.nullable(),
          statement_descriptor: z
            .string()
            .nullable()
            .describe("What the merchant's bank statement shows for a payout."),
        })
        .strict(),
      payments: z
        .object({
          statement_descriptor: z
            .string()
            .nullable()
            .describe(
              "What a cardholder's statement shows — the merchant is the merchant of record.",
            ),
        })
        .strict(),
      branding: z
        .object({
          primary_color: z.string().nullable(),
          secondary_color: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
);
export type AccountSettings = z.output<typeof accountSettingsSchema>;

export const accountSchema = defineObject(
  'account',
  'Account',
  z
    .object({
      id: z.string().describe('`ca_…` — the same id space as a marketplace seller.'),
      object: z.literal('account'),
      livemode,
      type: z.enum(ACCOUNT_TYPES),
      country: z.string().describe('ISO 3166-1 alpha-2. Fixed at the provider once created.'),
      default_currency: z.string().nullable(),
      business_profile: accountBusinessProfileSchema,
      capabilities: z
        .object({
          card_payments: capabilityStatus.nullable(),
          transfers: capabilityStatus.nullable(),
        })
        .strict()
        .describe('`null`: never requested — a different fact from the provider declining it.'),
      requirements: accountRequirementsSchema,
      charges_enabled: z
        .boolean()
        .describe('Whether the account can take payments as merchant of record (`on_behalf_of`).'),
      payouts_enabled: z
        .boolean()
        .describe("Whether the provider will pay this account's balance out."),
      settings: accountSettingsSchema,
      last_synced_at: unixSeconds
        .nullable()
        .describe('The last provider read; `null` before the first one completed.'),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'ca_0193b8f2c1a87d3e9f4a',
        object: 'account',
        livemode: false,
        type: 'merchant',
        country: 'ES',
        default_currency: 'EUR',
        business_profile: {
          name: 'Rosen Ceramics',
          url: 'https://rosen.example',
          support_email: 'help@rosen.example',
          support_url: null,
          product_description: 'Handmade tableware',
          mcc: '5719',
        },
        capabilities: { card_payments: 'active', transfers: 'active' },
        requirements: {
          currently_due: [],
          eventually_due: [],
          past_due: [],
          pending_verification: [],
          disabled_reason: null,
        },
        charges_enabled: true,
        payouts_enabled: true,
        settings: {
          payouts: {
            schedule: {
              interval: 'weekly',
              delay_days: 7,
              weekly_anchor: 'friday',
              monthly_anchor: null,
            },
            statement_descriptor: 'ROSEN CERAMICS',
          },
          payments: { statement_descriptor: 'ROSEN CERAMICS' },
          branding: { primary_color: '#1f2937', secondary_color: null },
        },
        last_synced_at: 1793750460,
        created: 1793750400,
      },
    ],
  },
);
export type Account = Expand<z.output<typeof accountSchema>>;

/**
 * A hosted onboarding link — the merchant's own account's
 * (`POST /v1/account_links`) or a seller's
 * (`POST /v1/connected_accounts/{accountId}/account_links`). Single-use and
 * short-lived: mint one when the person is about to open it, never store it.
 */
export const accountLinkSchema = defineObject(
  'account_link',
  'AccountLink',
  z
    .object({
      object: z.literal('account_link'),
      livemode,
      url: z.string().describe('Where to send the person. Single use.'),
      expires_at: unixSeconds.describe('When the link stops working (minutes, not days).'),
    })
    .strict(),
  {
    examples: [
      {
        object: 'account_link',
        livemode: false,
        url: 'https://connect.peable.to/onboarding/Zk3s9v…',
        expires_at: 1793750700,
      },
    ],
  },
);
export type AccountLink = Expand<z.output<typeof accountLinkSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    account: Account;
    account_link: AccountLink;
  }
}

/** A statement descriptor: what a bank or card statement shows. */
const statementDescriptor = z
  .string()
  .min(5)
  .max(22)
  .regex(/^[^<>\\'"*]*$/, 'a statement descriptor may not contain < > \\ \' " *');

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * `POST /v1/account`: the account's settings, written to the provider and read
 * back. `country` + `business_type` OPEN the account the first time (when the
 * merchant has none) and are refused afterwards — a provider account's country
 * cannot change.
 */
export const updateAccountParams = z
  .object({
    country: z.string().length(2).optional(),
    business_type: z.enum(ACCOUNT_BUSINESS_TYPES).optional(),
    business_profile: z
      .object({
        name: z.string().min(1).max(200).optional(),
        url: z.url().max(2048).optional(),
        support_email: z.email().max(320).optional(),
        support_url: z.url().max(2048).optional(),
        product_description: z.string().max(1000).optional(),
        mcc: z
          .string()
          .regex(/^[0-9]{4}$/)
          .optional(),
      })
      .strict()
      .optional(),
    settings: z
      .object({
        payouts: z
          .object({
            schedule: z
              .object({
                interval: z.enum(PAYOUT_INTERVALS),
                delay_days: z.number().int().min(1).max(365).optional(),
                weekly_anchor: z.enum(PAYOUT_WEEKLY_ANCHORS).optional(),
                monthly_anchor: z.number().int().min(1).max(31).optional(),
              })
              .strict()
              .superRefine((schedule, ctx) => {
                if (schedule.weekly_anchor !== undefined && schedule.interval !== 'weekly') {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['weekly_anchor'],
                    message: 'weekly_anchor is for a weekly schedule',
                  });
                }
                if (schedule.monthly_anchor !== undefined && schedule.interval !== 'monthly') {
                  ctx.addIssue({
                    code: 'custom',
                    path: ['monthly_anchor'],
                    message: 'monthly_anchor is for a monthly schedule',
                  });
                }
              })
              .optional(),
            statement_descriptor: statementDescriptor.optional(),
          })
          .strict()
          .optional(),
        payments: z
          .object({ statement_descriptor: statementDescriptor.optional() })
          .strict()
          .optional(),
        branding: z
          .object({
            primary_color: hexColor.optional(),
            secondary_color: hexColor.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateAccountParams = z.input<typeof updateAccountParams>;

/** `POST /v1/account_links`: hosted onboarding (or an update of what was submitted). */
export const createAccountLinkParams = z
  .object({
    refresh_url: z.url().describe('Where the person goes when the link has expired.'),
    return_url: z.url().describe('Where the person returns when they leave the flow.'),
    type: z.enum(ACCOUNT_LINK_TYPES).optional().describe('Defaults to `account_onboarding`.'),
  })
  .strict();
export type CreateAccountLinkParams = z.input<typeof createAccountLinkParams>;

export const accountRoutes = [
  defineRoute({
    operationId: 'retrieveAccount',
    method: 'get',
    path: '/v1/account',
    tag: 'Account',
    summary: 'Retrieve the account',
    description:
      "The merchant's own fiat account, or with `Peable-Account: ca_…` one of a platform's sellers. A merchant without one is told so (404 `account_missing`).",
    auth: 'service',
    scope: 'payments:read',
    peableAccount: true,
    query: expandOnlyQuery,
    response: accountSchema,
    sdk: 'account.retrieve',
  }),
  defineRoute({
    operationId: 'updateAccount',
    method: 'post',
    path: '/v1/account',
    tag: 'Account',
    summary: 'Open or update the account',
    description:
      'The first call, with `country` and `business_type`, opens the account (201); every later one writes its settings to the provider and answers the account read back (200).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    peableAccount: true,
    body: updateAccountParams,
    response: accountSchema,
    sdk: 'account.update',
  }),
  defineRoute({
    operationId: 'createAccountLink',
    method: 'post',
    path: '/v1/account_links',
    tag: 'Account links',
    summary: 'Create an account link',
    description:
      "Hosted onboarding for the merchant's own account (or, with `Peable-Account`, a seller's card account), minted on demand.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    peableAccount: true,
    body: createAccountLinkParams,
    response: accountLinkSchema,
    status: 201,
    sdk: 'accountLinks.create',
  }),
] as const;
