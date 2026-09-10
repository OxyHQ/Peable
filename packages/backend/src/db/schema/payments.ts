import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { merchants } from './merchants';
import {
  BASE_UNIT_STRING_PATTERN,
  CARD_ONLY_STATUSES,
  CHAIN_ONLY_STATUSES,
  CURRENCY_CODES,
  NETWORK_TYPES,
  PAYMENT_INTENT_STATUS_VALUES,
  PROVIDER_IDS,
  RAIL_VALUES,
  SERVICE_ENVIRONMENTS,
} from './valueSets';

/**
 * `{}` — the empty metadata bag. Written as a SQL default rather than an
 * application one so a row inserted by a backfill or a repair statement gets
 * the same shape as one inserted through the repository.
 */
const emptyMetadata = sql`'{}'::jsonb`;

/**
 * A payment intent — the money record.
 *
 * `amount` stays a canonical base-unit STRING, as it is on the wire and in
 * `lib/money`. A `bigint` column would be decoded by postgres.js as a string
 * anyway, and an `int8` ceiling is not the domain's: the application works in
 * JS `bigint`, which is unbounded. The CHECK is what a `text` column would
 * otherwise be missing, and it is the same pattern `isBaseUnitString`
 * enforces.
 */
export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: generatedId(),
    /**
     * Public Stripe-parity identifier (`pi_…`), minted by `newId('pi')` — the
     * `id` every API surface and every DTO carries.
     *
     * The Mongo model called this field `id` while the other three public-id
     * tables called theirs `publicId`. One name here, for all four: the
     * primary key is the internal id, `public_id` is the external one.
     */
    publicId: text().notNull(),
    status: text().notNull(),
    /**
     * Which rail moves this payment (ADR 0001 D1).
     *
     * Defaults to `faircoin`: this table predates the card rail, so the default
     * is what every existing row IS rather than a guess, and it is what lets
     * the widening migration be additive.
     */
    rail: text().notNull().default('faircoin'),
    amount: text().notNull(),
    currency: text().notNull().default('FAIR'),
    /**
     * FairCoin rail only — NULL on a card payment, which has no network.
     *
     * Nullable since ADR 0001 D6, which is also why `payment_intents_merchant_id_fkey`
     * below exists: a NULL here switches the composite reference OFF entirely
     * (`MATCH SIMPLE`), and that reference was the only thing constraining
     * `merchant_id`. See `CONVENTIONS.md` §"A NULL in a composite reference".
     */
    network: text(),
    /** Watch-only receive address derived per intent from the merchant's xpub. FairCoin rail only. */
    address: text(),
    merchantId: text().notNull(),
    txid: text(),
    confirmations: integer().notNull().default(0),
    /**
     * Which provider moves this payment. Card rail only — NULL on faircoin,
     * where the chain is the provider and there is nobody to name.
     *
     * Chosen once, at creation, by `resolveCardProvider()`. Stored rather than
     * re-derived at read time because the registry's answer is a property of
     * the DEPLOYMENT and this is a property of the PAYMENT: a gateway that
     * later serves cards through a second provider must still be able to
     * capture, refund and reconcile a charge made through the first one.
     *
     * **Never on the DTO** (ADR 0001 D3). The whole point of the port is that a
     * merchant integrates against Peable and never learns which acquirer sat
     * behind their charge; a `provider` field on the wire would make that a
     * detail integrators start branching on, and then it could not be changed.
     */
    provider: text(),
    /**
     * The provider's own id for the object that moves the money — a Stripe
     * `pi_…`, under Stripe's numbering rather than ours.
     *
     * NULL between our insert and the provider call returning, and that window
     * is deliberate: the row is written FIRST so that a process that dies
     * mid-call leaves evidence of an attempt. Recovery re-calls the provider
     * with the same idempotency key (derived from `public_id`) and is handed
     * the same object back rather than making a second charge. Creating at the
     * provider first and inserting after would leave the opposite — a real
     * charge with no row anywhere, which nothing can find.
     */
    providerObjectId: text(),
    clientSecret: text().notNull(),
    idempotencyKey: text().notNull(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payment_intents_public_id_key').on(table.publicId),
    // Stripe-style idempotency: one intent per (merchant, Idempotency-Key).
    // Load-bearing — `createIntent` races on it and converges on the winner
    // rather than reading first.
    uniqueIndex('payment_intents_merchant_id_idempotency_key_key').on(
      table.merchantId,
      table.idempotencyKey
    ),
    // The list route filters and paginates by merchant; the compound unique
    // above is keyed on `idempotency_key` second and cannot serve it.
    index('payment_intents_merchant_id_idx').on(table.merchantId),
    // `services/enrichment.ts` resolves intents by address.
    index('payment_intents_address_idx').on(table.address),
    /**
     * One intent per provider object, and the lookup the event drain makes.
     *
     * UNIQUE rather than a plain index, and that is the load-bearing half: a
     * provider event names an object, and the drain turns that into a state
     * change on the intent it belongs to. If two intents could name one Stripe
     * `pi_…`, a single `payment_intent.succeeded` would settle a payment that
     * was never charged. Partial, because the column is NULL for the whole
     * FairCoin rail and for the window between our insert and the provider
     * call returning — and NULLs are distinct, so an unpartitioned unique index
     * would work too, but says less about what is being promised.
     */
    uniqueIndex('payment_intents_provider_object_key')
      .on(table.provider, table.providerObjectId)
      .where(sql`${table.providerObjectId} is not null`),
    /**
     * The network firewall, made structural.
     *
     * `createIntent` throws `NetworkMismatchError` when the requested network
     * is not the merchant's, because a `network` label that disagrees with the
     * network the `address` actually encodes sends a payer's funds to an
     * address nobody is watching. This composite reference is that same rule
     * expressed where no future code path can route around it, and its
     * implicit `on update restrict` additionally means a merchant's network
     * cannot be changed out from under an intent that already exists.
     */
    foreignKey({
      name: 'payment_intents_merchant_id_network_fkey',
      columns: [table.merchantId, table.network],
      foreignColumns: [merchants.id, merchants.network],
    }).onDelete('restrict'),
    /**
     * What keeps `merchant_id` referential once `network` may be NULL.
     *
     * NOT redundant with the composite reference above, and the difference is
     * the whole of ADR 0001 D6. A composite foreign key defaults to `MATCH
     * SIMPLE`, which performs NO CHECK AT ALL as soon as any referencing column
     * is NULL — so on a card intent the reference above is vacuous, and it was
     * the ONLY thing pointing this column at `merchants`. MEASURED on
     * PostgreSQL 16.13: without this constraint, a card intent naming
     * `'ghost-merchant'` was accepted.
     *
     * `MATCH FULL` is the obvious alternative and is wrong: it demands
     * all-or-nothing nullity, and `merchant_id` is NOT NULL, so it refuses
     * every card intent outright.
     */
    foreignKey({
      name: 'payment_intents_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'payment_intents_status_check',
      sql.raw(`status in (${inList(PAYMENT_INTENT_STATUS_VALUES)})`)
    ),
    check('payment_intents_rail_check', sql.raw(`rail in (${inList(RAIL_VALUES)})`)),
    check('payment_intents_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    /**
     * The FairCoin rail settles in FAIR, and only it does.
     *
     * A FAIR-denominated card charge and a EUR-denominated chain payment are
     * both expressible in the column types and neither is a payment this
     * gateway can make: the second needs an FX conversion at settlement time
     * that nothing here performs, and would quietly store an amount whose unit
     * disagrees with the coins that arrive. `assertRailCurrency` in
     * `services/createIntent.ts` refuses both with a 422; this is the same rule
     * where a write that skipped it still has to pass.
     */
    check(
      'payment_intents_rail_currency_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.currency} = 'FAIR')`
    ),
    check(
      'payment_intents_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`)
    ),
    /**
     * The FairCoin rail's own requirement, in the one place a write that
     * skipped the application still has to pass. A `faircoin` intent with no
     * address is a payer with nowhere to send money; with no network it is an
     * address nobody can say which chain it is on.
     */
    check(
      'payment_intents_faircoin_requires_chain_fields_check',
      sql`${table.rail} <> 'faircoin' or (${table.address} is not null and ${table.network} is not null)`
    ),
    /**
     * And the converse, which is not decoration: a card payment that carried an
     * address would be a reserved derivation index nobody can ever settle, and
     * a card payment naming a network would make the composite reference above
     * bind — refusing a legal payment or, worse, tying a card charge to a chain.
     */
    check(
      'payment_intents_card_has_no_chain_fields_check',
      sql`${table.rail} <> 'card' or (${table.address} is null and ${table.network} is null and ${table.txid} is null and ${table.confirmations} = 0)`
    ),
    /**
     * ADR 0001 D5: the four chain states describe a transaction on a blockchain
     * and the four card states describe an authorization at an acquirer.
     * Neither set is expressible on the other rail, and the sets come from the
     * contract (`CHAIN_ONLY_STATUSES` / `CARD_ONLY_STATUSES`) rather than being
     * retyped here, so they cannot drift from the transition table.
     */
    check(
      'payment_intents_chain_statuses_are_faircoin_check',
      sql.raw(
        `status not in (${inList(CHAIN_ONLY_STATUSES)}) or rail = 'faircoin'`
      )
    ),
    check(
      'payment_intents_card_statuses_are_card_check',
      sql.raw(`status not in (${inList(CARD_ONLY_STATUSES)}) or rail = 'card'`)
    ),
    check(
      'payment_intents_provider_check',
      sql.raw(`provider is null or provider in (${inList(PROVIDER_IDS)})`)
    ),
    /**
     * The rail decides whether there is a provider, in both directions.
     *
     * A card intent with no provider is a charge nobody can capture, refund or
     * reconcile — the object exists at an acquirer this row cannot name. A
     * faircoin intent WITH one is the more dangerous shape: it would make the
     * drain's lookup match a chain payment, so a Stripe event could transition
     * an intent whose money is on a blockchain.
     */
    check(
      'payment_intents_card_requires_provider_check',
      sql`${table.rail} <> 'card' or ${table.provider} is not null`
    ),
    check(
      'payment_intents_faircoin_has_no_provider_check',
      sql`${table.rail} <> 'faircoin' or (${table.provider} is null and ${table.providerObjectId} is null)`
    ),
    /**
     * An object id without a provider names an object in no numbering system —
     * `pi_1` is ambiguous the moment a second provider exists, and it would
     * make the unique index above compare across providers.
     *
     * **Redundant today, and kept deliberately.** MEASURED: with the two rail
     * checks above in place this one is unreachable, because every rail either
     * requires a provider or forbids an object id; drop them both and it fires
     * on its own. It is here so the invariant survives a THIRD rail that
     * requires no provider — the rail checks are written per rail and would not
     * cover it, and this one would.
     */
    check(
      'payment_intents_provider_object_needs_provider_check',
      sql`${table.providerObjectId} is null or ${table.provider} is not null`
    ),
    check('payment_intents_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check('payment_intents_confirmations_check', sql`${table.confirmations} >= 0`),
    check('payment_intents_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    /**
     * A broadcast, confirming or settled FAIRCOIN intent HAS a transaction id.
     *
     * Verified against every writer rather than assumed: `POST
     * /v1/payment_intents/:id/submit_tx` is the only path to `broadcast` and
     * it sets `txid` in the same write, and `confirming`/`settled` are reached
     * only by the settlement watcher, which selects on `txid` being present.
     * `failed` is deliberately outside the set — `approved → failed` is a legal
     * transition that no writer pairs with a txid.
     *
     * **`rail = 'faircoin'` is a REPAIR, not a widening** (ADR 0001 D5).
     * `settled` is a shared status: it is where a card charge lands too, and a
     * card payment can never have a txid. Left unqualified, this constraint
     * would have refused every settled card payment — the first one, in
     * production, with every test green, because no fixture could reach that
     * state before the rail existed. `broadcast` and `confirming` are
     * chain-only and already unreachable on a card by the CHECK above, so the
     * qualifier changes nothing for them.
     *
     * The fixture argument in `CONVENTIONS.md` still holds unchanged: a
     * txid-less `broadcast` row is still unrepresentable, so `failed` is still
     * the only status that both permits a missing txid and reaches
     * `findWatchableIntents`.
     */
    check(
      'payment_intents_broadcast_requires_txid_check',
      sql`${table.rail} <> 'faircoin' or ${table.status} not in ('broadcast', 'confirming', 'settled') or ${table.txid} is not null`
    ),
  ]
);

/**
 * A hosted-checkout session wrapping exactly ONE payment intent.
 *
 * Immutable after creation: there is no PATCH route, and a merchant needing a
 * different amount creates a new session. The wrapped intent's `client_secret`
 * is deliberately not duplicated here — `toCheckoutSessionDTO` reads it off the
 * intent, so there is exactly one place a client secret is ever persisted.
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: generatedId(),
    /** Public Stripe-parity identifier (`cs_…`), minted by `newId('cs')`. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /** Denormalized from the merchant at creation time — held true by the composite reference below. */
    oxyAppId: text().notNull(),
    environment: text().notNull(),
    paymentIntentId: text()
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'restrict' }),
    amount: text().notNull(),
    currency: text().notNull().default('FAIR'),
    /** Which rail the wrapped intent uses. Denormalized from it at creation. */
    rail: text().notNull().default('faircoin'),
    /** FairCoin rail only — NULL on a card session. See ADR 0001 D6. */
    network: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    successUrl: text(),
    cancelUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('checkout_sessions_public_id_key').on(table.publicId),
    /**
     * "Wraps exactly ONE payment intent" in the only form that cannot be
     * violated. Every session mints a fresh intent today (`createIntent`
     * without a caller `Idempotency-Key`), so this refuses nothing that
     * happens; what it refuses is a future change that lets two sessions share
     * one intent, which is the bug the sentence above exists to prevent.
     */
    uniqueIndex('checkout_sessions_payment_intent_id_key').on(table.paymentIntentId),
    index('checkout_sessions_oxy_app_id_environment_idx').on(table.oxyAppId, table.environment),
    index('checkout_sessions_merchant_id_idx').on(table.merchantId),
    // Denormalization that cannot drift: the three copied fields are carried
    // by the reference itself, so they are the merchant's values or the row
    // does not exist. See `payment_intents`' equivalent for the network half.
    foreignKey({
      name: 'checkout_sessions_merchant_identity_fkey',
      columns: [table.merchantId, table.oxyAppId, table.environment, table.network],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment, merchants.network],
    }).onDelete('restrict'),
    /**
     * The network-free half of that identity, and the reason it is not
     * redundant is ADR 0001 D6: with `network` NULL on a card session, the
     * four-column reference above is satisfied without any check at all
     * (`MATCH SIMPLE`), so `oxy_app_id` and `environment` stop being guaranteed
     * along with it. MEASURED: with this reference present, a card session
     * naming the wrong `environment` is refused; without it, accepted.
     */
    foreignKey({
      name: 'checkout_sessions_merchant_identity_no_network_fkey',
      columns: [table.merchantId, table.oxyAppId, table.environment],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
    }).onDelete('restrict'),
    check(
      'checkout_sessions_environment_check',
      sql.raw(`environment in (${inList(SERVICE_ENVIRONMENTS)})`)
    ),
    check('checkout_sessions_rail_check', sql.raw(`rail in (${inList(RAIL_VALUES)})`)),
    check('checkout_sessions_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'checkout_sessions_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`)
    ),
    check(
      'checkout_sessions_rail_network_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.network} is not null)`
    ),
    // Same rule as `payment_intents_rail_currency_agrees_check`, for the same
    // reason: these rows carry the price a payer will be shown, and a rail that
    // disagreed with the currency would show one and charge the other.
    check(
      'checkout_sessions_rail_currency_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.currency} = 'FAIR')`
    ),
    check('checkout_sessions_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check(
      'checkout_sessions_metadata_object_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`
    ),
  ]
);

