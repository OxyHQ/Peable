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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import { CAPABILITY_STATUSES, NETWORK_TYPES, PROVIDER_IDS } from './valueSets';

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
 *
 * ## Two halves, either optional (ADR 0012 D1)
 *
 * One seller is ONE `ca_…` whatever rail their buyers pay on. The CARD half is
 * `provider` + `provider_account_id` + `country` — the row that existed before
 * ADR 0012, read identically by every card path. The FAIRCOIN half is
 * `network` + `faircoin_oxy_user_id` (set when the platform opens it) and
 * `xpub` + `faircoin_registered_at` (set when the SELLER registers their key,
 * and never again). A FairCoin-only seller has no provider account at all and
 * never reaches the acquirer; `connected_accounts_has_a_rail_check` refuses a
 * row with neither half.
 *
 * Like `merchants`, there is deliberately NO column for a private key, a
 * mnemonic or a seed: `services/watchOnly.ts` refuses an extended key that can
 * spend, at the one writer of `xpub`.
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
    /** The card half's acquirer. NULL on a FairCoin-only seller (ADR 0012 D1). */
    provider: text(),
    /**
     * The provider's own `acct_…`. NULL on a FairCoin-only seller.
     *
     * Never accepted from a request body, ever: the only writer is the create
     * path, reading it off a provider response to a call this gateway made
     * itself. A field a client could set is the account-takeover surface —
     * point a row at someone else's account and the transfers follow.
     */
    providerAccountId: text(),
    /**
     * ISO-3166-1 alpha-2, upper-case, as created and immutable at the provider.
     * Part of the CARD half — the FairCoin rail has no use for a country, and
     * asking a FairCoin-only seller for one would be a field nothing reads.
     */
    country: text(),
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
    /**
     * The FairCoin half's chain — set by the PLATFORM when it opens the half,
     * immutable afterwards, NULL when the seller takes no FairCoin.
     *
     * Also the target of `payment_intents (connected_account_id, merchant_id,
     * network)`, whose implicit `ON UPDATE RESTRICT` makes "immutable" physical
     * the moment one on-behalf intent exists.
     */
    network: text(),
    /**
     * The seller's Oxy identity: the ONLY user the hosted onboarding page lets
     * register the key (ADR 0012 D3). Supplied by the platform, which is the one
     * that knows who owns its store; no foreign key, it is Oxy's key space.
     */
    faircoinOxyUserId: text(),
    /**
     * The seller's watch-only ACCOUNT xpub. NULL until the seller registers it,
     * then immutable — the single writer is `registerFaircoinKey`, whose
     * `WHERE xpub IS NULL` is the immutability. Re-keying would re-interpret
     * every address already shown to a payer.
     *
     * Never on a DTO: an account xpub reveals every address of that account, so
     * a platform holding it would learn the seller's whole history (D6).
     */
    xpub: text(),
    /** When the seller registered `xpub` — the moment the FairCoin half became usable. */
    faircoinRegisteredAt: timestamptz(),
    /**
     * The NEXT unused BIP32 child index on this seller's key — the same counter
     * `merchants.next_derivation_index` is, with the same rules: `integer`
     * because the non-hardened index space is exactly `int4`, and claimed only
     * by the one-statement reservation in `db/accounts/accountDerivationIndex.ts`.
     */
    nextDerivationIndex: integer().notNull().default(0),
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
    unique('connected_accounts_merchant_external_ref_key').on(table.merchantId, table.externalRef),
    /** "Which seller is this?" — where every inbound account event starts. */
    unique('connected_accounts_provider_account_id_key').on(
      table.provider,
      table.providerAccountId,
    ),
    /**
     * The target of the on-behalf references in `schema/payments.ts`: the
     * account belongs to THAT platform and the intent's network is the
     * account's. `unique()` rather than `uniqueIndex()` for the ordering reason
     * `CONVENTIONS.md` records — and moved above the references by hand in the
     * migration, because on an existing table drizzle-kit emits it after them.
     */
    unique('connected_accounts_id_merchant_id_network_key').on(
      table.id,
      table.merchantId,
      table.network,
    ),
    /**
     * The network-free half of the reference above, for the reason ADR 0001 D6
     * gives: a NULL `network` switches a `MATCH SIMPLE` reference off entirely.
     */
    unique('connected_accounts_id_merchant_id_key').on(table.id, table.merchantId),
    /**
     * ONE key, ONE account (ADR 0012 D4).
     *
     * Two derivation counters walking the same key hand out the SAME addresses,
     * and two payments on one address are two payments the gateway can
     * attribute to neither. Global rather than per platform: a seller on two
     * marketplaces registering one pocket twice is exactly that collision.
     * Partial, because a pending half has no key yet.
     */
    uniqueIndex('connected_accounts_xpub_key').on(table.xpub).where(sql`${table.xpub} is not null`),
    /** The sync sweep: least-recently-synced first, never-synced ahead of all. */
    index('connected_accounts_sync_idx').on(table.provider, table.lastSyncedAt),
    foreignKey({
      name: 'connected_accounts_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check('connected_accounts_provider_check', sql.raw(`provider in (${inList(PROVIDER_IDS)})`)),
    // An empty string is a VALUE: it satisfies NOT NULL and collides for real in
    // the uniqueness above, so a merchant sending `""` would claim the one row
    // every other empty-ref seller wants.
    check('connected_accounts_external_ref_check', sql`length(${table.externalRef}) > 0`),
    check(
      'connected_accounts_provider_account_id_check',
      sql`length(${table.providerAccountId}) > 0`,
    ),
    check(
      'connected_accounts_country_check',
      sql`${table.country} = upper(${table.country}) and length(${table.country}) = 2`,
    ),
    /**
     * The card half is all there or not there at all. A provider with no
     * account id is an account nothing can act on; an account id with no
     * provider names an object in no numbering system; and a country without
     * the account is a card half that was never opened.
     */
    check(
      'connected_accounts_card_fields_agree_check',
      sql`(${table.provider} is null) = (${table.providerAccountId} is null)
          and (${table.provider} is null) = (${table.country} is null)`,
    ),
    check(
      'connected_accounts_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`),
    ),
    /**
     * The FairCoin half's three moments, in the only orders they can happen:
     * the platform opens it (`network` + the seller's Oxy id, together), and
     * later the seller registers the key (`xpub` + the time, together). A key
     * with no network cannot be interpreted — an extended key's version bytes
     * are network-specific — and a registered key with no recorded seller
     * would be a key nobody can say came from the seller.
     */
    check(
      'connected_accounts_faircoin_fields_agree_check',
      sql`(${table.network} is null) = (${table.faircoinOxyUserId} is null)
          and (${table.xpub} is null) = (${table.faircoinRegisteredAt} is null)
          and (${table.xpub} is null or ${table.network} is not null)`,
    ),
    /** A seller with neither half is a row nothing can pay. */
    check(
      'connected_accounts_has_a_rail_check',
      sql`${table.provider} is not null or ${table.network} is not null`,
    ),
    check(
      'connected_accounts_faircoin_oxy_user_id_check',
      sql`${table.faircoinOxyUserId} is null or length(${table.faircoinOxyUserId}) > 0`,
    ),
    check('connected_accounts_next_derivation_index_check', sql`${table.nextDerivationIndex} >= 0`),
    check(
      'connected_accounts_transfers_capability_check',
      sql.raw(
        `transfers_capability is null or transfers_capability in (${inList(CAPABILITY_STATUSES)})`,
      ),
    ),
    check(
      'connected_accounts_card_payments_capability_check',
      sql.raw(
        `card_payments_capability is null or card_payments_capability in (${inList(CAPABILITY_STATUSES)})`,
      ),
    ),
    check(
      'connected_accounts_requirements_check',
      sql`${table.requirementsCurrentlyDue} >= 0 and ${table.requirementsEventuallyDue} >= 0
          and ${table.requirementsPastDue} >= 0 and ${table.requirementsPendingVerification} >= 0`,
    ),
    // A code is a code — the allow-list form would be wrong, these are the
    // provider's own and their set grows on the provider's schedule. An EMPTY
    // one carries no meaning and renders as a blank bullet to a seller.
    check(
      'connected_accounts_disabled_reason_codes_check',
      sql`not ('' = any(${table.disabledReasonCodes}))`,
    ),
  ],
);

