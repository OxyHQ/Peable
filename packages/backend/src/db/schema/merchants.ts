import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import { NETWORK_TYPES, SERVICE_ENVIRONMENTS } from './valueSets';

/**
 * A merchant of the Peable Gateway.
 *
 * The non-custody firewall is a property of what this table CAN hold: there is
 * an `xpub` column and there is deliberately no column for a private key, a
 * mnemonic or a seed. `services/derivation.ts` refuses an extended key that
 * carries a private key, so a merchant handing over an `xprv` is rejected
 * rather than silently granting the gateway the ability to spend their funds.
 */
export const merchants = pgTable(
  'merchants',
  {
    id: generatedId(),
    /** Public Stripe-parity identifier (`merch_…`), minted by `newId('merch')`. */
    publicId: text().notNull(),
    oxyAppId: text().notNull(),
    /** Test/live isolation: the environment of the credential that registered this merchant. */
    environment: text().notNull(),
    network: text().notNull(),
    /** Watch-only account extended public key. Never a private key — see the table comment. */
    xpub: text().notNull(),
    /**
     * The NEXT unused BIP32 child index. Claimed by
     * `db/merchants/derivationIndex.ts`, never by a read-modify-write.
     *
     * `integer`, not `bigint`, and that is the domain rather than a size
     * guess: a non-hardened BIP32 child index is bounded by 2^31 − 1, which is
     * exactly `int4`'s ceiling. Reaching it raises `22003 integer out of
     * range` and refuses the reservation — the correct answer, since the next
     * index would not be derivable. It also keeps this value a JS `number` on
     * the way back: postgres.js decodes `int8` to a STRING, so a `bigint`
     * column here would make `index + 1` string concatenation and derive a
     * DIFFERENT address than the one reserved.
     */
    nextDerivationIndex: integer().notNull().default(0),
    webhookUrl: text(),
    webhookSecret: text(),
    requiredConfirmations: integer().notNull().default(1),
    /**
     * Stripe-parity flag, currently written by nothing and read by nothing —
     * every row carries the default. Kept because removing a field from a
     * published wire model is a product decision, not a port decision.
     *
     * It is NOT constrained against `environment`. The obvious CHECK
     * (`livemode` ⇔ `environment = 'production'`) would refuse the
     * registration of every production merchant, because no writer sets it.
     */
    livemode: boolean().notNull().default(false),
    /** Display name shown in the payer's transaction history ("Paid at <name>"). */
    displayName: text(),
    /** Bare Oxy file id for the merchant's logo — the canonical media chokepoint. */
    avatarFileId: text(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('merchants_public_id_key').on(table.publicId),
    // Test/live isolation: one Application may register at most one merchant
    // per environment. `resolveMerchant()` always resolves by both together.
    uniqueIndex('merchants_oxy_app_id_environment_key').on(table.oxyAppId, table.environment),
    /**
     * Referenced targets, not access paths.
     *
     * The two composite references in `schema/payments.ts` — the ones that make
     * the network firewall and the denormalized app/environment fields
     * structural — point at these column sets. They are trivially unique (each
     * begins with the primary key) and exist only to be pointed at. A PREFIX of
     * a wider unique would not serve: Postgres matches the whole column set.
     *
     * `unique()`, not `uniqueIndex()`, and the difference is load-bearing here
     * rather than stylistic. drizzle-kit emits every `ALTER TABLE … ADD
     * CONSTRAINT … FOREIGN KEY` BEFORE every `CREATE UNIQUE INDEX`, so a
     * foreign key pointed at a unique INDEX fails to apply with `42830 there is
     * no unique constraint matching given keys` — the target does not exist yet
     * at that point in the file. A `unique()` table constraint is emitted
     * inline in `CREATE TABLE`, so it is already there. Measured against a real
     * server; `tsc` and drizzle-kit's generate step are both clean either way.
     */
    unique('merchants_id_network_key').on(table.id, table.network),
    unique('merchants_id_oxy_app_id_environment_network_key').on(
      table.id,
      table.oxyAppId,
      table.environment,
      table.network
    ),
    /**
     * The network-free half of the identity above — the target of the companion
     * references ADR 0001 D6 requires.
     *
     * `checkout_sessions.network` and `payment_links.network` are NULL on a card
     * row, and a NULL switches a `MATCH SIMPLE` composite reference off
     * ENTIRELY: the four-column reference stops guaranteeing `oxy_app_id` and
     * `environment` too, not just `network`. A card session could then claim a
     * different application or environment than its merchant's. This target is
     * what the narrower reference points at so it cannot.
     */
    unique('merchants_id_oxy_app_id_environment_key').on(
      table.id,
      table.oxyAppId,
      table.environment
    ),
    check(
      'merchants_environment_check',
      sql.raw(`environment in (${inList(SERVICE_ENVIRONMENTS)})`)
    ),
    check('merchants_network_check', sql.raw(`network in (${inList(NETWORK_TYPES)})`)),
    check('merchants_next_derivation_index_check', sql`${table.nextDerivationIndex} >= 0`),
    // The create and update schemas both validate `.positive()`; this is that
    // range, in the one place a write that skipped them still has to pass.
    check('merchants_required_confirmations_check', sql`${table.requiredConfirmations} > 0`),
    // There is deliberately NO `(webhook_url is null) = (webhook_secret is
    // null)` coherence CHECK. Both `POST /v1/merchants` and its PATCH accept
    // either field alone, so that constraint would refuse a currently-legal
    // write; the incoherent state is reachable and already handled, by
    // `routes/webhookDeliveries.ts` refusing to send when either is missing.
  ]
);
