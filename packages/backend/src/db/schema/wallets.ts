import { sql } from 'drizzle-orm';
import { check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';
import { NETWORK_TYPES } from './valueSets';

/**
 * The account-level WATCH-ONLY xpub a user's signing device published for its
 * own other surfaces to read.
 *
 * ## Why this table exists
 *
 * The identity wallet's address tree derives from a seed produced by HKDF over
 * the on-device identity PRIVATE key, so nothing published about a user lets
 * another surface compute those addresses. That is deliberate — the alternative
 * would let anyone holding a handle enumerate that user's whole balance and
 * history — but it also means a browser, which has no keystore and therefore no
 * seed, cannot show the user their own wallet. The device that HAS the key
 * publishes the public half here, once, and the browser reads it back.
 *
 * The social-receive branch needs none of this: `deriveSocialReceiveAddress`
 * computes those addresses from the identity PUBLIC key, which is already in
 * the user's DID. This table covers the OTHER branch, and only that one.
 *
 * ## Why there is no column for a private key
 *
 * The same reason `merchants` has none. An extended key that carries a private
 * key is refused at the boundary by `assertWatchOnly` before a row is ever
 * written, so the gateway cannot come to hold spend capability over a user's
 * funds by accident or by a later careless caller. An xpub is a permanent, total
 * VIEW of an account and nothing more: it cannot sign.
 */
export const walletXpubs = pgTable(
  'wallet_xpubs',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    network: text().notNull(),
    /**
     * The account-level extended PUBLIC key (`m/44'/coinType'/0'`). Deliberately
     * not in `db/protectedColumns.ts`: it is the entire point of the row and
     * appears in the DTO by design, so withholding it would withhold nothing.
     */
    xpub: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One published key per user per network. A device that re-publishes
    // converges on this index through `ON CONFLICT DO UPDATE` rather than
    // reading first, so two surfaces publishing at once cannot leave two rows
    // disagreeing about which key is current.
    uniqueIndex('wallet_xpubs_oxy_user_id_network_key').on(table.oxyUserId, table.network),
    check('wallet_xpubs_network_check', sql.raw(`network in (${inList(NETWORK_TYPES)})`)),
  ]
);
