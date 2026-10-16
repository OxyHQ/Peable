import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { connectedAccounts } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ReservedDerivationIndex } from '../merchants/derivationIndex';

/**
 * Claim a SELLER's next BIP32 child index, atomically — the on-behalf twin of
 * `db/merchants/derivationIndex.ts` (ADR 0012 D5).
 *
 * Read that file's comment before changing anything here: everything it says
 * about what a wrong index costs applies unchanged, because the number this
 * returns is derived into the address a payer sends real money to — on the
 * SELLER's key, where a repeated index puts two payers on one address the
 * gateway can attribute to neither.
 *
 * It is ONE statement for the same reason: `UPDATE … SET x = x + 1 …
 * RETURNING x - 1` takes the row lock and returns the PRE-increment value, the
 * index this call and no other owns. The key and the network come back in the
 * same statement, so the address derives from the key the reservation was
 * taken against. `integer`, so the index arrives as a JS `number` and never as
 * a string that would concatenate (`"0" + 1 === "01"`).
 *
 * Scoped to the MERCHANT as well as the account, so a platform can never
 * reserve on another platform's seller even if a caller passed the wrong id.
 * `xpub IS NOT NULL` keeps a pending seller's counter untouched — there is
 * nothing to derive from yet, and readiness is refused before this is reached.
 *
 * @returns `null` when no such account with a registered key belongs to the
 *   merchant — nothing was reserved.
 */
export async function reserveNextAccountDerivationIndex(
  db: DatabaseOrTransaction,
  merchantId: string,
  accountId: string,
): Promise<ReservedDerivationIndex | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({ nextDerivationIndex: sql`${connectedAccounts.nextDerivationIndex} + 1` })
    .where(
      and(
        eq(connectedAccounts.id, accountId),
        eq(connectedAccounts.merchantId, merchantId),
        isNotNull(connectedAccounts.xpub),
      ),
    )
    .returning({
      index: sql<number>`${connectedAccounts.nextDerivationIndex} - 1`,
      xpub: connectedAccounts.xpub,
      network: connectedAccounts.network,
    });

  if (!row || row.xpub === null || row.network === null) return null;
  // `network` is `text` here and a closed set in the database
  // (`connected_accounts_network_check`). The cast is where those meet.
  return { index: row.index, xpub: row.xpub, network: row.network as NetworkType };
}
