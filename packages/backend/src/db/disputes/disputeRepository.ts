import { and, desc, eq } from 'drizzle-orm';
import { newId } from '../../lib/ids';
import type { DisputeStatus } from '../schema/valueSets';
import { disputes } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ProviderId } from '../../services/providers/provider';

/** A dispute row as the service reads it back. */
export interface DisputeRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: DisputeStatus;
  readonly provider: string;
  readonly providerObjectId: string;
  readonly reason: string | null;
  readonly evidenceDueAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const DISPUTE_COLUMNS = {
  id: disputes.id,
  publicId: disputes.publicId,
  merchantId: disputes.merchantId,
  paymentIntentId: disputes.paymentIntentId,
  amount: disputes.amount,
  currency: disputes.currency,
  status: disputes.status,
  provider: disputes.provider,
  providerObjectId: disputes.providerObjectId,
  reason: disputes.reason,
  evidenceDueAt: disputes.evidenceDueAt,
  createdAt: disputes.createdAt,
  updatedAt: disputes.updatedAt,
} as const;

function toRow(row: typeof DISPUTE_COLUMNS extends never ? never : Record<string, unknown>): DisputeRow {
  return { ...row, status: row.status as DisputeStatus } as DisputeRow;
}

/** What an inbound dispute event says. */
export interface UpsertDisputeParams {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly provider: ProviderId;
  readonly providerObjectId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: DisputeStatus;
  readonly reason?: string | null;
  readonly evidenceDueAt?: Date | null;
}

/**
 * Record a dispute the network opened, or update the one already recorded.
 *
 * ONE statement, and the reason is the same one the derivation-index
 * reservation has: this runs from an event drain that every ECS task polls.
 * A read-then-write would let two tasks both find nothing and both insert, and
 * the second would fail the unique index — turning an ordinary redelivery into
 * a `failed` row that retries with backoff and eventually dead-letters. The
 * `on conflict do update` makes the redelivery a no-op write instead.
 *
 * ## Why this is an UPSERT where refunds have an INSERT and a separate UPDATE
 *
 * `createRefund` writes the row and THEN calls the provider, so it always knows
 * whether the row is new — Peable created it. Nothing here created anything:
 * `charge.dispute.created` and `charge.dispute.closed` are two events about one
 * object that may arrive in either order, and the second one must not need the
 * first to have landed. Both call this.
 *
 * ## What a redelivery must NOT do
 *
 * `created_at` is deliberately not in the update set. It is the moment the
 * gateway first heard about this dispute, and a merchant reading "opened" wants
 * that, not the moment a provider happened to resend it. `public_id` is
 * excluded for the harder reason: it has been on the wire since the first
 * delivery, and re-minting it on a redelivery would give one dispute two
 * identities.
 *
 * @returns The row as persisted, and whether this call created it — which is
 *   what decides whether the merchant is told, since telling them twice about
 *   one dispute is the failure this table's unique index exists to prevent.
 */
export async function upsertDispute(
  db: DatabaseOrTransaction,
  params: UpsertDisputeParams,
): Promise<{ dispute: DisputeRow; created: boolean }> {
  const [row] = await db
    .insert(disputes)
    .values({
      publicId: newId('dp'),
      merchantId: params.merchantId,
      paymentIntentId: params.paymentIntentId,
      amount: params.amount,
      currency: params.currency,
      status: params.status,
      provider: params.provider,
      providerObjectId: params.providerObjectId,
      reason: params.reason ?? null,
      evidenceDueAt: params.evidenceDueAt ?? null,
    })
    .onConflictDoUpdate({
      target: [disputes.provider, disputes.providerObjectId],
      set: {
        status: params.status,
        reason: params.reason ?? null,
        evidenceDueAt: params.evidenceDueAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ ...DISPUTE_COLUMNS, createdAt: disputes.createdAt, updatedAt: disputes.updatedAt });

  if (!row) {
    // Unreachable: `on conflict do update` always returns a row, unlike
    // `do nothing`. Stated rather than assumed because the two differ here in
    // exactly the way that would make this silently return undefined.
    throw new Error(
      `Dispute ${params.provider}/${params.providerObjectId} could not be read back after upsert.`,
    );
  }

  // `created_at === updated_at` is how a fresh insert is told from an update
  // WITHOUT a second query: the column defaults are the same expression, and
  // the update set above always moves `updated_at`. Both are millisecond
  // `timestamptz` (see CONVENTIONS.md §Timestamps), so this compares two values
  // at the precision they are stored at rather than at the one JS would round.
  const created = row.createdAt.getTime() === row.updatedAt.getTime();
  return { dispute: toRow(row), created };
}

/** One dispute by the network's own id — the drain's lookup. */
export async function findDisputeByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string,
): Promise<DisputeRow | null> {
  const [row] = await db
    .select(DISPUTE_COLUMNS)
    .from(disputes)
    .where(
      and(eq(disputes.provider, provider), eq(disputes.providerObjectId, providerObjectId)),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

/** Every dispute against one payment, newest first. */
export async function listDisputesForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
): Promise<DisputeRow[]> {
  const rows = await db
    .select(DISPUTE_COLUMNS)
    .from(disputes)
    .where(eq(disputes.paymentIntentId, paymentIntentId))
    .orderBy(desc(disputes.createdAt));
  return rows.map(toRow);
}
