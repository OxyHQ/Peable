import { eq, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { merchants } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * A derivation index this call, and no other call, owns — together with the
 * key material needed to derive its address, read in the same statement.
 */
export interface ReservedDerivationIndex {
  readonly index: number;
  readonly xpub: string;
  readonly network: NetworkType;
}

/**
 * Claim the merchant's next BIP32 child index, atomically.
 *
 * ## What a wrong index costs
 *
 * Read this before simplifying anything below. The number this returns is not
 * displayed anywhere — it is derived into the address a payer sends real money
 * to. Getting it wrong has two failure modes and neither is recoverable by
 * editing code afterwards: an index the merchant's own wallet does not scan
 * produces funds sitting at an address they cannot spend from, and a repeated
 * index produces two payers sharing one address, which the gateway cannot then
 * attribute to either intent.
 *
 * ## Why this is one statement and not a read followed by a write
 *
 * A read-modify-write leaves exactly the repeated-index window open: two
 * callers read the same value and derive the same address. `UPDATE … SET x = x
 * + 1` takes the row lock and does not.
 *
 * `RETURNING next_derivation_index - 1` is the PRE-increment value — the index
 * this call reserved — and is the direct port of Mongo's `findOneAndUpdate({
 * $inc }, { new: false })`. Getting that `- 1` wrong hands out an index one
 * higher than the one recorded, so the address a payer is shown is not the
 * address the next reservation avoids.
 *
 * ## The type of what comes back
 *
 * `integer`, so postgres.js decodes it as a JS `number`. This matters more than
 * it looks: postgres.js decodes `int8` to a STRING, so a `bigint` column would
 * make `index + 1` string CONCATENATION ("0" + 1 = "01") and derive a
 * completely different address. `int4` is also the real domain — a non-hardened
 * BIP32 child index is bounded by 2^31 − 1 — so exhausting it raises `22003`
 * and refuses the reservation instead of wrapping to an index already handed
 * out. `db/__tests__/derivationIndex.realdb.test.ts` pins both the type and two
 * CONSECUTIVE reservations, because a single reservation cannot tell a number
 * from a string that happens to print the same.
 *
 * @returns `null` when no merchant has that id — nothing was reserved.
 */
export async function reserveNextDerivationIndex(
  db: DatabaseOrTransaction,
  merchantId: string
): Promise<ReservedDerivationIndex | null> {
  const [row] = await db
    .update(merchants)
    .set({ nextDerivationIndex: sql`${merchants.nextDerivationIndex} + 1` })
    .where(eq(merchants.id, merchantId))
    .returning({
      index: sql<number>`${merchants.nextDerivationIndex} - 1`,
      xpub: merchants.xpub,
      network: merchants.network,
    });

  if (!row) return null;
  if (row.xpub === null || row.network === null) {
    /**
     * A CARD-ONLY merchant. Both chain columns are null together
     * (`merchants_chain_fields_agree_check`), so there is no key to derive from
     * and no chain to derive on.
     *
     * The index was still consumed by the statement above, and that is
     * deliberate: un-incrementing it would need a second write that could lose
     * a concurrent reservation. Burning an index costs nothing — the space is
     * 2^31 — while a repeated one puts two payers on one address.
     *
     * Reaching here at all is a caller bug: `resolveRail` refuses a FairCoin
     * intent for a merchant with no chain account, so nothing should ask. It is
     * a named refusal rather than a cast through `null` so that bug surfaces
     * here instead of inside `@scure/bip32`.
     */
    return null;
  }
  // `network` is `text` in the schema and a closed set in the database (the
  // `merchants_network_check` CHECK). The cast is where those two facts meet;
  // it is not a widening.
  return { index: row.index, xpub: row.xpub, network: row.network as NetworkType };
}
