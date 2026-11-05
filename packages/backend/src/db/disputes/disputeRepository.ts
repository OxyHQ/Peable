import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DisputeFileEvidenceField } from '@peable.to/shared-types';
import { newId } from '../../lib/ids';
import type { DisputeStatus } from '../schema/valueSets';
import { disputeEvidenceFiles, disputes, files, paymentIntents } from '../schema';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { ProviderId } from '../../services/providers/provider';

/** A dispute row as the service reads it back. */
export interface DisputeRow {
  /**
   * The mode this row lives in — its merchant's, read in the same statement
   * (`merchantLivemodeOf`, ADR 0017). Selects the provider key any operation on
   * it is sent with, and is what the wire calls `livemode`.
   */
  readonly livemode: boolean;
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
  /** When the merchant's response reached the network. `null` if it has not. */
  readonly evidenceSubmittedAt: Date | null;
  /** Whether evidence is staged — the provider's answer, a boolean and never the words. */
  readonly hasEvidence: boolean;
  readonly isChargeRefundable: boolean;
  readonly metadata: Record<string, string>;
  /** The disputed payment's `ch_…`, when it has one. */
  readonly chargePublicId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const DISPUTE_COLUMNS = {
  livemode: merchantLivemodeOf(disputes.merchantId),
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
  evidenceSubmittedAt: disputes.evidenceSubmittedAt,
  hasEvidence: disputes.hasEvidence,
  isChargeRefundable: disputes.isChargeRefundable,
  metadata: disputes.metadata,
  // Table-qualified raw SQL (CONVENTIONS.md §Payments core): RETURNING renders
  // columns unqualified, and an unqualified column here would bind to `charges`.
  chargePublicId: sql<
    string | null
  >`(select "charges"."public_id" from "charges" where "charges"."payment_intent_id" = "disputes"."payment_intent_id")`,
  createdAt: disputes.createdAt,
  updatedAt: disputes.updatedAt,
} as const;

function toRow(
  row: typeof DISPUTE_COLUMNS extends never ? never : Record<string, unknown>,
): DisputeRow {
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
  /** The provider's `is_charge_refundable`; absent keeps what is stored. */
  readonly isChargeRefundable?: boolean;
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
      isChargeRefundable: params.isChargeRefundable ?? false,
    })
    .onConflictDoUpdate({
      target: [disputes.provider, disputes.providerObjectId],
      set: {
        status: params.status,
        reason: params.reason ?? null,
        evidenceDueAt: params.evidenceDueAt ?? null,
        ...(params.isChargeRefundable === undefined
          ? {}
          : { isChargeRefundable: params.isChargeRefundable }),
        updatedAt: new Date(),
      },
    })
    .returning({
      ...DISPUTE_COLUMNS,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
    });

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

/**
 * Record that the merchant's response reached the network.
 *
 * Guarded on `evidence_submitted_at IS NULL`, so it is a CLAIM rather than a
 * write: submitting is one-way at the network, and two requests racing must not
 * both send one. The loser gets `null` and reports that the dispute was already
 * answered.
 *
 * Written AFTER the provider call, which is the opposite of every money
 * movement here and is right for the same reason those are the other way round:
 * this row is not the record of an attempt, it is the record of a fact at the
 * network. Writing it first would claim a merchant had responded when the call
 * might still fail — and with the deadline running, a false "answered" is worse
 * than a retry.
 */
export async function markDisputeEvidenceSubmitted(
  db: DatabaseOrTransaction,
  disputeId: string,
  at: Date,
): Promise<DisputeRow | null> {
  const [row] = await db
    .update(disputes)
    .set({ evidenceSubmittedAt: at, hasEvidence: true })
    .where(and(eq(disputes.id, disputeId), isNull(disputes.evidenceSubmittedAt)))
    .returning(DISPUTE_COLUMNS);
  return row ? toRow(row) : null;
}

