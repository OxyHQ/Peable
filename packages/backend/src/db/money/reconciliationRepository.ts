/**
 * `reconciliation_mismatches` — what the daily reconciliation found (ADR 0015
 * §4). Recorded and surfaced, never auto-corrected: the job that finds a
 * difference does not also "fix" the ledger, because the difference is the
 * evidence an operator needs.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { ReconciliationMismatchKind } from '@peable.to/shared-types';
import { connectedAccounts, reconciliationMismatches } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { newId } from '../../lib/ids';

export interface ReconciliationMismatchRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly connectedAccountId: string | null;
  readonly connectedAccountPublicId: string | null;
  readonly kind: ReconciliationMismatchKind;
  readonly subject: string;
  readonly objectPublicId: string | null;
  readonly expected: Record<string, unknown> | null;
  readonly actual: Record<string, unknown> | null;
  readonly detectedAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date | null;
}

const COLUMNS = {
  livemode: merchantLivemodeOf(reconciliationMismatches.merchantId),
  id: reconciliationMismatches.id,
  publicId: reconciliationMismatches.publicId,
  merchantId: reconciliationMismatches.merchantId,
  connectedAccountId: reconciliationMismatches.connectedAccountId,
  connectedAccountPublicId: sql<
    string | null
  >`(select ${connectedAccounts.publicId} from ${connectedAccounts} where ${connectedAccounts.id} = ${reconciliationMismatches.connectedAccountId})`,
  kind: reconciliationMismatches.kind,
  subject: reconciliationMismatches.subject,
  objectPublicId: reconciliationMismatches.objectPublicId,
  expected: reconciliationMismatches.expected,
  actual: reconciliationMismatches.actual,
  detectedAt: reconciliationMismatches.detectedAt,
  lastSeenAt: reconciliationMismatches.lastSeenAt,
  resolvedAt: reconciliationMismatches.resolvedAt,
} as const;

function toRow(row: Record<string, unknown>): ReconciliationMismatchRow {
  return row as unknown as ReconciliationMismatchRow;
}

/**
 * Record a mismatch, or refresh the open one for the same (kind, subject).
 * @returns `true` when it is NEW — the caller logs only new ones.
 */
export async function recordMismatch(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly connectedAccountId: string | null;
    readonly kind: ReconciliationMismatchKind;
    readonly subject: string;
    readonly objectPublicId: string | null;
    readonly expected: Record<string, unknown> | null;
    readonly actual: Record<string, unknown> | null;
    readonly seenAt: Date;
  },
): Promise<boolean> {
  const refreshed = await db
    .update(reconciliationMismatches)
    .set({ lastSeenAt: params.seenAt, expected: params.expected, actual: params.actual })
    .where(
      and(
        eq(reconciliationMismatches.kind, params.kind),
        eq(reconciliationMismatches.subject, params.subject),
        isNull(reconciliationMismatches.resolvedAt),
      ),
    )
    .returning({ id: reconciliationMismatches.id });
  if (refreshed.length > 0) return false;
  const inserted = await db
    .insert(reconciliationMismatches)
    .values({
      id: uuidv7(),
      publicId: newId('recon'),
      merchantId: params.merchantId,
      connectedAccountId: params.connectedAccountId,
      kind: params.kind,
      subject: params.subject,
      objectPublicId: params.objectPublicId,
      expected: params.expected,
      actual: params.actual,
      detectedAt: params.seenAt,
      lastSeenAt: params.seenAt,
    })
    .onConflictDoNothing()
    .returning({ id: reconciliationMismatches.id });
  return inserted.length > 0;
}

/**
 * Close the open mismatches of one scope that the run that started at
 * `runStartedAt` did not see again: the difference is gone. Closing is not a
 * correction — the row stays, with when it was resolved.
 */
export async function resolveUnseenMismatches(
  db: DatabaseOrTransaction,
  scope: { readonly merchantId: string; readonly connectedAccountId: string | null },
  runStartedAt: Date,
): Promise<number> {
  const resolved = await db
    .update(reconciliationMismatches)
    .set({ resolvedAt: runStartedAt })
    .where(
      and(
        eq(reconciliationMismatches.merchantId, scope.merchantId),
        scope.connectedAccountId === null
          ? isNull(reconciliationMismatches.connectedAccountId)
          : eq(reconciliationMismatches.connectedAccountId, scope.connectedAccountId),
        isNull(reconciliationMismatches.resolvedAt),
        lt(reconciliationMismatches.lastSeenAt, runStartedAt),
      ),
    )
    .returning({ id: reconciliationMismatches.id });
  return resolved.length;
}

export async function listMismatches(
  db: DatabaseOrTransaction,
  merchantId: string,
  filter: { readonly open?: boolean },
  page: KeysetPage,
): Promise<{ data: ReconciliationMismatchRow[]; hasMore: boolean }> {
  const walk = keyset(reconciliationMismatches.id, reconciliationMismatches.detectedAt, page);
  const rows = await db
    .select(COLUMNS)
    .from(reconciliationMismatches)
    .where(
      and(
        eq(reconciliationMismatches.merchantId, merchantId),
        filter.open === true ? isNull(reconciliationMismatches.resolvedAt) : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

export async function findMismatchByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<ReconciliationMismatchRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(reconciliationMismatches)
    .where(
      and(
        eq(reconciliationMismatches.merchantId, merchantId),
        eq(reconciliationMismatches.publicId, publicId),
      ),
    );
  return row ? toRow(row) : null;
}
