import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { paymentIntentOutputs, paymentIntents } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * The per-recipient bound on FairCoin addresses handed out for PAYMENTS (ADR
 * 0021 D9, amended 2026-11-06): the reads that make "how many of this
 * recipient's addresses went unpaid lately" one decision with the reservation
 * that follows it.
 *
 * Addresses are never recycled: every payment gets a fresh index of the
 * recipient's cursor (`db/social/receiveCursor.ts`, ONE statement), and the
 * recipient's wallet watches every address ever handed out
 * (`GET /v1/social/me/receive_addresses`). What bounds the growth of that set
 * is this count, not a ceiling on the tree.
 *
 * Every time here is the DATABASE's `now()`, the clock `created_at` was stamped
 * with, so the window never compares two clocks.
 */

/** Seconds as an interval, bound as a parameter (never interpolated into SQL text). */
const seconds = (value: number) => sql`(${value}::integer * interval '1 second')`;

/**
 * Serialize every address reservation for one recipient on one network until
 * the caller's transaction ends — so the count below and the reservation that
 * follows it are one decision. Two concurrent confirms (or `@username` asks)
 * for one recipient wait on each other; two for different recipients never do.
 *
 * A transaction-scoped advisory lock rather than a row lock: the bound has no
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

/**
 * How many of the recipient's PAYMENT addresses on `network` were handed out
 * in the last `windowSeconds` and are not paid: their payment is anything but
 * `succeeded` — waiting for the payer, cancelled, or `processing` (a reported
 * txid that has not settled; counting it is what keeps a made-up txid from
 * buying a place outside the bound). A paid address never counts.
 */
export async function countUnpaidAddressesSince(
  db: DatabaseOrTransaction,
  recipientAccountId: string,
  network: NetworkType,
  windowSeconds: number,
): Promise<number> {
  const [row] = await db
    .select({ unpaid: sql<number>`count(*)::int` })
    .from(paymentIntentOutputs)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentIntentOutputs.paymentIntentId))
    .where(
      and(
        eq(paymentIntentOutputs.recipientAccountId, recipientAccountId),
        eq(paymentIntentOutputs.network, network),
        gt(paymentIntentOutputs.createdAt, sql`now() - ${seconds(windowSeconds)}`),
        ne(paymentIntents.status, 'succeeded'),
      ),
    );
  return Number(row?.unpaid ?? 0);
}