/** By `dp_…`, SCOPED TO THE MERCHANT — see `findAccountByPublicId` on why. */
export async function findDisputeByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<DisputeRow | null> {
  const [row] = await db
    .select(DISPUTE_COLUMNS)
    .from(disputes)
    .where(and(eq(disputes.merchantId, merchantId), eq(disputes.publicId, publicId)))
    .limit(1);
  return row ? toRow(row) : null;
}

/**
 * Disputes by `dp_…`, SCOPED TO THE MERCHANT, each with its payment's `pi_…` —
 * the `expand[]` loader's read: one statement for every id on a page.
 */
export async function findDisputesForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<DisputeWithIntentRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select({ ...DISPUTE_COLUMNS, paymentIntentPublicId: paymentIntents.publicId })
    .from(disputes)
    .innerJoin(paymentIntents, eq(paymentIntents.id, disputes.paymentIntentId))
    .where(and(eq(disputes.merchantId, merchantId), inArray(disputes.publicId, [...publicIds])));
  return rows.map((row) => ({ ...toRow(row), paymentIntentPublicId: row.paymentIntentPublicId }));
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
    .where(and(eq(disputes.provider, provider), eq(disputes.providerObjectId, providerObjectId)))
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

/** A dispute plus its payment's PUBLIC id. */
export interface DisputeWithIntentRow extends DisputeRow {
  readonly paymentIntentPublicId: string;
}

export interface ListDisputesParams {
  readonly merchantId: string;
  /** Only the disputes of this payment — its INTERNAL id, already resolved inside the merchant. */
  readonly paymentIntentId?: string | undefined;
  readonly page: KeysetPage;
}

