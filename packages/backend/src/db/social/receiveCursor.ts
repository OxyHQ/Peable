import { and, eq, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { SOCIAL_RECEIVE_FIRST_FRESH_INDEX, socialReceiveCursors } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { uuidv7 } from '@oxy.so/db';

/**
 * Claim the next unused social-receive index for a user on a network,
 * creating their cursor if this is their first social payment.
 *
 * Carries the same cost as `db/merchants/derivationIndex.ts` — read that
 * function's first paragraph before changing anything here. A wrong index is
 * money at an address the recipient cannot spend from, or two senders sharing
 * one address; single-use is the whole point of a per-payment address.
 *
 * ## One statement, including the lazy create
 *
 * An ordinary Oxy user has no registration step, so the row may not exist yet
 * — and two concurrent first payments both try to create it. Mongo needed
 * three moves for that: create, tolerate the duplicate-key error, then
 * increment. Here `INSERT … ON CONFLICT DO UPDATE` is all three at once, so
 * there is no window between them and no "the cursor vanished" branch to get
 * wrong. The unique index on `(oxy_user_id, network)` is what makes it work,
 * which is why that index is load-bearing rather than hygienic: without it the
 * conflict has no arbiter and both racers insert.
 *
 * The inserted value is deliberately `FIRST_FRESH_INDEX + 1`, not
 * `FIRST_FRESH_INDEX`. The column always holds the NEXT index to hand out, and
 * this statement hands one out — so a brand-new cursor is created having
 * already reserved its first. `RETURNING next_derivation_index - 1` then
 * returns `FIRST_FRESH_INDEX` on the insert branch and the pre-increment value
 * on the conflict branch, from one expression.
 *
 * Index 0 is never reachable through here. It is the recipient's stable
 * default address, computed on-device from their identity key.
 */
export async function reserveNextSocialReceiveIndex(
  db: DatabaseOrTransaction,
  oxyUserId: string,
  network: NetworkType
): Promise<number> {
  const [row] = await db
    .insert(socialReceiveCursors)
    .values({
      id: uuidv7(),
      oxyUserId,
      network,
      nextDerivationIndex: SOCIAL_RECEIVE_FIRST_FRESH_INDEX + 1,
    })
    .onConflictDoUpdate({
      target: [socialReceiveCursors.oxyUserId, socialReceiveCursors.network],
      set: { nextDerivationIndex: sql`${socialReceiveCursors.nextDerivationIndex} + 1` },
    })
    .returning({ index: sql<number>`${socialReceiveCursors.nextDerivationIndex} - 1` });

  if (!row) {
    // Unreachable: `DO UPDATE` always produces a row, unlike `DO NOTHING`.
    // Stated rather than asserted with `!`, so a future change to the conflict
    // action fails loudly here instead of returning `NaN` as an index.
    throw new Error(`social receive cursor reservation returned no row for user ${oxyUserId}`);
  }
  return row.index;
}

/**
 * The highest index EVER reserved for this user on this network, without
 * reserving another — backs the cursor-sync read.
 *
 * The column holds the NEXT index, so the highest already reserved is one less.
 * `FIRST_FRESH_INDEX - 1` when no cursor exists, which is the same answer as
 * "no address has been reserved", stated in the same units.
 */
export async function readReservedThrough(
  db: DatabaseOrTransaction,
  oxyUserId: string,
  network: NetworkType
): Promise<number> {
  const [row] = await db
    .select({ nextDerivationIndex: socialReceiveCursors.nextDerivationIndex })
    .from(socialReceiveCursors)
    .where(
      and(
        eq(socialReceiveCursors.oxyUserId, oxyUserId),
        eq(socialReceiveCursors.network, network)
      )
    );

  if (!row) return SOCIAL_RECEIVE_FIRST_FRESH_INDEX - 1;
  return row.nextDerivationIndex - 1;
}
