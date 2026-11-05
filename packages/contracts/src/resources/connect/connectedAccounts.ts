import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, listQuery } from '../../common/params';
import { livemode, network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  ACCOUNT_BUSINESS_TYPES,
  ACCOUNT_CAPABILITY_STATUSES,
  CONNECTED_ACCOUNT_FAIRCOIN_STATUSES,
  CONNECTED_ACCOUNT_RAILS,
} from '../../vocabulary/connect';
import { NETWORK_TYPES } from '../../vocabulary/money';
import { accountLinkSchema, accountRequirementsSchema } from './account';

/**
 * Connected accounts (`ca_…`) — a marketplace's sellers (ADR 0012).
 *
 * ## The provider's own ids are not here, and that is the contract
 *
 * ADR 0001 D3: a merchant integrates against Peable and never learns which
 * acquirer sat behind their seller, because the day that changes should be a
 * Peable deploy and not a merchant migration. No `acct_…`, no provider name —
 * and no key of any kind: a seller's FairCoin is paid into the Peable wallet
 * of their own Oxy account (ADR 0021 D5), and each payment carries its own
 * address.
 */

const capabilityStatus = z.enum(ACCOUNT_CAPABILITY_STATUSES);

/** The FairCoin half of a seller's account: paid into the Peable wallet of the seller's own Oxy account (ADR 0021 D5). */
export const connectedAccountFaircoinSchema = defineComponent(
  'ConnectedAccountFaircoin',
  z
    .object({
      network: network.describe('The chain the seller is paid on. Fixed when the half was opened.'),
      status: z
        .enum(CONNECTED_ACCOUNT_FAIRCOIN_STATUSES)
        .describe(
          '`pending`: the seller has not confirmed yet (an on-behalf payment is refused, `account_not_ready`). `active`: the seller confirmed, and payments go to the Peable wallet of their Oxy account.',
        ),
      oxy_user_id: z
        .string()
        .describe(
          'The seller’s Oxy account — the only one that may confirm, and the one whose Peable wallet receives.',
        ),
      registered_at: unixSeconds
        .nullable()
        .describe('When the seller confirmed. `null` while `pending`.'),
    })
    .strict(),
);
export type ConnectedAccountFaircoin = z.output<typeof connectedAccountFaircoinSchema>;

export const connectedAccountSchema = defineObject(
  'connected_account',
  'ConnectedAccount',
  z
    .object({
      id: z.string(),
      object: z.literal('connected_account'),
      livemode,
      external_ref: z
        .string()
        .describe("The merchant's OWN id for this seller — how they address it."),
      rails: z
        .array(z.enum(CONNECTED_ACCOUNT_RAILS))
        .describe('Which halves this account has. Never empty.'),
      faircoin: connectedAccountFaircoinSchema
        .nullable()
        .describe(
          "The FairCoin half, or `null` when the platform never opened one. Readiness for FairCoin is `faircoin.status === 'active'`; `payable` is about the CARD half.",
        ),
      country: z
        .string()
        .nullable()
        .describe(
          'ISO 3166-1 alpha-2, upper-case. `null` on a FairCoin-only seller, which has no card half.',
        ),
      default_currency: z.string().nullable(),
      payable: z
        .boolean()
        .describe(
          'Whether this seller can receive a CARD settlement (a transfer) right now. A convenience: every field it is derived from is here too. Always `false` on a FairCoin-only seller.',
        ),
      payouts_enabled: z.boolean(),
      charges_enabled: z.boolean(),
      transfers_capability: capabilityStatus
        .nullable()
        .describe('`null`: never requested — a different fact from the provider declining it.'),
      card_payments_capability: capabilityStatus.nullable(),
      requirements: accountRequirementsSchema,
      last_synced_at: unixSeconds.nullable(),
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'ca_0193b8f2d4e1aa07c3b2',
        object: 'connected_account',
        livemode: false,
        external_ref: 'seller_4821',
        rails: ['card', 'faircoin'],
        faircoin: {
          network: 'mainnet',
          status: 'active',
          oxy_user_id: '665f1c0e9a1b2c3d4e5f6a7b',
          registered_at: 1793751000,
        },
        country: 'DE',
        default_currency: 'EUR',
        payable: true,
        payouts_enabled: true,
        charges_enabled: true,
        transfers_capability: 'active',
        card_payments_capability: 'active',
        requirements: {
          currently_due: [],
          eventually_due: [],
          past_due: [],
          pending_verification: [],
          disabled_reason: null,
        },
        last_synced_at: 1793751060,
        created: 1793750400,
        updated_at: 1793751060,
      },
    ],
  },
);
export type ConnectedAccount = Expand<z.output<typeof connectedAccountSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    connected_account: ConnectedAccount;
  }
}

/** Bounded for the reason `external_ref` is: it is stored, and it is compared. */
const OXY_USER_ID_MAX = 128;

/**
 * `POST /v1/connected_accounts`: open (or return) the account for one seller.
 *
 * Two halves, at least one: the CARD half (`country` + `business_type`, both or
 * neither) and the FAIRCOIN half (`faircoin`). There is no key: the seller's
 * FairCoin goes to their own account's Peable wallet, confirmed only from the
 * SELLER's own session (ADR 0012 D3, ADR 0021 D5).
 */
