import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { CAPABILITY_STATUSES, PROVIDER_IDS } from './valueSets';

/**
 * A seller the merchant settles to — one row per (merchant, their own seller
 * id), holding the provider account behind it.
 *
 * ## Why this table is a SNAPSHOT and not a state machine
 *
 * Mercaria has its own `provider_accounts` with its own onboarding state
 * machine, and its ADR 0009 D14 keeps it there deliberately: readiness gates
 * checkout-group construction, which is a marketplace decision. If Peable also
 * decided "is this seller ready", one underlying account would have two
 * authorities that could disagree — and the disagreement would surface as a
 * checkout refused for a seller the gateway thinks is fine, or worse the
 * reverse.
 *
 * So this table records what the PROVIDER reports and nothing more:
 * capabilities, requirement counts, disabled reasons. The merchant derives
 * whatever state it needs. There is no `status` column here on purpose.
 *
 * ## The merchant never learns the provider's account id
 *
 * ADR 0001 D3: a merchant integrates against Peable and never learns which
 * acquirer sat behind their seller. `public_id` (`ca_…`) is what the API
 * returns and what the merchant stores on its side; `provider_account_id` is
 * the `acct_…` and never reaches a DTO.
 */
export const connectedAccounts = pgTable(
  'connected_accounts',
  {
    id: generatedId(),
    /** The `ca_…` the API returns. What a merchant stores as "the account". */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /**
     * The MERCHANT's own id for this seller — a Mercaria store id.
     *
     * This is the address a merchant uses, and the reason it exists is
     * idempotence: a marketplace onboarding a seller must be able to say "the
     * account for store 42" and converge, rather than having to remember a
     * `ca_…` it may have lost the response to. Unique per merchant, below.
     */
    externalRef: text().notNull(),
    provider: text().notNull(),
    /**
     * The provider's own `acct_…`.
     *
     * Never accepted from a request body, ever: the only writer is the create
     * path, reading it off a provider response to a call this gateway made
     * itself. A field a client could set is the account-takeover surface —
     * point a row at someone else's account and the transfers follow.
     */
    providerAccountId: text().notNull(),
    /** ISO-3166-1 alpha-2, upper-case, as created and immutable at the provider. */
    country: text().notNull(),
    /**
     * The account's own settlement currency as the provider reports it.
     *
     * Deliberately NOT checked against `CURRENCY_CODES`: a seller may legally
     * settle in a currency this gateway does not price in (RON, CZK, HUF), and
     * a CHECK here would fail the SYNC of a real account rather than the price.
     * Nothing computes against this value; it is reported.
     */
    defaultCurrency: text(),
    /** Whether the provider will pay this account out. */
    payoutsEnabled: boolean().notNull().default(false),
    /**
     * Whether the connected account may itself charge cards.
     *
     * Recorded because the provider reports it, and deliberately NOT part of
     * any readiness answer: under separate charges and transfers the connected
     * account never charges anything, so this being false does not stop the
     * seller selling.
     */
    chargesEnabled: boolean().notNull().default(false),
    /**
     * The `transfers` capability. NULL means never requested — a different fact
     * from `inactive` (the provider declining) and from `pending` (the provider
     * still working), and collapsing the three is how "the seller is stuck"
     * becomes unanswerable.
     */
    transfersCapability: text(),
    /**
     * The `card_payments` capability.
     *
     * Requested alongside transfers, and NOT because this account charges
     * anything: Stripe refuses the pair otherwise outside the US, AND a
     * recipient-only account emits no `account.updated`, which is the only
     * readiness trigger there is. Mercaria's ADR 0008 D2-C and D2-D are ONE
     * decision and they travelled here together.
     */
    cardPaymentsCapability: text(),
    /** Outstanding now. Non-zero means the seller has something to do. */
    requirementsCurrentlyDue: integer().notNull().default(0),
    /** Outstanding eventually — collected up front so payouts are never interrupted. */
    requirementsEventuallyDue: integer().notNull().default(0),
    /** Overdue. Non-zero is what turns a working account restricted. */
    requirementsPastDue: integer().notNull().default(0),
    /** Submitted and being checked — nothing for the seller to do. */
    requirementsPendingVerification: integer().notNull().default(0),
    /**
     * Why the provider will not pay this account out, in the provider's own
     * codes.
     *
     * `text[]` rather than a child table: a small set, never queried by
     * element. NOT NULL with an empty default, because "no reasons" is a real
     * value and a nullable column would make every reader handle two spellings
     * of it.
     */
    disabledReasonCodes: text().array().notNull().default([]),
    /**
     * The last successful provider read, and the reconciliation cursor: the
     * sweep refreshes the oldest first, so a missed `account.updated` converges
     * without anyone knowing which one was missed.
     */
    lastSyncedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('connected_accounts_public_id_key').on(table.publicId),
    /**
     * ONE account per seller per merchant, and it is what makes onboarding
     * idempotent. A concurrent second "create the account for store 42"
     * converges on the row this refuses to duplicate rather than opening a
     * second account at the provider — which would be a real, unremovable
     * account, and the seller would have two.
     */
    unique('connected_accounts_merchant_external_ref_key').on(
      table.merchantId,
      table.externalRef
    ),
    /** "Which seller is this?" — where every inbound account event starts. */
    unique('connected_accounts_provider_account_id_key').on(
      table.provider,
      table.providerAccountId
    ),
    /** The sync sweep: least-recently-synced first, never-synced ahead of all. */
    index('connected_accounts_sync_idx').on(table.provider, table.lastSyncedAt),
    foreignKey({
      name: 'connected_accounts_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'connected_accounts_provider_check',
      sql.raw(`provider in (${inList(PROVIDER_IDS)})`)
    ),
    // An empty string is a VALUE: it satisfies NOT NULL and collides for real in
    // the uniqueness above, so a merchant sending `""` would claim the one row
    // every other empty-ref seller wants.
    check('connected_accounts_external_ref_check', sql`length(${table.externalRef}) > 0`),
    check(
      'connected_accounts_provider_account_id_check',
      sql`length(${table.providerAccountId}) > 0`
    ),
    check(
      'connected_accounts_country_check',
      sql`${table.country} = upper(${table.country}) and length(${table.country}) = 2`
    ),
    check(
      'connected_accounts_transfers_capability_check',
      sql.raw(
        `transfers_capability is null or transfers_capability in (${inList(CAPABILITY_STATUSES)})`
      )
    ),
    check(
      'connected_accounts_card_payments_capability_check',
      sql.raw(
        `card_payments_capability is null or card_payments_capability in (${inList(CAPABILITY_STATUSES)})`
      )
    ),
    check(
      'connected_accounts_requirements_check',
      sql`${table.requirementsCurrentlyDue} >= 0 and ${table.requirementsEventuallyDue} >= 0
          and ${table.requirementsPastDue} >= 0 and ${table.requirementsPendingVerification} >= 0`
    ),
    // A code is a code — the allow-list form would be wrong, these are the
    // provider's own and their set grows on the provider's schedule. An EMPTY
    // one carries no meaning and renders as a blank bullet to a seller.
    check(
      'connected_accounts_disabled_reason_codes_check',
      sql`not ('' = any(${table.disabledReasonCodes}))`
    ),
  ]
);
