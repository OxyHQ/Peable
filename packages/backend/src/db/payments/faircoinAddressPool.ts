import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { paymentIntentOutputs, paymentIntents } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * A recipient's FairCoin address pool (ADR 0021 D9): the addresses reserved on
 * its cursor for PAYMENTS (`payment_intent_outputs`), and which of them may be
 * handed out again.
 *
 * The cursor itself (`db/social/receiveCursor.ts`) is untouched and stays ONE
 * statement. What this adds is the decision BEFORE it — "is there an address
 * this recipient already owns that nobody can still be paying?" — and the
 * bound that makes the cursor's growth a function of real payments rather than
 * of how many times anyone asks.
 *
 * Every time here is the DATABASE's `now()`, the clock `canceled_at` was
 * stamped with, so the quarantine never compares two clocks.
 */

/** Seconds as an interval, bound as a parameter (never interpolated into SQL text). */
const seconds = (value: number) => sql`(${value}::integer * interval '1 second')`;

/**
 * Serialize every payment reservation for one recipient on one network until
 * the caller's transaction ends — so the open count below and the reservation
 * that follows it are one decision. Two concurrent confirms for one recipient
 * wait on each other; two for different recipients never do.
 *
 * A transaction-scoped advisory lock rather than a row lock: the pool has no
 * row of its own, and the cursor row may not exist yet (its create is the
 * reservation). Keyed by a 64-bit hash of the pair, which a collision would
 * only make two recipients share a queue, never an address.
 */
