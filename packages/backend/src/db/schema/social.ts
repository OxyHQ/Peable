import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxy.so/db';
import {
  SOCIAL_SOURCE_APP_MAX_LENGTH,
  SOCIAL_SOURCE_REF_MAX_LENGTH,
} from '@peable.to/shared-types';
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
    /**
     * The identity public key the addresses on this cursor were derived from,
     * hex. Every address here is a function of that key, and the key is not
     * ours: it is whatever the recipient's DID publishes at the moment of the
     * reservation. Recording it is what lets a recipient's device ask "is this
     * still the key I derive from?" — the alternative is a device widening its
     * watch window in a tree nobody is paying into, which is silent.
     *
     * NOT NULL: every cursor says which key it belongs to, so a device reading
     * one never has to handle "the backend does not know". The cursors that
     * predate the column are deleted by the migration that adds the constraint
     * — they are index counters from testing, no funds and no user, and the key
     * behind them is not recoverable from anything stored.
     */
    identityPublicKey: text().notNull(),
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
    /**
     * The app the payer reserved this address from, e.g. `mention`.
     *
     * NULLABLE and never defaulted: most social payments are one person paying
     * another for nothing in particular, and a default would invent a context
     * the payer did not state. `NULL` therefore means exactly "no app said what
     * this was for", which is a fact; `'unknown'` would be a claim.
     */
    sourceApp: text(),
    /**
     * The `source_app` app's own id for what the payment was for — a post id,
     * say. **Opaque here and it must stay opaque:** nothing in this repository
     * parses it, resolves it, joins on it or indexes it, so the gateway learns
     * that an id exists and not what it names. The moment something reads INTO
     * it, Peable starts knowing what its users are paying for, which is the one
     * thing this column was designed not to do.
     *
     * Nullable for the same reason as `source_app`, and independently: an app
     * can name itself without having a single thing to point at.
     */
    sourceRef: text(),
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
    // A `ref` is meaningful only inside the app that minted it, so a ref with
    // no app names nothing anybody could ever resolve. Checked against the only
    // writer — `insertSendAttribution`, reached from
    // `POST /v1/social/:username/next_address`, where the two arrive together
    // inside one optional `source` object whose `app` is required — so this
    // refuses no legal write. Existing rows carry NULL in both, and a CHECK is
    // satisfied by NULL.
    check(
      'social_send_attributions_source_ref_needs_app_check',
      sql.raw(`source_ref is null or source_app is not null`)
    ),
    // The length bounds the route validates, restated where they are true of
    // the DATA rather than of one code path. `source_ref` is opaque — nothing
    // reads it, so nothing downstream would ever notice it growing — and an
    // unbounded opaque column is how a display hint becomes a place to stash a
    // payload.
    //
    // `sql.raw` with the bound interpolated into the STRING, never `${bound}`
    // in a `sql` template: that renders as a BOUND PARAMETER, which drizzle-kit
    // writes into the migration as the literal `$1`, and a CHECK cannot carry
    // one. See the note on the cursor's index CHECK above.
    check(
      'social_send_attributions_source_app_length_check',
      sql.raw(
        `source_app is null or char_length(source_app) between 1 and ${SOCIAL_SOURCE_APP_MAX_LENGTH}`
      )
    ),
    check(
      'social_send_attributions_source_ref_length_check',
      sql.raw(
        `source_ref is null or char_length(source_ref) between 1 and ${SOCIAL_SOURCE_REF_MAX_LENGTH}`
      )
    ),
  ]
);