/**
 * A shareable, reusable generator of payment intents.
 *
 * A link's price is immutable once shared: only `active`, `metadata` and
 * `success_url` are mutable through `PATCH /v1/payment_links/:id`.
 */
export const paymentLinks = pgTable(
  'payment_links',
  {
    id: generatedId(),
    /** Public Stripe-parity identifier (`link_…`), minted by `newId('link')`. */
    publicId: text().notNull(),
    merchantId: text().notNull(),
    /** Denormalized from the merchant at creation time — held true by the composite reference below. */
    oxyAppId: text().notNull(),
    environment: text().notNull(),
    amount: text().notNull(),
    currency: text().notNull().default('FAIR'),
    /** Which rail the intents this link mints will use. */
    rail: text().notNull().default('faircoin'),
    /** FairCoin rail only — NULL on a card link. See ADR 0001 D6. */
    network: text(),
    active: boolean().notNull().default(true),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    successUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payment_links_public_id_key').on(table.publicId),
    index('payment_links_oxy_app_id_environment_idx').on(table.oxyAppId, table.environment),
    index('payment_links_merchant_id_idx').on(table.merchantId),
    foreignKey({
      name: 'payment_links_merchant_identity_fkey',
      columns: [table.merchantId, table.oxyAppId, table.environment, table.network],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment, merchants.network],
    }).onDelete('restrict'),
    /** The network-free half. Same reason as `checkout_sessions`' — ADR 0001 D6. */
    foreignKey({
      name: 'payment_links_merchant_identity_no_network_fkey',
      columns: [table.merchantId, table.oxyAppId, table.environment],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment],
    }).onDelete('restrict'),
    check(
      'payment_links_environment_check',
      sql.raw(`environment in (${inList(SERVICE_ENVIRONMENTS)})`)
    ),
    check('payment_links_rail_check', sql.raw(`rail in (${inList(RAIL_VALUES)})`)),
    check('payment_links_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'payment_links_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`)
    ),
    check(
      'payment_links_rail_network_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.network} is not null)`
    ),
    // Same rule as `payment_intents_rail_currency_agrees_check`, for the same
    // reason: these rows carry the price a payer will be shown, and a rail that
    // disagreed with the currency would show one and charge the other.
    check(
      'payment_links_rail_currency_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.currency} = 'FAIR')`
    ),
    check('payment_links_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check('payment_links_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ]
);
