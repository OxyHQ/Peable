import { sql } from 'drizzle-orm';
import {
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
import { NETWORK_TYPES } from './valueSets';

/**
 * A PLATFORM's own FairCoin fee key — where its application fee is paid
 * (ADR 0013).
 *
 * Separate from `merchants.xpub` on purpose. That column is the merchant's own
 * receive account and has always been writable through the service API at
 * registration; a fee key must not be. This table's one writer,
 * `registerPlatformFeeKey`, is reached only from
 * `/v1/connect/platform_fee/:merchantId/*` — an Oxy USER session holding
 * `billing:manage` on the merchant's application, i.e. the platform's owner in
 * the Peable wallet. A platform credential, compromised or not, cannot point
 * the fee at a key of its choosing.
 *
 * One per (merchant, network), immutable once written: an on-behalf payment
 * pays the fee on the SELLER's network, and re-keying would re-interpret every
 * fee address already shown to a payer. Like every other key in this schema,
 * never on a DTO and never a private key (`assertWatchOnly` runs at the writer).
 */
export const platformFeeAccounts = pgTable(
  'platform_fee_accounts',
  {
    id: generatedId(),
    merchantId: text().notNull(),
    network: text().notNull(),
    /** Watch-only ACCOUNT xpub of the owner's dedicated fee pocket. */
    xpub: text().notNull(),
    /** The Oxy user who registered it — the owner, with `billing:manage`. No FK: Oxy's key space. */
    registeredByOxyUserId: text().notNull(),
    registeredAt: timestamptz().notNull(),
    /** The fee key's derivation counter — `integer`, one-statement reservation, as every counter here. */
    nextDerivationIndex: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One fee key per platform per chain. The convergence of a double registration. */
    unique('platform_fee_accounts_merchant_id_network_key').on(table.merchantId, table.network),
    /** The target of `payment_intents`' fee reference: this platform's key, on this network. */
    unique('platform_fee_accounts_id_merchant_id_network_key').on(
      table.id,
      table.merchantId,
      table.network,
    ),
    /** One key, one counter — two counters on one key collide on addresses. */
    uniqueIndex('platform_fee_accounts_xpub_key').on(table.xpub),
    foreignKey({
      name: 'platform_fee_accounts_merchant_id_fkey',
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
    }).onDelete('restrict'),
    check(
      'platform_fee_accounts_network_check',
      sql.raw(`network in (${inList(NETWORK_TYPES)})`),
    ),
    check(
      'platform_fee_accounts_next_derivation_index_check',
      sql`${table.nextDerivationIndex} >= 0`,
    ),
    check(
      'platform_fee_accounts_registered_by_check',
      sql`length(${table.registeredByOxyUserId}) > 0`,
    ),
  ],
);
