import type { CheckoutContactCollection } from '@peable.to/contracts/vocabulary/checkout';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
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
import type {
  CheckoutConsent,
  CheckoutCustomerDetails,
  CheckoutShippingDetails,
  FaircoinQuote,
  PaymentIntentLastPaymentError,
  Shipping,
} from '@peable.to/shared-types';
import { coupons, promotionCodes } from './catalog';
import { connectedAccounts } from './connectedAccounts';
import { customers, paymentMethods } from './customers';
import { merchants } from './merchants';
import { paymentMethodConfigurations } from './paymentMethodConfigurations';
import { setupIntents } from './setupIntents';
import { SOCIAL_RECEIVE_FIRST_FRESH_INDEX } from './social';
import {
  AFTER_COMPLETION_TYPES,
  AUTOMATIC_TAX_STATUSES,
  type CHECKOUT_BILLING_ADDRESS_COLLECTIONS,
  CHECKOUT_CUSTOMER_CREATIONS,
  CHECKOUT_LOCALES,
  CHECKOUT_PAYMENT_STATUSES,
  CHECKOUT_SESSION_MODES,
  CHECKOUT_SESSION_STATUSES,
  CHECKOUT_SUBMIT_TYPES,
  CHECKOUT_UI_MODES,
  BASE_UNIT_STRING_PATTERN,
  IDENTITY_PUBLIC_KEY_PATTERN,
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  CANCELLATION_REASON_VALUES,
  CAPTURE_METHOD_VALUES,
  CARD_ONLY_STATUSES,
  CURRENCY_CODES,
  NETWORK_TYPES,
  PAYMENT_INTENT_STATUS_VALUES,
  PROVIDER_IDS,
  RAIL_VALUES,
  SERVICE_ENVIRONMENTS,
  SETUP_FUTURE_USAGE_VALUES,
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
     * One name for all four public-id tables: the primary key is the
     * internal id, `public_id` is the external one.
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
    paymentLinkId: text().references((): AnyPgColumn => paymentLinks.id, { onDelete: 'restrict' }),
    merchantId: text().notNull(),
    /**
     * The seller this payment is made ON BEHALF OF (ADR 0012 D5) — the
     * connected account whose xpub `address` derives from. NULL for a payment
     * to the merchant itself, which is every payment that predates ADR 0012.
     *
     * The MERCHANT still owns the row: authentication, listing, `reject`, the
     * outbox and every webhook are the platform's. This column says where the
     * money goes, not whose record it is.
     */
    connectedAccountId: text(),
    /**
     * A DESTINATION charge (ADR 0015 §2), card only: the account the funds go
     * to, the amount transferred when a platform named one (NULL = the whole
     * amount less the fee), the account that is merchant of record
     * (`on_behalf_of`), and Orbit's fee — the INSTRUCTION sent to the provider;
     * the fee actually taken is the `application_fees` row. All NULL on a
     * platform charge. Decided once, at create, and replayed from the row on a
     * resumed provider create so a retry sends the same charge.
     */
    transferDestinationId: text(),
    transferAmount: text(),
    onBehalfOfId: text(),
    applicationFeeAmount: text(),
    /**
     * `network`, but only on a payment to the merchant ITSELF — NULL on an
     * on-behalf one. Computed by the server, never written.
     *
     * It exists to be the referencing column of the network firewall
     * (`payment_intents_merchant_id_network_fkey`). That reference used to read
     * `network` directly, which would refuse every on-behalf intent of a
     * card-only platform: the platform's own network is NULL, the intent's is
     * the seller's. Reading this column instead keeps the firewall binding
     * every direct FairCoin intent exactly as before and makes it vacuous
     * (`MATCH SIMPLE`) for an on-behalf one, whose firewall is the account
     * reference below. Raw SQL rather than column references, because a
     * generation expression may only name its own table's columns and the
     * qualified form drizzle would render is not something to depend on.
     */
    merchantNetwork: text().generatedAlwaysAs(
      sql.raw('case when connected_account_id is null then network end'),
    ),
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
    /**
     * The provider's id for the CHARGE this payment produced — a Stripe `ch_…`.
     *
     * A SECOND id, beside `provider_object_id`, because they are different
     * objects and one of them is the wrong answer to a question that matters:
     * a transfer's `source_transaction` names the CHARGE, and `transferService`
     * used to hand it the payment's `pi_…`. Stripe answers `No such charge`, so
     * the settlement fails at the provider — which reads as an outage rather
     * than as a mix-up two functions away.
     *
     * NULL until the payment produces one, which is most of a card payment's
     * life and all of a FairCoin one. Filled from `latest_charge` by whichever
     * authoritative read gets there first (a settlement transition, a transfer
     * resolving its source), so the association is recorded once rather than
     * re-derived per settlement — a multi-seller cart would otherwise re-read
     * the payment once per seller.
     */
    providerChargeId: text(),
    /** The customer (`cus_…`) this payment is for, when the merchant named one (ADR 0016). */
    customerId: text(),
    /** The saved card (`pm_…`) it is charged to. Card only. */
    paymentMethodId: text(),
    /**
     * What the payer may pay with — card rail only (the chain's is `faircoin`,
     * by its rail). Fixed at creation: the types the merchant named, or those
     * the configuration offered in this currency when the payment was made, so
     * a later configuration change never re-prices what a payer was shown.
     */
    paymentMethodTypes: text().array(),
    /** The `pmc_…` whose methods this card payment offers; NULL when types were named. Card only. */
    paymentMethodConfigurationId: text(),
    /** `automatic` captures at confirmation; `manual` holds the authorization (card only). */
    captureMethod: text().notNull().default('automatic'),
    /** Card only: keep the payment method on the customer for later. */
    setupFutureUsage: text(),
    description: text(),
    receiptEmail: text(),
    /** Card only. */
    statementDescriptorSuffix: text(),
    shipping: jsonb().$type<Shipping>(),
    /**
     * The fiat order a FairCoin payment pays, as quoted (ADR 0021 D4) — the
     * wire's `faircoin.quote`, stored in that shape. `null` on a FAIR-priced
     * payment and always on the card rail. Written once, at creation.
     */
    faircoinQuote: jsonb().$type<FaircoinQuote>(),
    /**
     * The Oxy account whose Peable wallet this FairCoin payment pays (ADR 0021
     * D5): the merchant's owner, or the seller's own account. The address was
     * reserved on that account's cursor from its identity key at creation and
     * never moves with a later rotation (ADR 0002). NULL on a card payment and
     * on FairCoin payments made before identity receive (to a registered xpub).
     */
    faircoinRecipientAccountId: text(),
    /**
     * The identity public key output 0's address was derived from (ADR 0002,
     * amended 2026-11-06): the recipient's DID `#key-1` as read FRESH at the
     * reservation, lowercase hex as the DID publishes it. Every output keeps its
     * own in `payment_intent_outputs.identity_public_key`; this is output 0's,
     * beside its `address` and `faircoin_recipient_account_id`. A payment whose
     * key is no longer the recipient's `#key-1` is never offered to a payer
     * again (`services/faircoin/keyBinding.ts`).
     *
     * NULL on a card payment and on every FairCoin payment written before keys
     * were recorded — no CHECK requires it, because a NOT VALID CHECK is still
     * enforced on the UPDATE that moves such a payment's status.
     */
    faircoinIdentityPublicKey: text(),
    /**
     * When Peable found a recipient's key replaced on a payment the payer had
     * already broadcast — the coins are at an address of the PREVIOUS key. Set
     * once (never cleared, a reorg included) and on the wire as
     * `faircoin.recipient_key_replaced_at`. NULL otherwise.
     */
    faircoinRecipientKeyReplacedAt: timestamptz(),
    /**
     * Why the last attempt failed, in Peable's words (ADR 0019). Written in the
     * same statement as the transition that the failure caused; cleared by any
     * other transition.
     */
    lastPaymentError: jsonb().$type<PaymentIntentLastPaymentError>(),
    /** Set exactly when `status` is `canceled`; NULL there means nobody said why. */
    cancellationReason: text(),
    canceledAt: timestamptz(),
    /**
     * What was received — the captured amount — once `succeeded`; `"0"` in every
     * other status (a reorg that rewinds a FairCoin payment resets it).
     */
    amountReceived: text().notNull().default('0'),
    clientSecret: text().notNull(),
    idempotencyKey: text().notNull(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('payment_intents_payment_link_id_idx').on(table.paymentLinkId),
    // `GET /v1/payment_intents?customer=`. Built CONCURRENTLY out of band first (0044).
    index('payment_intents_customer_id_idx').on(table.customerId),
    uniqueIndex('payment_intents_public_id_key').on(table.publicId),
    // Stripe-style idempotency: one intent per (merchant, Idempotency-Key).
    // Load-bearing — `createIntent` races on it and converges on the winner
    // rather than reading first.
    uniqueIndex('payment_intents_merchant_id_idempotency_key_key').on(
      table.merchantId,
      table.idempotencyKey,
    ),
    // The list route filters and paginates by merchant; the compound unique
    // above is keyed on `idempotency_key` second and cannot serve it.
    index('payment_intents_merchant_id_idx').on(table.merchantId),
    // Every list and search walks `merchant_id = … order by id desc limit n`;
    // this serves the walk itself, so a page reads n rows, not the merchant's
    // every row then a sort. Built CONCURRENTLY out of band first (0063).
    index('payment_intents_merchant_id_id_idx').on(table.merchantId, table.id),
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
      columns: [table.merchantId, table.merchantNetwork],
      foreignColumns: [merchants.id, merchants.network],
    }).onDelete('restrict'),
    /**
     * The network firewall for an ON-BEHALF payment (ADR 0012 D5), and the
     * ownership rule with it: the account belongs to THIS merchant, and the
     * intent's network is the ACCOUNT's. Its implicit `ON UPDATE RESTRICT` also
     * makes the account's network immutable once one intent exists.
     *
     * Always binding when `connected_account_id` is set: the CHECK below keeps
     * that column to the FairCoin rail, and the FairCoin rail requires a
     * network, so no NULL can switch this reference off.
     */
    foreignKey({
      name: 'payment_intents_connected_account_network_fkey',
      columns: [table.connectedAccountId, table.merchantId, table.network],
      foreignColumns: [
        connectedAccounts.id,
        connectedAccounts.merchantId,
        connectedAccounts.network,
      ],
    }).onDelete('restrict'),
    /** The network-free companion — ADR 0001 D6's rule for every composite reference. */
    foreignKey({
      name: 'payment_intents_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    // "Every payment for this seller" — the platform's per-seller listing.
    index('payment_intents_connected_account_id_idx').on(table.connectedAccountId),
    /**
     * On-behalf payments are FairCoin payments (ADR 0012 D5). An on-behalf CARD
     * charge is ADR 0009's open merchant-of-record decision, and a row that
     * pre-empted it would be a decision taken by a constraint nobody reviewed.
     */
    check(
      'payment_intents_connected_account_is_faircoin_check',
      sql`${table.connectedAccountId} is null or ${table.rail} = 'faircoin'`,
    ),
    /** The destination and the merchant of record are THIS merchant's accounts. */
    foreignKey({
      name: 'payment_intents_transfer_destination_merchant_fkey',
      columns: [table.transferDestinationId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_intents_on_behalf_of_merchant_fkey',
      columns: [table.onBehalfOfId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    /**
     * The destination-charge fields are card fields, and they agree the way the
     * provider requires: a fee or a transfer amount needs a destination, a
     * transfer amount and a fee are never both set, and neither exceeds the
     * payment.
     */
    check(
      'payment_intents_destination_fields_check',
      sql.raw(
        `(rail = 'card' or (transfer_destination_id is null and on_behalf_of_id is null and application_fee_amount is null and transfer_amount is null))
          and (application_fee_amount is null or transfer_destination_id is not null)
          and (transfer_amount is null or transfer_destination_id is not null)
          and (application_fee_amount is null or transfer_amount is null)
          and (application_fee_amount is null or (application_fee_amount ~ '${BASE_UNIT_STRING_PATTERN}' and application_fee_amount::numeric <= amount::numeric))
          and (transfer_amount is null or (transfer_amount ~ '${BASE_UNIT_STRING_PATTERN}' and transfer_amount::numeric <= amount::numeric))`,
      ),
    ),
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
      sql.raw(`status in (${inList(PAYMENT_INTENT_STATUS_VALUES)})`),
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
     * `services/createIntent.ts` refuses both with a 400; this is the same rule
     * where a write that skipped it still has to pass.
     */
    check(
      'payment_intents_rail_currency_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.currency} = 'FAIR')`,
    ),
    check(
      'payment_intents_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`),
    ),
    /**
     * The FairCoin rail's own requirement, in the one place a write that
     * skipped the application still has to pass. A `faircoin` intent with no
     * address is a payer with nowhere to send money; with no network it is an
     * address nobody can say which chain it is on.
     */
    check(
      'payment_intents_faircoin_requires_chain_fields_check',
      sql`${table.rail} <> 'faircoin' or (${table.address} is not null and ${table.network} is not null)`,
    ),
    /**
     * And the converse, which is not decoration: a card payment that carried an
     * address would be a reserved derivation index nobody can ever settle, and
     * a card payment naming a network would make the composite reference above
     * bind — refusing a legal payment or, worse, tying a card charge to a chain.
     */
    check(
      'payment_intents_card_has_no_chain_fields_check',
      sql`${table.rail} <> 'card' or (${table.address} is null and ${table.network} is null and ${table.txid} is null and ${table.confirmations} = 0)`,
    ),
    /**
     * ADR 0019: a FairCoin payment requires no payment method, has nothing to
     * confirm server-side and no authorization to capture. The set comes from
     * the contract (`CARD_ONLY_STATUSES`) so it cannot drift from the table.
     */
    check(
      'payment_intents_card_statuses_are_card_check',
      sql.raw(`status not in (${inList(CARD_ONLY_STATUSES)}) or rail = 'card'`),
    ),
    check(
      'payment_intents_cancellation_reason_check',
      sql.raw(
        `cancellation_reason is null or cancellation_reason in (${inList(CANCELLATION_REASON_VALUES)})`,
      ),
    ),
    /** A reason and an instant belong to a cancelled intent, and only to one. */
    check(
      'payment_intents_canceled_agrees_check',
      sql`(${table.status} = 'canceled') = (${table.canceledAt} is not null) and (${table.cancellationReason} is null or ${table.status} = 'canceled')`,
    ),
    check(
      'payment_intents_capture_method_check',
      sql.raw(`capture_method in (${inList(CAPTURE_METHOD_VALUES)})`),
    ),
    check(
      'payment_intents_setup_future_usage_check',
      sql.raw(
        `setup_future_usage is null or setup_future_usage in (${inList(SETUP_FUTURE_USAGE_VALUES)})`,
      ),
    ),
    /** The card-only fields stay off the chain rail, where they mean nothing. */
    check(
      'payment_intents_card_only_fields_check',
      sql`${table.rail} = 'card' or (${table.paymentMethodId} is null and ${table.setupFutureUsage} is null and ${table.captureMethod} = 'automatic' and ${table.statementDescriptorSuffix} is null)`,
    ),
    check(
      'payment_intents_amount_received_check',
      sql.raw(`amount_received ~ '${BASE_UNIT_STRING_PATTERN}'`),
    ),
    /** Money is received only by a payment that succeeded, and never more than it asked. */
    check(
      'payment_intents_amount_received_agrees_check',
      sql`(${table.amountReceived} = '0' or ${table.status} = 'succeeded') and ${table.amountReceived}::numeric <= ${table.amount}::numeric`,
    ),
    check(
      'payment_intents_last_payment_error_object_check',
      sql`${table.lastPaymentError} is null or jsonb_typeof(${table.lastPaymentError}) = 'object'`,
    ),
    check(
      'payment_intents_shipping_object_check',
      sql`${table.shipping} is null or jsonb_typeof(${table.shipping}) = 'object'`,
    ),
    check(
      'payment_intents_faircoin_recipient_check',
      sql`${table.faircoinRecipientAccountId} is null or ${table.rail} = 'faircoin'`,
    ),
    /** The key an address derives from: a FairCoin payment's, lowercase hex. */
    check(
      'payment_intents_faircoin_identity_key_check',
      sql.raw(
        `faircoin_identity_public_key is null or (rail = 'faircoin' and faircoin_identity_public_key ~ '${IDENTITY_PUBLIC_KEY_PATTERN}')`,
      ),
    ),
    check(
      'payment_intents_faircoin_key_replaced_check',
      sql`${table.faircoinRecipientKeyReplacedAt} is null or ${table.rail} = 'faircoin'`,
    ),
    /** A quote prices a FairCoin payment; a card payment is charged in its own currency. */
    check(
      'payment_intents_faircoin_quote_check',
      sql`${table.faircoinQuote} is null or (${table.rail} = 'faircoin' and jsonb_typeof(${table.faircoinQuote}) = 'object')`,
    ),
    /**
     * Only a card payment carries types; a chain payment is FairCoin by its rail.
     *
     * One direction only, on purpose: card rows written before payment method
     * breadth hold none until the post-phase backfill, and the outgoing image
     * keeps writing them without during the rollout. The writer
     * (`resolveCardPaymentMethods` → `insertPaymentIntent`) always sets them.
     */
    check(
      'payment_intents_payment_method_types_rail_check',
      sql`${table.rail} = 'card' or ${table.paymentMethodTypes} is null`,
    ),
    check(
      'payment_intents_payment_method_types_check',
      sql.raw(
        `payment_method_types is null or (cardinality(payment_method_types) >= 1 and payment_method_types <@ ARRAY[${inList(CARD_RAIL_PAYMENT_METHOD_TYPES)}]::text[])`,
      ),
    ),
    check(
      'payment_intents_payment_method_configuration_card_check',
      sql`${table.rail} = 'card' or ${table.paymentMethodConfigurationId} is null`,
    ),
    /** The configuration is this merchant's. */
    foreignKey({
      name: 'payment_intents_payment_method_configuration_merchant_fkey',
      columns: [table.paymentMethodConfigurationId, table.merchantId],
      foreignColumns: [paymentMethodConfigurations.id, paymentMethodConfigurations.merchantId],
    }).onDelete('restrict'),
    /** The customer is this merchant's. */
    foreignKey({
      name: 'payment_intents_customer_merchant_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    /** ...and so is the payment method. */
    foreignKey({
      name: 'payment_intents_payment_method_merchant_fkey',
      columns: [table.paymentMethodId, table.merchantId],
      foreignColumns: [paymentMethods.id, paymentMethods.merchantId],
    }).onDelete('restrict'),
    check(
      'payment_intents_provider_check',
      sql.raw(`provider is null or provider in (${inList(PROVIDER_IDS)})`),
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
      sql`${table.rail} <> 'card' or ${table.provider} is not null`,
    ),
    check(
      'payment_intents_faircoin_has_no_provider_check',
      sql`${table.rail} <> 'faircoin' or (${table.provider} is null and ${table.providerObjectId} is null and ${table.providerChargeId} is null)`,
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
      sql`${table.providerObjectId} is null or ${table.provider} is not null`,
    ),
    check('payment_intents_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check('payment_intents_confirmations_check', sql`${table.confirmations} >= 0`),
    check('payment_intents_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    /**
     * A `processing` or `succeeded` FAIRCOIN intent HAS a transaction id
     * (ADR 0019: `processing` is the old `broadcast`/`confirming`).
     *
     * Verified against every writer: `POST /v1/payment_intents/:id/submit_tx`
     * is the only path to `processing` on the chain and sets `txid` in the same
     * write, and `succeeded` is reached only by the settlement watcher, which
     * selects on `txid` being present. `canceled` is deliberately outside the
     * set — an expired intent has none, an underpaid one has one.
     *
     * `rail = 'faircoin'`: a card payment is `processing` and `succeeded` too,
     * and can never have a txid. The fixture argument in `CONVENTIONS.md`
     * still holds: a txid-less `processing` FairCoin row is unrepresentable, so
     * the txid predicate of `findWatchableIntents` is exercised with a
     * `canceled` one.
     */
    check(
      'payment_intents_processing_requires_txid_check',
      sql`${table.rail} <> 'faircoin' or ${table.status} not in ('processing', 'succeeded') or ${table.txid} is not null`,
    ),
  ],
);

/**
 * What a session (or a payment link, for the sessions it creates) collects
 * from the payer, AS STORED. Validated by the one writer
 * (`services/checkout/params.ts`); the wire's shapes are rendered from it by
 * `lib/serializeCheckout.ts`, so a wire change never reaches storage.
 */
export interface StoredCheckoutCollection {
  /** Missing on older rows: collect email. Only the merchant creates this policy. */
  readonly contactCollection?: CheckoutContactCollection;
  readonly billingAddressCollection: (typeof CHECKOUT_BILLING_ADDRESS_COLLECTIONS)[number];
  /** ISO 3166-1 alpha-2 codes; `null` when no shipping address is collected. */
  readonly shippingCountries: readonly string[] | null;
  readonly phoneNumber: boolean;
  readonly taxId: boolean;
  readonly termsOfService: boolean;
}

/** A custom field as stored: its definition and, on a session, the payer's value. */
export interface StoredCustomField {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'numeric' | 'dropdown';
  readonly optional: boolean;
  readonly options: readonly { readonly label: string; readonly value: string }[] | null;
  readonly minimumLength: number | null;
  readonly maximumLength: number | null;
  readonly value: string | null;
}

/**
 * A Checkout Session — an ORDER the payer completes (Orbit Phase 3).
 *
 * The session prices its line items (`checkout_session_line_items`) and owns
 * the totals; the payment it needs is created when the payer CONFIRMS
 * (`payment_intent_id`, or `setup_intent_id` in setup mode), so both are NULL
 * on an open session nobody has confirmed. `amount` is the session's
 * `amount_total`: the column kept its name so the image that predates the
 * order model could keep serving while this one rolled out.
 *
 * The client secret is the payer's capability over the SESSION — hosted
 * checkout's `#cs=` fragment and embedded mode's `client_secret`. A session
 * that wraps a payment also accepts that payment's secret, which already
 * authorizes paying it (`routes/checkoutSessions.ts`).
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
    mode: text().notNull().default('payment'),
    status: text().notNull().default('open'),
    paymentStatus: text().notNull().default('unpaid'),
    uiMode: text().notNull().default('hosted'),
    /** `null` follows the payer's browser. */
    locale: text(),
    /**
     * The language the payer confirmed in (`…/public/confirm`'s `locale`) —
     * internal, never on the wire, and never written over `locale`, which is
     * the merchant's. A customer checkout creates takes it as its
     * `preferred_locales`, and the session's emails fall back to it.
     */
    payerLocale: text(),
    submitType: text().notNull().default('auto'),
    /** `cs_…_secret_…`. NULL only on a row that predates the order model, until its backfill. */
    clientSecret: text(),
    /** The payment, once the payer confirmed; never in setup mode. */
    paymentIntentId: text().references(() => paymentIntents.id, { onDelete: 'restrict' }),
    /** Setup mode: the SetupIntent, once the payer confirmed. */
    setupIntentId: text().references(() => setupIntents.id, { onDelete: 'restrict' }),
    /** The session's `amount_total` (see the table comment for the name). */
    amount: text().notNull(),
    amountSubtotal: text().notNull().default('0'),
    amountDiscount: text().notNull().default('0'),
    amountTax: text().notNull().default('0'),
    amountShipping: text().notNull().default('0'),
    currency: text().notNull().default('FAIR'),
    /** The rail that settles the order's currency; FairCoin is offered beside it (ADR 0021). */
    rail: text().notNull().default('faircoin'),
    /**
     * Whether a FIAT order also offers the merchant's card methods (ADR 0021
     * D1: the fiat methods are the merchant's to turn off, FairCoin never is).
     * `false` is a FairCoin-only fiat order — `payment_method_types:
     * ['faircoin']`. Meaningless on a FAIR order, which is FairCoin by its rail.
     */
    cardOffered: boolean().notNull().default(true),
    /** The payee's FairCoin network: the merchant's (its environment's), or the seller's. */
    network: text(),
    /** The seller the session's payment pays (ADR 0012). */
    connectedAccountId: text(),
    /** `network` on a session for the merchant itself; NULL on an on-behalf one. See `payment_intents.merchant_network`. */
    merchantNetwork: text().generatedAlwaysAs(
      sql.raw('case when connected_account_id is null then network end'),
    ),
    /** The customer it is for (given on create) or that completion created. */
    customerId: text(),
    customerEmail: text(),
    customerCreation: text().notNull().default('if_required'),
    customerDetails: jsonb().$type<CheckoutCustomerDetails>(),
    shippingDetails: jsonb().$type<CheckoutShippingDetails>(),
    collection: jsonb().$type<StoredCheckoutCollection>(),
    customFields: jsonb().$type<StoredCustomField[]>().notNull().default(sql`'[]'::jsonb`),
    consent: jsonb().$type<CheckoutConsent>(),
    allowPromotionCodes: boolean().notNull().default(false),
    couponId: text(),
    promotionCodeId: text(),
    automaticTax: boolean().notNull().default(false),
    automaticTaxStatus: text(),
    /** The Peable Tax calculation (`taxcalc_…`) the total includes; committed at completion. */
    taxCalculationId: text(),
    clientReferenceId: text(),
    /** The payment link this session was created from. */
    paymentLinkId: text().references((): AnyPgColumn => paymentLinks.id, { onDelete: 'restrict' }),
    /** A payment link's hosted confirmation, copied when the session is made from it. */
    confirmationMessage: text(),
    /**
     * The payer's operation key (`Idempotency-Key`) of the link visit that
     * created this session — unique per link, so a retried visit returns the
     * same session instead of a second order (a contribution's write-before-
     * network key). Never on a DTO.
     */
    linkOperationKey: text(),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    /**
     * `payment_intent_data.metadata` (ADR 0021 D8): copied to every payment
     * the session creates. NULL when the merchant sent none.
     */
    paymentIntentMetadata: jsonb().$type<Record<string, string>>(),
    successUrl: text(),
    cancelUrl: text(),
    /** NULL only on a row that predates the order model, until its backfill. */
    expiresAt: timestamptz(),
    completedAt: timestamptz(),
    expiredAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('checkout_sessions_public_id_key').on(table.publicId),
    /**
     * A session's payment is its own: two sessions never share one. NULLs are
     * distinct, so an open session with none yet constrains nothing.
     */
    uniqueIndex('checkout_sessions_payment_intent_id_key').on(table.paymentIntentId),
    uniqueIndex('checkout_sessions_setup_intent_id_key').on(table.setupIntentId),
    index('checkout_sessions_oxy_app_id_environment_idx').on(table.oxyAppId, table.environment),
    index('checkout_sessions_merchant_id_idx').on(table.merchantId),
    /** The expiry sweeper's claim: open sessions by deadline. */
    index('checkout_sessions_open_expires_at_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'open'`),
    index('checkout_sessions_payment_link_id_idx').on(table.paymentLinkId),
    uniqueIndex('checkout_sessions_link_operation_key').on(
      table.paymentLinkId,
      table.linkOperationKey,
    ),
    // Denormalization that cannot drift: the three copied fields are carried
    // by the reference itself, so they are the merchant's values or the row
    // does not exist. See `payment_intents`' equivalent for the network half.
    foreignKey({
      name: 'checkout_sessions_merchant_identity_fkey',
      columns: [table.merchantId, table.oxyAppId, table.environment, table.merchantNetwork],
      foreignColumns: [merchants.id, merchants.oxyAppId, merchants.environment, merchants.network],
    }).onDelete('restrict'),
    /** The on-behalf firewall — `payment_intents_connected_account_network_fkey`'s twin. */
    foreignKey({
      name: 'checkout_sessions_connected_account_network_fkey',
      columns: [table.connectedAccountId, table.merchantId, table.network],
      foreignColumns: [
        connectedAccounts.id,
        connectedAccounts.merchantId,
        connectedAccounts.network,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'checkout_sessions_connected_account_merchant_fkey',
      columns: [table.connectedAccountId, table.merchantId],
      foreignColumns: [connectedAccounts.id, connectedAccounts.merchantId],
    }).onDelete('restrict'),
    /** The session's customer is this merchant's (`MATCH SIMPLE`: vacuous without one). */
    foreignKey({
      name: 'checkout_sessions_customer_fkey',
      columns: [table.customerId, table.merchantId],
      foreignColumns: [customers.id, customers.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'checkout_sessions_coupon_fkey',
      columns: [table.couponId, table.merchantId],
      foreignColumns: [coupons.id, coupons.merchantId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'checkout_sessions_promotion_code_fkey',
      columns: [table.promotionCodeId, table.merchantId],
      foreignColumns: [promotionCodes.id, promotionCodes.merchantId],
    }).onDelete('restrict'),
    /**
     * A seller is paid by the order's FairCoin payment (ADR 0012 D5, ADR 0021
     * D5): a session naming one carries the seller's network. On a fiat order
     * the card choice is the merchant's own charge.
     */
    check(
      'checkout_sessions_connected_account_has_network_check',
      sql`${table.connectedAccountId} is null or ${table.network} is not null`,
    ),
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
      sql.raw(`environment in (${inList(SERVICE_ENVIRONMENTS)})`),
    ),
    check('checkout_sessions_rail_check', sql.raw(`rail in (${inList(RAIL_VALUES)})`)),
    check('checkout_sessions_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'checkout_sessions_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`),
    ),
    /**
     * A FAIR order needs the payee's network. A fiat order carries it too when
     * the payee has a FairCoin key, so the payer can choose FairCoin (ADR 0021
     * D1); `null` there means FairCoin is unavailable (no key, test mode).
     */
    check(
      'checkout_sessions_faircoin_rail_has_network_check',
      sql`${table.rail} <> 'faircoin' or ${table.network} is not null`,
    ),
    // Same rule as `payment_intents_rail_currency_agrees_check`, for the same
    // reason: these rows carry the price a payer will be shown, and a rail that
    // disagreed with the currency would show one and charge the other.
    check(
      'checkout_sessions_rail_currency_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.currency} = 'FAIR')`,
    ),
    check('checkout_sessions_amount_check', sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}'`)),
    check(
      'checkout_sessions_amounts_check',
      sql.raw(
        ['amount_subtotal', 'amount_discount', 'amount_tax', 'amount_shipping']
          .map((column) => `${column} ~ '${BASE_UNIT_STRING_PATTERN}'`)
          .join(' and '),
      ),
    ),
    check(
      'checkout_sessions_metadata_object_check',
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    check('checkout_sessions_mode_check', sql.raw(`mode in (${inList(CHECKOUT_SESSION_MODES)})`)),
    check(
      'checkout_sessions_status_check',
      sql.raw(`status in (${inList(CHECKOUT_SESSION_STATUSES)})`),
    ),
    check(
      'checkout_sessions_payment_status_check',
      sql.raw(`payment_status in (${inList(CHECKOUT_PAYMENT_STATUSES)})`),
    ),
    check('checkout_sessions_ui_mode_check', sql.raw(`ui_mode in (${inList(CHECKOUT_UI_MODES)})`)),
    check(
      'checkout_sessions_locale_check',
      sql.raw(`locale is null or locale in (${inList(CHECKOUT_LOCALES)})`),
    ),
    check(
      'checkout_sessions_payer_locale_check',
      sql.raw(`payer_locale is null or payer_locale in (${inList(CHECKOUT_LOCALES)})`),
    ),
    check(
      'checkout_sessions_submit_type_check',
      sql.raw(`submit_type in (${inList(CHECKOUT_SUBMIT_TYPES)})`),
    ),
    check(
      'checkout_sessions_customer_creation_check',
      sql.raw(`customer_creation in (${inList(CHECKOUT_CUSTOMER_CREATIONS)})`),
    ),
    check(
      'checkout_sessions_automatic_tax_status_check',
      sql.raw(
        `automatic_tax_status is null or automatic_tax_status in (${inList(AUTOMATIC_TAX_STATUSES)})`,
      ),
    ),
    check(
      'checkout_sessions_custom_fields_check',
      sql`jsonb_typeof(${table.customFields}) = 'array' and jsonb_array_length(${table.customFields}) <= 3`,
    ),
    /** A setup session has no payment, and a payment session no setup. */
    check(
      'checkout_sessions_mode_objects_check',
      sql`(${table.mode} <> 'setup' or ${table.paymentIntentId} is null) and (${table.mode} = 'setup' or ${table.setupIntentId} is null)`,
    ),
    /**
     * `complete` ⇔ `completed_at`, `expired` ⇔ `expired_at`: one fact each,
     * stamped by the one writer of each transition.
     */
    check(
      'checkout_sessions_status_instants_check',
      sql`(${table.status} = 'complete') = (${table.completedAt} is not null) and (${table.status} = 'expired') = (${table.expiredAt} is not null)`,
    ),
    /**
     * A setup session never has a payment to make. A priced one may also need
     * none — a discount took its total to zero — which is the only other way to
     * `no_payment_required`, and that only on completion.
     */
    check(
      'checkout_sessions_payment_status_agrees_check',
      sql`(${table.mode} <> 'setup' or ${table.paymentStatus} = 'no_payment_required') and (${table.paymentStatus} <> 'no_payment_required' or ${table.mode} = 'setup' or (${table.status} = 'complete' and ${table.amount} = '0'))`,
    ),
    /** A discount is a coupon; a promotion code only ever redeems one. */
    check(
      'checkout_sessions_discount_check',
      sql`${table.promotionCodeId} is null or ${table.couponId} is not null`,
    ),
    check('checkout_sessions_client_secret_check', sql`${table.clientSecret} is not null`),
    check('checkout_sessions_expires_at_check', sql`${table.expiresAt} is not null`),
  ],
);

/**
 * A contribution link's details AS STORED in `payment_links.contribution`.
 *
 * The storage shape, not the wire's: the keys are the ones
 * `payment_links_contribution_shape` reads (`organizationId`, `amountMode`) and
 * `expiresAt` is ISO-8601. The wire's `ContributionDetails`
 * (`@peable.to/contracts`, snake_case, Unix seconds) is rendered from it by
 * `toContributionDetails` in `lib/serialize.ts`, so a wire change never reaches
 * a CHECK constraint.
 */
export interface StoredContribution {
  readonly organizationId: string;
  readonly purpose: string;
  readonly amountMode: 'fixed' | 'free';
  readonly expiresAt: string | null;
}

/**
 * A payment link (Orbit Phase 3) — a shareable URL over catalog prices
 * (`payment_link_line_items`). A payer visiting it creates a Checkout Session
 * with its line items and options; nothing about a link mints a payment.
 *
 * A CONTRIBUTION link (an Oxy organization's FairCoin collection) is the one
 * kind with no line items: its single line is the contribution, a fixed
 * `amount` or (`'0'`, the free sentinel) one the payer chooses. `amount` is
 * therefore set exactly on contribution links
 * (`payment_links_amount_shape_check`).
 *
 * The line items are immutable once shared; the options, `active` and
 * `metadata` may change.
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
    /** Contribution links only — see the table comment. */
    amount: text(),
    currency: text().notNull().default('FAIR'),
    /** Which rail the sessions this link creates will pay on — decided by its currency. */
    rail: text().notNull().default('faircoin'),
    /** FairCoin rail only — NULL on a card link. See ADR 0001 D6. */
    network: text(),
    contribution: jsonb().$type<StoredContribution>(),
    contributionKey: text(),
    active: boolean().notNull().default(true),
    metadata: jsonb().$type<Record<string, string>>().notNull().default(emptyMetadata),
    allowPromotionCodes: boolean().notNull().default(false),
    collection: jsonb().$type<StoredCheckoutCollection>(),
    customFields: jsonb().$type<StoredCustomField[]>().notNull().default(sql`'[]'::jsonb`),
    automaticTax: boolean().notNull().default(false),
    customerCreation: text().notNull().default('if_required'),
    submitType: text().notNull().default('auto'),
    locale: text(),
    afterCompletionType: text().notNull().default('hosted_confirmation'),
    /** `after_completion.redirect.url`; may carry `{CHECKOUT_SESSION_ID}`. */
    afterCompletionUrl: text(),
    afterCompletionMessage: text(),
    /** `restrictions.completed_sessions.limit`; the link deactivates on reaching it. */
    completedSessionsLimit: integer(),
    completedSessionsCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payment_links_contribution_key').on(table.merchantId, table.contributionKey),
    check(
      'payment_links_contribution_shape',
      sql` ${table.contribution} is null or (
      jsonb_typeof(${table.contribution}) = 'object' and ${table.rail} = 'faircoin'
      and coalesce(length(${table.contribution}->>'organizationId') between 1 and 200, false)
      and coalesce(length(${table.contribution}->>'purpose') between 1 and 500, false)
      and coalesce(((${table.contribution}->>'amountMode' = 'fixed' and ${table.amount} <> '0')
       or (${table.contribution}->>'amountMode' = 'free' and ${table.amount} = '0')), false)
    )`,
    ),
    check(
      'payment_links_contribution_agrees',
      sql`(${table.contribution} is null) = (${table.contributionKey} is null)`,
    ),
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
      sql.raw(`environment in (${inList(SERVICE_ENVIRONMENTS)})`),
    ),
    check('payment_links_rail_check', sql.raw(`rail in (${inList(RAIL_VALUES)})`)),
    check('payment_links_currency_check', sql.raw(`currency in (${inList(CURRENCY_CODES)})`)),
    check(
      'payment_links_network_check',
      sql.raw(`network is null or network in (${inList(NETWORK_TYPES)})`),
    ),
    check(
      'payment_links_rail_network_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.network} is not null)`,
    ),
    // Same rule as `payment_intents_rail_currency_agrees_check`, for the same
    // reason: these rows carry the price a payer will be shown, and a rail that
    // disagreed with the currency would show one and charge the other.
    check(
      'payment_links_rail_currency_agrees_check',
      sql`(${table.rail} = 'faircoin') = (${table.currency} = 'FAIR')`,
    ),
    check(
      'payment_links_amount_check',
      sql.raw(`amount is null or amount ~ '${BASE_UNIT_STRING_PATTERN}'`),
    ),
    /** The amount is a contribution's; a price link's amounts are its prices'. */
    check(
      'payment_links_amount_shape_check',
      sql`(${table.contribution} is null) = (${table.amount} is null)`,
    ),
    check('payment_links_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    check(
      'payment_links_after_completion_check',
      sql.raw(
        `after_completion_type in (${inList(AFTER_COMPLETION_TYPES)}) and ((after_completion_type = 'redirect') = (after_completion_url is not null)) and (after_completion_type = 'hosted_confirmation' or after_completion_message is null)`,
      ),
    ),
    check(
      'payment_links_completed_sessions_check',
      sql`(${table.completedSessionsLimit} is null or ${table.completedSessionsLimit} >= 1) and ${table.completedSessionsCount} >= 0`,
    ),
    check(
      'payment_links_custom_fields_check',
      sql`jsonb_typeof(${table.customFields}) = 'array' and jsonb_array_length(${table.customFields}) <= 3`,
    ),
    check(
      'payment_links_options_check',
      sql.raw(
        `customer_creation in (${inList(CHECKOUT_CUSTOMER_CREATIONS)}) and submit_type in (${inList(CHECKOUT_SUBMIT_TYPES)}) and (locale is null or locale in (${inList(CHECKOUT_LOCALES)}))`,
      ),
    ),
  ],
);

/**
 * The outputs of a FairCoin payment's ONE transaction (ADR 0021 D6), in order.
 *
 * A payment to one payee is the one-output case — every FairCoin intent created
 * since this table writes its rows in the intent's own transaction. Each output
 * pays one account's Peable wallet: `connected_account_id` names the seller
 * (NULL: the merchant's own owner), `recipient_account_id` the Oxy account whose
 * identity key the address derives from, reserved on THAT account's cursor
 * (ADR 0002, ADR 0021 D5). `payment_intents.address` keeps output 0; an intent
 * written before this table has no rows and reads as its one output from it.
 *
 * Not a hot table, and its references are the intent's own firewall: the seller
 * belongs to the merchant and is on the payment's network (the composite key),
 * exactly as `payment_intents_connected_account_network_fkey` binds an
 * on-behalf payment.
 */
export const paymentIntentOutputs = pgTable(
  'payment_intent_outputs',
  {
    id: generatedId(),
    paymentIntentId: text()
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    position: integer().notNull(),
    connectedAccountId: text(),
    network: text().notNull(),
    /** An Oxy account id (another service's key space: no foreign key). */
    recipientAccountId: text().notNull(),
    address: text().notNull(),
    amount: text().notNull(),
    /**
     * The recipient's identity public key this address was derived from — its
     * DID `#key-1`, read fresh at the reservation (ADR 0002, amended
     * 2026-11-06), lowercase hex. NULL only on the outputs written before keys
     * were recorded.
     */
    identityPublicKey: text(),
    /**
     * The index on the recipient's cursor `address` was derived at (ADR 0021
     * D9): what the recipient's wallet derives and signs with, and the order
     * `GET /v1/social/me/receive_addresses` syncs it in. NULL only on rows
     * written before it (migration 0105).
     */
    derivationIndex: integer(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payment_intent_outputs_intent_position_key').on(
      table.paymentIntentId,
      table.position,
    ),
    /**
     * One address, one output, for ever (ADR 0021 D9, amended 2026-11-06:
     * addresses are never recycled). The watcher and enrichment resolve the
     * payment by it.
     */
    uniqueIndex('payment_intent_outputs_network_address_key').on(table.network, table.address),
    /** The recipient's watch set, synced in index order (`GET /v1/social/me/receive_addresses`). */
    index('payment_intent_outputs_recipient_index_idx').on(
      table.recipientAccountId,
      table.network,
      table.derivationIndex,
    ),
    /** The recipient's unpaid addresses of the last day: the per-recipient bound (ADR 0021 D9). */
    index('payment_intent_outputs_recipient_created_idx').on(
      table.recipientAccountId,
      table.network,
      table.createdAt,
    ),
    foreignKey({
      name: 'payment_intent_outputs_connected_account_network_fkey',
      columns: [table.connectedAccountId, table.merchantId, table.network],
      foreignColumns: [
        connectedAccounts.id,
        connectedAccounts.merchantId,
        connectedAccounts.network,
      ],
    }).onDelete('restrict'),
    check(
      'payment_intent_outputs_amount_check',
      sql.raw(`amount ~ '${BASE_UNIT_STRING_PATTERN}' and amount <> '0'`),
    ),
    check('payment_intent_outputs_position_check', sql`${table.position} >= 0`),
    check(
      'payment_intent_outputs_identity_key_check',
      sql.raw(
        `identity_public_key is null or identity_public_key ~ '${IDENTITY_PUBLIC_KEY_PATTERN}'`,
      ),
    ),
    check(
      'payment_intent_outputs_derivation_index_check',
      sql.raw(
        `derivation_index is null or derivation_index >= ${SOCIAL_RECEIVE_FIRST_FRESH_INDEX}`,
      ),
    ),
    check('payment_intent_outputs_network_check', sql.raw(`network in (${inList(NETWORK_TYPES)})`)),
  ],
);