export async function lockRecipientPool(
  tx: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
): Promise<void> {
  const key = `faircoin-pool:${network}:${recipientAccountId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

const holderOf = (recipientAccountId: string, network: NetworkType) =>
  and(
    eq(paymentIntentOutputs.recipientAccountId, recipientAccountId),
    eq(paymentIntentOutputs.network, network),
    isNull(paymentIntentOutputs.recycledAt),
    isNull(paymentIntentOutputs.retiredAt),
  );

/**
 * How many of the recipient's addresses are OPEN: held by a payment that can
 * still be paid (`requires_action`) or is being paid (`processing`), or by one
 * cancelled less than `quarantineSeconds` ago (a late payer may still send to
 * it). A succeeded payment's address is spent for good and not counted; an
 * older cancelled one is either recyclable or retired, and not counted either.
 */
export async function countOpenAddresses(
  db: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
  quarantineSeconds: number,
): Promise<number> {
  const [row] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(paymentIntentOutputs)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentIntentOutputs.paymentIntentId))
    .where(
      and(
        holderOf(recipientAccountId, network),
        sql`(${paymentIntents.status} in ('requires_action', 'processing') or (${paymentIntents.status} = 'canceled' and ${paymentIntents.canceledAt} > now() - ${seconds(quarantineSeconds)}))`,
      ),
    );
  return Number(row?.open ?? 0);
}

export interface RecycleCandidate {
  /** The output row (`payment_intent_outputs.id`) that holds the address now. */
  readonly id: string;
  readonly address: string;
  readonly derivationIndex: number;
}

/** A candidate this caller holds the lease of, and whether the chain showed it unused recently. */
export interface LeasedRecycleCandidate extends RecycleCandidate {
  /** `recycle_checked_at` is within the freshness the caller asked for: no chain read is needed. */
  readonly checkedFresh: boolean;
}

/** The SQL half of "recyclable": the holder of a payment cancelled before the quarantine. */
const recyclable = (recipientAccountId: string, network: NetworkType, quarantineSeconds: number) =>
  and(
    holderOf(recipientAccountId, network),
    isNotNull(paymentIntentOutputs.derivationIndex),
    eq(paymentIntents.status, 'canceled'),
    sql`${paymentIntents.canceledAt} <= now() - ${seconds(quarantineSeconds)}`,
  );

/**
 * Addresses the recipient owns that may be handed out again, lowest index
 * first (a compact tree is a cheaper one to scan): held by a `canceled`
 * payment, cancelled at least `quarantineSeconds` ago, never recycled or
 * retired, with the index they derive at recorded. Whether the chain agrees
 * they never received anything is the caller's check — this is the SQL half.
 */
export async function listRecycleCandidates(
  db: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
  quarantineSeconds: number,
  limit: number,
): Promise<RecycleCandidate[]> {
  const rows = await db
    .select({
      id: paymentIntentOutputs.id,
      address: paymentIntentOutputs.address,
      derivationIndex: paymentIntentOutputs.derivationIndex,
    })
    .from(paymentIntentOutputs)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentIntentOutputs.paymentIntentId))
    .where(recyclable(recipientAccountId, network, quarantineSeconds))
    .orderBy(paymentIntentOutputs.derivationIndex)
    .limit(limit);
  return rows.flatMap((row) =>
    row.derivationIndex === null ? [] : [{ ...row, derivationIndex: row.derivationIndex }],
  );
}

/**
 * Take the lowest-index recyclable address nobody else holds a lease on, for
 * `leaseSeconds` — ONE statement, outside any transaction, so concurrent
 * confirms each take a DIFFERENT candidate to check against the chain (ADR
 * 0021 D9, amended 2026-11-06: before this every overlapping confirm checked
 * the same lowest one, only one could claim it, and the rest minted). The
 * subquery's `for update skip locked` and the outer guard on the lease make
 * two takers of one row impossible. `null` when no candidate is left.
 */
export async function leaseRecycleCandidate(
  db: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
  quarantineSeconds: number,
  leaseSeconds: number,
  checkedFreshSeconds: number,
): Promise<LeasedRecycleCandidate | null> {
  const leaseFree = sql`(${paymentIntentOutputs.recycleLeaseUntil} is null or ${paymentIntentOutputs.recycleLeaseUntil} < now())`;
  const next = db
    .select({ id: paymentIntentOutputs.id })
    .from(paymentIntentOutputs)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentIntentOutputs.paymentIntentId))
    .where(and(recyclable(recipientAccountId, network, quarantineSeconds), leaseFree))
    .orderBy(paymentIntentOutputs.derivationIndex)
    .limit(1)
    .for('update', { of: paymentIntentOutputs, skipLocked: true });
  const [row] = await db
    .update(paymentIntentOutputs)
    .set({ recycleLeaseUntil: sql`now() + ${seconds(leaseSeconds)}` })
    .where(
      and(
        sql`${paymentIntentOutputs.id} = (${next})`,
        isNull(paymentIntentOutputs.recycledAt),
        isNull(paymentIntentOutputs.retiredAt),
        leaseFree,
      ),
    )
    .returning({
      id: paymentIntentOutputs.id,
      address: paymentIntentOutputs.address,
      derivationIndex: paymentIntentOutputs.derivationIndex,
      checkedFresh: sql<boolean>`coalesce(${paymentIntentOutputs.recycleCheckedAt} > now() - ${seconds(checkedFreshSeconds)}, false)`,
    });
  if (!row || row.derivationIndex === null) return null;
  return { ...row, derivationIndex: row.derivationIndex };
}

/** Give a lease back before it lapses: this caller will not claim the candidate. */
export async function releaseRecycleLease(
  db: DatabaseOrTransaction,
  outputId: string,
): Promise<void> {
  await db
    .update(paymentIntentOutputs)
    .set({ recycleLeaseUntil: null })
    .where(eq(paymentIntentOutputs.id, outputId));
}

/**
 * Record that the chain showed this candidate unused just now
 * (`recycle_checked_at`), so a reservation under the pool's lock can claim it
 * without an HTTP call of its own.
 */
export async function markRecycleCandidateUnused(
  db: DatabaseOrTransaction,
  outputId: string,
): Promise<void> {
  await db
    .update(paymentIntentOutputs)
    .set({ recycleCheckedAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(paymentIntentOutputs.id, outputId),
        isNull(paymentIntentOutputs.recycledAt),
        isNull(paymentIntentOutputs.retiredAt),
      ),
    );
}

/**
 * Recyclable addresses the chain showed unused within `checkedFreshSeconds`,
 * lowest index first — the choice a reservation makes UNDER the pool's lock
 * when the candidate it planned was taken, with no chain read.
 */
export async function listCheckedRecycleCandidates(
  tx: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
  quarantineSeconds: number,
  checkedFreshSeconds: number,
  limit: number,
): Promise<RecycleCandidate[]> {
  const rows = await tx
    .select({
      id: paymentIntentOutputs.id,
      address: paymentIntentOutputs.address,
      derivationIndex: paymentIntentOutputs.derivationIndex,
    })
    .from(paymentIntentOutputs)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentIntentOutputs.paymentIntentId))
    .where(
      and(
        recyclable(recipientAccountId, network, quarantineSeconds),
        sql`${paymentIntentOutputs.recycleCheckedAt} > now() - ${seconds(checkedFreshSeconds)}`,
      ),
    )
    .orderBy(paymentIntentOutputs.derivationIndex)
    .limit(limit);
  return rows.flatMap((row) =>
    row.derivationIndex === null ? [] : [{ ...row, derivationIndex: row.derivationIndex }],
  );
}

/**
 * Take a candidate over for a new payment, in the new payment's transaction: a
 * compare-and-swap on the row still being the address's holder and its payment
 * still cancelled. `false` when another reservation took it first (or it was
 * retired meanwhile) — the caller reserves a fresh index instead.
 */
export async function claimRecycleCandidate(
  tx: DatabaseOrTransaction,
  outputId: string,
): Promise<boolean> {
  const rows = await tx
    .update(paymentIntentOutputs)
    .set({ recycledAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(paymentIntentOutputs.id, outputId),
        isNull(paymentIntentOutputs.recycledAt),
        isNull(paymentIntentOutputs.retiredAt),
        sql`exists (select 1 from ${paymentIntents} where ${paymentIntents.id} = ${paymentIntentOutputs.paymentIntentId} and ${paymentIntents.status} = 'canceled')`,
      ),
    )
    .returning({ id: paymentIntentOutputs.id });
  return rows.length > 0;
}

/**
 * Never offer this address again: the chain shows it received something, or it
 * no longer derives from the recipient's key. The address stays its payment's.
 */
export async function retireRecycleCandidate(
  db: DatabaseOrTransaction,
  outputId: string,
): Promise<void> {
  await db
    .update(paymentIntentOutputs)
    .set({ retiredAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(paymentIntentOutputs.id, outputId),
        isNull(paymentIntentOutputs.recycledAt),
        isNull(paymentIntentOutputs.retiredAt),
      ),
    );
}