/** One page of a merchant's disputes, newest first (`db/keyset.ts`). */
export async function listDisputesForMerchant(
  db: DatabaseOrTransaction,
  params: ListDisputesParams,
): Promise<{ data: DisputeWithIntentRow[]; hasMore: boolean }> {
  const walk = keyset(disputes.id, disputes.createdAt, params.page);
  const rows = await db
    .select({ ...DISPUTE_COLUMNS, paymentIntentPublicId: paymentIntents.publicId })
    .from(disputes)
    .innerJoin(paymentIntents, eq(paymentIntents.id, disputes.paymentIntentId))
    .where(
      and(
        eq(disputes.merchantId, params.merchantId),
        params.paymentIntentId === undefined
          ? undefined
          : eq(disputes.paymentIntentId, params.paymentIntentId),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(
    rows.map((row) => ({ ...toRow(row), paymentIntentPublicId: row.paymentIntentPublicId })),
  );
}

/**
 * Record what the provider said after a draft: whether evidence is staged, and
 * whether the charge is still refundable. The draft's words stay at the
 * provider.
 */
export async function recordDisputeDraft(
  db: DatabaseOrTransaction,
  disputeId: string,
  facts: { readonly hasEvidence: boolean; readonly isChargeRefundable: boolean },
): Promise<DisputeRow | null> {
  const [row] = await db
    .update(disputes)
    .set({ hasEvidence: facts.hasEvidence, isChargeRefundable: facts.isChargeRefundable })
    .where(eq(disputes.id, disputeId))
    .returning(DISPUTE_COLUMNS);
  return row ? toRow(row) : null;
}

/** Merge a metadata patch in the statement (`db/metadata.ts`). */
export async function updateDisputeMetadata(
  db: DatabaseOrTransaction,
  disputeId: string,
  patch: MetadataPatch,
): Promise<DisputeRow | 'limit_exceeded'> {
  const merged = mergedMetadata(disputes.metadata, patch);
  const [row] = await db
    .update(disputes)
    .set({ metadata: merged })
    .where(and(eq(disputes.id, disputeId), metadataWithinLimit(merged)))
    .returning(DISPUTE_COLUMNS);
  return row ? toRow(row) : 'limit_exceeded';
}

/**
 * The merchant accepted the dispute: `lost`, with no deadline left — a
 * COMPARE-AND-SWAP on `needs_response`, so a close racing the network's own
 * decision (or a second close) changes nothing and returns `null`.
 */
export async function closeDisputeAsLost(
  db: DatabaseOrTransaction,
  disputeId: string,
): Promise<DisputeRow | null> {
  const [row] = await db
    .update(disputes)
    .set({ status: 'lost', evidenceDueAt: null })
    .where(and(eq(disputes.id, disputeId), eq(disputes.status, 'needs_response')))
    .returning(DISPUTE_COLUMNS);
  return row ? toRow(row) : null;
}

/** One file attached to a dispute's response. */
export interface DisputeEvidenceFileRow {
  readonly field: DisputeFileEvidenceField;
  /** The File's INTERNAL id. */
  readonly fileId: string;
  readonly filePublicId: string;
}

/** The files attached to a dispute, by field. */
export async function listDisputeEvidenceFiles(
  db: DatabaseOrTransaction,
  disputeId: string,
): Promise<DisputeEvidenceFileRow[]> {
  const rows = await db
    .select({
      field: disputeEvidenceFiles.field,
      fileId: disputeEvidenceFiles.fileId,
      filePublicId: files.publicId,
    })
    .from(disputeEvidenceFiles)
    .innerJoin(files, eq(files.id, disputeEvidenceFiles.fileId))
    .where(eq(disputeEvidenceFiles.disputeId, disputeId));
  return rows.map((row) => ({ ...row, field: row.field as DisputeFileEvidenceField }));
}

/**
 * Attach (`fileId`) or detach (`null`) files per field, in the caller's
 * transaction. The composite references refuse another merchant's file and
 * any file not of purpose `dispute_evidence`; the caller has checked both, so
 * the answer is a 400 and not a constraint.
 */
export async function setDisputeEvidenceFiles(
  db: DatabaseOrTransaction,
  dispute: { readonly id: string; readonly merchantId: string },
  changes: readonly { readonly field: DisputeFileEvidenceField; readonly fileId: string | null }[],
): Promise<void> {
  const detach = changes.filter((change) => change.fileId === null).map((change) => change.field);
  if (detach.length > 0) {
    await db
      .delete(disputeEvidenceFiles)
      .where(
        and(
          eq(disputeEvidenceFiles.disputeId, dispute.id),
          inArray(disputeEvidenceFiles.field, detach),
        ),
      );
  }
  for (const change of changes) {
    if (change.fileId === null) continue;
    await db
      .insert(disputeEvidenceFiles)
      .values({
        disputeId: dispute.id,
        merchantId: dispute.merchantId,
        field: change.field,
        fileId: change.fileId,
      })
      .onConflictDoUpdate({
        target: [disputeEvidenceFiles.disputeId, disputeEvidenceFiles.field],
        set: { fileId: change.fileId },
      });
  }
}

/**
 * Every dispute of the merchant opened in `[start, end)`, OLDEST first, a page at a time — what
 * the `disputes.itemized.1` report reads (`services/reporting/reports.ts`). A keyset
 * walk on the primary key, so a busy interval never holds more than one page
 * beside the CSV being written. Scoped in the predicate, like its list.
 */
export async function* disputesForReport(
  db: DatabaseOrTransaction,
  merchantId: string,
  interval: { readonly start: Date; readonly end: Date; readonly currency: string | null },
  pageSize = 1000,
): AsyncGenerator<DisputeWithIntentRow> {
  let after: string | null = null;
  for (;;) {
    const rows = await db
      .select({ ...DISPUTE_COLUMNS, paymentIntentPublicId: paymentIntents.publicId })
      .from(disputes)
      .innerJoin(paymentIntents, eq(paymentIntents.id, disputes.paymentIntentId))
      .where(
        and(
          eq(disputes.merchantId, merchantId),
          gte(disputes.createdAt, interval.start),
          lt(disputes.createdAt, interval.end),
          interval.currency === null ? undefined : eq(disputes.currency, interval.currency),
          after === null ? undefined : gt(disputes.id, after),
        ),
      )
      .orderBy(asc(disputes.id))
      .limit(pageSize);
    yield* rows.map((row) => ({ ...toRow(row), paymentIntentPublicId: row.paymentIntentPublicId }));
    const last = rows.at(-1);
    if (!last || rows.length < pageSize) return;
    after = last.id;
  }
}
