import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import { NETWORK_TYPES } from './valueSets';

/**
 * First index the social-receive reservation flow ever hands out. Index 0 is
 * the recipient's stable default address, computed on-device from their
 * identity key and never reserved through the backend.
 *
 * Declared here as well as in `services/socialReceive.ts` because it is the
 * floor of a CHECK constraint, and a constraint cannot import a runtime value.
 * `db/__tests__/socialReceiveCursor.realdb.test.ts` pins the two together.
 */
export const SOCIAL_RECEIVE_FIRST_FRESH_INDEX = 1;

/**
 * Per-(user, network) counter for the social-receive address branch.
 *
 * The merchant counter's shape (`merchants.next_derivation_index`) with one
 * difference: an ordinary Oxy user has no registration step, so the row is
 * created lazily on their first social payment. That is what makes the unique
 * index below load-bearing rather than hygienic — two concurrent first
 * payments both attempt the insert, the index picks a winner, and the loser
 * converges on `23505` instead of reading first.
 */
export const socialReceiveCursors = pgTable(
  'social_receive_cursors',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    network: text().notNull(),
    /** See `merchants.next_derivation_index` for why this is `integer` and not `bigint`. */
    nextDerivationIndex: integer().notNull().default(SOCIAL_RECEIVE_FIRST_FRESH_INDEX),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('social_receive_cursors_oxy_user_id_network_key').on(
      table.oxyUserId,
      table.network
    ),
    check('social_receive_cursors_network_check', sql.raw(`network in (${inList(NETWORK_TYPES)})`)),
    // Index 0 is never handed out here, so the counter never points below the
    // first fresh index — including at creation, which is why the default and
    // the floor are the same constant.
    //
    // `sql.raw`, not an interpolation. A value interpolated into a `sql`
    // template becomes a BOUND PARAMETER, and a CHECK constraint cannot carry
    // one: drizzle-kit renders it into the DDL as the literal text `$1`.
    // Measured here — the first generated migration contained
    // `CHECK (… >= $1)`. A constant written directly in the template (`>= 0`)
    // is template TEXT and is unaffected, which is exactly what makes this easy
    // to get wrong the moment a bound becomes a named constant.
    check(
      'social_receive_cursors_next_derivation_index_check',
      sql.raw(`next_derivation_index >= ${SOCIAL_RECEIVE_FIRST_FRESH_INDEX}`)
    ),
  ]
);

/**
 * Records that a social-receive address was minted for one sender → recipient
 * payment. Keyed by the on-chain address: every non-default social-receive
 * address is single-use, so `(address, network)` identifies exactly one payment
 * relationship.
 *
 * Read by the enrichment service to render "Sent to @alice" and "Received from
 * @bob" without ever touching a private key.
 */
export const socialSendAttributions = pgTable(
  'social_send_attributions',
  {
    id: generatedId(),
    address: text().notNull(),
    network: text().notNull(),
    senderUserId: text().notNull(),
    recipientUserId: text().notNull(),
    /**
     * The BIP32 child index this address was derived at. Called `index` in the
     * Mongo model; renamed because `derivation_index` is what it is, and it
     * now matches the two counters that produce it.
     */
    derivationIndex: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('social_send_attributions_address_network_key').on(table.address, table.network),
    check(
      'social_send_attributions_network_check',
      sql.raw(`network in (${inList(NETWORK_TYPES)})`)
    ),
    // An attribution only ever describes a RESERVED address, and index 0 is
    // never reserved — it is the recipient's default address, which belongs to
    // no single payment relationship and must not acquire one here.
    check(
      'social_send_attributions_derivation_index_check',
      sql.raw(`derivation_index >= ${SOCIAL_RECEIVE_FIRST_FRESH_INDEX}`)
    ),
  ]
);