/**
 * A FairCoin onboarding link — the Peable-hosted page a SELLER opens to
 * register their watch-only key (ADR 0012 D3).
 *
 * Unlike the card rail's account link, which is the provider's object and is
 * never stored, this one is Peable's own, so it has to live somewhere — and it
 * lives here as a HASH. The plaintext token exists in one API response and in
 * the seller's address bar; a database read (a backup, a support query) yields
 * nothing that opens the page.
 *
 * The token alone is not enough either: the page also requires an Oxy session
 * for `connected_accounts.faircoin_oxy_user_id`. A leaked link is useless to
 * anyone else, which is what lets it live an hour rather than Stripe's minutes.
 */
export const connectedAccountLinks = pgTable(
  'connected_account_links',
  {
    id: generatedId(),
    connectedAccountId: text().notNull(),
    /** SHA-256 of the token, lowercase hex. The only form the token is stored in. */
    tokenHash: text().notNull(),
    /** Where the seller goes once the key is registered. The platform's. */
    returnUrl: text().notNull(),
    /** Where an EXPIRED link sends the seller, to ask the platform for a fresh one. */
    refreshUrl: text().notNull(),
    expiresAt: timestamptz().notNull(),
    /**
     * When the link was used. Single-use: a consumed link answers like an
     * expired one, so a link in a browser history cannot be replayed.
     */
    consumedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('connected_account_links_token_hash_key').on(table.tokenHash),
    index('connected_account_links_connected_account_id_idx').on(table.connectedAccountId),
    foreignKey({
      name: 'connected_account_links_connected_account_id_fkey',
      columns: [table.connectedAccountId],
      foreignColumns: [connectedAccounts.id],
    }).onDelete('restrict'),
    // 64 lowercase hex characters — a SHA-256 and nothing else. A plaintext
    // token written here by mistake would be refused rather than stored.
    check('connected_account_links_token_hash_check', sql.raw(`token_hash ~ '^[0-9a-f]{64}$'`)),
  ],
);
