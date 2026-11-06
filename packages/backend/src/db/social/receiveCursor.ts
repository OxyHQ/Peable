import { and, eq, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { SOCIAL_RECEIVE_FIRST_FRESH_INDEX, socialReceiveCursors } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { uuidv7 } from '@oxy.so/db';
import { SOCIAL_RECEIVE_INDEX_LIMIT } from '@peable.to/contracts/vocabulary';

/**
 * The recipient's tree is full: every index the Peable wallet watches with its
 * gap above has been handed out (ADR 0021 D9, amended 2026-11-06). Nothing was
 * reserved. A FairCoin payment answers `faircoin_capacity_reached` (and may
 * still recycle), `@username` answers `faircoin_receive_tree_full`.
 */
export class ReceiveTreeFullError extends Error {
  constructor(oxyUserId: string, network: NetworkType) {
    super(`the ${network} receive tree of ${oxyUserId} has no index left that its wallet watches`);
    this.name = 'ReceiveTreeFullError';
  }
}

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
 * — and two concurrent first payments both try to create it. That takes
 * three moves: create, tolerate the duplicate-key error, then increment.
 * `INSERT … ON CONFLICT DO UPDATE` is all three at once, so
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
 *
 * ## The ceiling is in the same statement
 *
 * The wallet watches indices `0 .. SOCIAL_RECEIVE_MAX_WATCHED - 1` and reaches
 * `SOCIAL_RECEIVE_GAP_LIMIT` past the highest reserved; an index at or above
 * `SOCIAL_RECEIVE_INDEX_LIMIT` (`@peable.to/contracts/vocabulary`) would be
 * paid where it does not look. The conflict branch's `WHERE` refuses it: the
 * row lock the upsert takes is the same one the increment needs, so two
 * callers can never both pass the bound, and a refused call returns no row and
 * changes nothing. The insert branch hands out `FIRST_FRESH_INDEX`, far below.
 *
 * @throws {ReceiveTreeFullError} the next index is `>= SOCIAL_RECEIVE_INDEX_LIMIT`.
 */
export async function reserveNextSocialReceiveIndex(
  db: DatabaseOrTransaction,
  oxyUserId: string,
  network: NetworkType,
  identityPublicKey: string,
): Promise<number> {
  const [row] = await db
    .insert(socialReceiveCursors)
    .values({
      id: uuidv7(),
      oxyUserId,
      network,
      nextDerivationIndex: SOCIAL_RECEIVE_FIRST_FRESH_INDEX + 1,
      identityPublicKey,
    })
    .onConflictDoUpdate({
      target: [socialReceiveCursors.oxyUserId, socialReceiveCursors.network],
      // The key is written on every reservation, not only on the insert: it is
      // the key THIS address was derived from, and a recipient whose account
      // key changes must not leave the cursor claiming the previous one.
      set: {
        nextDerivationIndex: sql`${socialReceiveCursors.nextDerivationIndex} + 1`,
        identityPublicKey,
      },
      // The ceiling (ADR 0021 D9, amended 2026-11-06): the index this branch
      // hands out is the pre-increment value, so it must be below the limit.
      setWhere: sql`${socialReceiveCursors.nextDerivationIndex} < ${SOCIAL_RECEIVE_INDEX_LIMIT}`,
    })
    .returning({ index: sql<number>`${socialReceiveCursors.nextDerivationIndex} - 1` });

  // `DO UPDATE … WHERE` produces no row exactly when the WHERE refused it.
  if (!row) throw new ReceiveTreeFullError(oxyUserId, network);
  return row.index;
}

/**
 * The highest index EVER reserved for this user on this network, without
 * reserving another — backs the cursor-sync read.
 *
 * The column holds the NEXT index, so the highest already reserved is one less.
 * `FIRST_FRESH_INDEX - 1` when no cursor exists, which is the same answer as
 * "no address has been reserved", stated in the same units.
 *
 * Returns the identity key those addresses were derived from alongside it, so
 * the caller's device can compare it with the key it derives from itself. It is
 * `null` for a cursor that predates the column, and for a user with no cursor.
 */
export async function readReservedThrough(
  db: DatabaseOrTransaction,
  oxyUserId: string,
  network: NetworkType,
): Promise<{ reservedThrough: number; identityPublicKey: string | null }> {
  const [row] = await db
    .select({
      nextDerivationIndex: socialReceiveCursors.nextDerivationIndex,
      identityPublicKey: socialReceiveCursors.identityPublicKey,
    })
    .from(socialReceiveCursors)
    .where(
      and(eq(socialReceiveCursors.oxyUserId, oxyUserId), eq(socialReceiveCursors.network, network)),
    );

  if (!row) {
    return { reservedThrough: SOCIAL_RECEIVE_FIRST_FRESH_INDEX - 1, identityPublicKey: null };
  }
  return {
    reservedThrough: row.nextDerivationIndex - 1,
    identityPublicKey: row.identityPublicKey,
  };
}