export const createConnectedAccountParams = z
  .object({
    // Bounded because it is a key: an unbounded string here is an unbounded
    // index entry and an unbounded response field.
    external_ref: z
      .string()
      .min(1)
      .max(255)
      .describe(
        'Your own id for the seller. Opening the same `external_ref` again answers that account (200).',
      ),
    country: z
      .string()
      .length(2)
      .optional()
      .describe('The card half: ISO 3166-1 alpha-2 (case-insensitive). With `business_type`.'),
    business_type: z
      .enum(ACCOUNT_BUSINESS_TYPES)
      .optional()
      .describe('The card half: with `country`.'),
    faircoin: z
      .object({
        network: z.enum(NETWORK_TYPES),
        oxy_user_id: z
          .string()
          .min(1)
          .max(OXY_USER_ID_MAX)
          .describe(
            "The seller's Oxy account id — the only one that may confirm, and whose Peable wallet receives.",
          ),
      })
      .strict()
      .optional()
      .describe(
        'The FairCoin half (ADR 0012 D2): the chain the seller is paid on, and who they are.',
      ),
  })
  .strict()
  .refine((body) => (body.country === undefined) === (body.business_type === undefined), {
    message: 'a card account needs both country and business_type, or neither',
  })
  .refine((body) => body.country !== undefined || body.faircoin !== undefined, {
    message: 'open at least one rail: country and business_type for cards, faircoin for FairCoin',
  });
export type CreateConnectedAccountParams = z.input<typeof createConnectedAccountParams>;

export const listConnectedAccountsQuery = listQuery({});
export type ListConnectedAccountsParams = z.input<typeof listConnectedAccountsQuery>;

/** `POST /v1/connected_accounts/{accountId}/refresh` takes no parameters. */
export const refreshConnectedAccountParams = z.object({}).strict();

/** A seller's onboarding link. */
export const createConnectedAccountLinkParams = z
  .object({
    refresh_url: z.url().describe('Where the seller goes when the link has expired.'),
    return_url: z.url().describe('Where the seller returns when they leave the flow.'),
    rail: z
      .enum(CONNECTED_ACCOUNT_RAILS)
      .optional()
      .describe(
        "Which half to onboard: `card` (the default) is the provider's hosted onboarding; `faircoin` is Peable's own page where the SELLER confirms, in their own Oxy session, that their FairCoin is paid into their Peable wallet.",
      ),
  })
  .strict();
export type CreateConnectedAccountLinkParams = z.input<typeof createConnectedAccountLinkParams>;

const accountIdParam = { accountId: 'The connected account (`ca_…`).' } as const;

export const connectedAccountRoutes = [
  defineRoute({
    operationId: 'createConnectedAccount',
    method: 'post',
    path: '/v1/connected_accounts',
    tag: 'Connected accounts',
    summary: 'Open a connected account',
    description:
      'Opens the account for one seller (201), or answers the one this `external_ref` already opened (200) — a provider account cannot be deleted, so a converged retry says so.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createConnectedAccountParams,
    response: connectedAccountSchema,
    status: 201,
    sdk: 'connectedAccounts.create',
  }),
  defineRoute({
    operationId: 'listConnectedAccounts',
    method: 'get',
    path: '/v1/connected_accounts',
    tag: 'Connected accounts',
    summary: 'List connected accounts',
    description: 'Every seller this merchant has onboarded, newest first.',
    auth: 'service',
    scope: 'payments:read',
    query: listConnectedAccountsQuery,
    response: listOf(connectedAccountSchema),
    sdk: 'connectedAccounts.list',
    expandable: 'connected_account',
  }),
  defineRoute({
    operationId: 'retrieveConnectedAccountByRef',
    method: 'get',
    path: '/v1/connected_accounts/by_ref/{externalRef}',
    tag: 'Connected accounts',
    summary: 'Retrieve a connected account by your id',
    description:
      'By `external_ref`, the durable address you already hold — so a create whose answer never arrived is recoverable without a list scan.',
    auth: 'service',
    scope: 'payments:read',
    params: { externalRef: 'Your own id for the seller.' },
    query: expandOnlyQuery,
    response: connectedAccountSchema,
    sdk: 'connectedAccounts.retrieveByRef',
  }),
  defineRoute({
    operationId: 'retrieveConnectedAccount',
    method: 'get',
    path: '/v1/connected_accounts/{accountId}',
    tag: 'Connected accounts',
    summary: 'Retrieve a connected account',
    auth: 'service',
    scope: 'payments:read',
    params: accountIdParam,
    query: expandOnlyQuery,
    response: connectedAccountSchema,
    sdk: 'connectedAccounts.retrieve',
  }),
  defineRoute({
    operationId: 'refreshConnectedAccount',
    method: 'post',
    path: '/v1/connected_accounts/{accountId}/refresh',
    tag: 'Connected accounts',
    summary: 'Refresh a connected account',
    description:
      'Re-reads the account from the provider now. The sweep and the inbound event keep it fresh on their own; this is for a seller watching a screen.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: accountIdParam,
    body: refreshConnectedAccountParams,
    response: connectedAccountSchema,
    sdk: 'connectedAccounts.refresh',
  }),
  defineRoute({
    operationId: 'createConnectedAccountLink',
    method: 'post',
    path: '/v1/connected_accounts/{accountId}/account_links',
    tag: 'Connected accounts',
    summary: "Create a seller's onboarding link",
    description:
      'Minted on demand and never stored: single-use and short-lived. A visit to `return_url` proves nothing about verification — read the account back.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: accountIdParam,
    body: createConnectedAccountLinkParams,
    response: accountLinkSchema,
    status: 201,
    sdk: 'connectedAccounts.createAccountLink',
  }),
] as const;
