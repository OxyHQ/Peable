/**
 * The statements of the Oxy file-reference sync queue (`oxy_file_reference_syncs`).
 *
 * `enqueueReferenceSync` is called INSIDE the transaction that changes which
 * file an entity uses — `db/merchants/merchantRepository.ts` is its only
 * production caller — and the loop in `services/oxyFiles/referenceSync.ts`
 * claims, acts and completes. See `db/schema/oxyFiles.ts` for why a row says
 * "make Oxy agree with this database" rather than "add" or "remove".
 */
import { and, eq, lte, or, sql } from 'drizzle-orm';
import { merchants, oxyFileReferenceSyncs } from '../schema';
import type { OxyFileEntityType } from '../schema/valueSets';
import type { DatabaseOrTransaction } from '../postgres';

/** One use of one Oxy file by one Peable entity — Oxy's reference identity. */
export interface FileReferenceKey {
  readonly fileId: string;
  readonly entityType: OxyFileEntityType;
  readonly entityId: string;
}

export interface ClaimedReferenceSync extends FileReferenceKey {
  readonly version: number;
  readonly attempts: number;
}

/**
 * Queue a sync of `key`, due now.
 *
 * Meant to be handed the TRANSACTION that changed the use: a queue row written
 * after the commit could be lost to a crash in between, leaving Oxy with a
 * reference Peable dropped (the file kept alive for nothing) or without one
 * Peable relies on (no events for it, and an application-owned file collected
 * as unused).
 *
 * A pair already queued gets its `version` bumped and is made due now, with its
 * failure count reset — a new change is a new reason to try, not the next step
 * of an old backoff. A live lease is left alone on purpose: the pass holding it
 * finds the version moved, keeps the row, and it runs again.
 */
export async function enqueueReferenceSync(
  db: DatabaseOrTransaction,
  key: FileReferenceKey,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(oxyFileReferenceSyncs)
    .values({
      fileId: key.fileId,
      entityType: key.entityType,
      entityId: key.entityId,
      nextAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: [
        oxyFileReferenceSyncs.fileId,
        oxyFileReferenceSyncs.entityType,
        oxyFileReferenceSyncs.entityId,
      ],
      set: {
        version: sql`${oxyFileReferenceSyncs.version} + 1`,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
      },
    });
}

/**
 * Claim up to `limit` due pairs, in one statement — the same shape, and the
 * same reasoning, as `claimDueDeliveries` in
 * `db/webhooks/webhookOutboxRepository.ts`: the live-lease predicate plus a
 * single statement gives exactly one claimant, and `SKIP LOCKED` keeps a second
 * pass from waiting on the first.
 */
export async function claimDueReferenceSyncs(
  db: DatabaseOrTransaction,
  params: { readonly limit: number; readonly leaseMs: number; readonly now?: Date },
): Promise<ClaimedReferenceSync[]> {
  const now = params.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + params.leaseMs);
  const t = oxyFileReferenceSyncs;

  const due = db
    .select({ fileId: t.fileId, entityType: t.entityType, entityId: t.entityId })
    .from(t)
    .where(
      and(
        lte(t.nextAttemptAt, now),
        or(sql`${t.leaseExpiresAt} is null`, lte(t.leaseExpiresAt, now)),
      ),
    )
    .orderBy(t.nextAttemptAt)
    .limit(params.limit)
    .for('update', { skipLocked: true });

  const rows = await db
    .update(t)
    .set({ leaseExpiresAt })
    .where(sql`(${t.fileId}, ${t.entityType}, ${t.entityId}) in (${due})`)
    .returning({
      fileId: t.fileId,
      entityType: t.entityType,
      entityId: t.entityId,
      version: t.version,
      attempts: t.attempts,
    });
  return rows.map((row) => ({ ...row, entityType: row.entityType as OxyFileEntityType }));
}

function keyIs(key: FileReferenceKey) {
  const t = oxyFileReferenceSyncs;
  return and(
    eq(t.fileId, key.fileId),
    eq(t.entityType, key.entityType),
    eq(t.entityId, key.entityId),
  );
}

/**
 * The pair is in sync AS OF `version`. Deletes the row only when no change was
 * queued since the claim; otherwise releases the lease and makes it due again,
 * so the newer change is acted on. Returns whether the row was removed.
 */
export async function completeReferenceSync(
  db: DatabaseOrTransaction,
  claimed: ClaimedReferenceSync,
  now: Date = new Date(),
): Promise<boolean> {
  const deleted = await db
    .delete(oxyFileReferenceSyncs)
    .where(and(keyIs(claimed), eq(oxyFileReferenceSyncs.version, claimed.version)))
    .returning({ fileId: oxyFileReferenceSyncs.fileId });
  if (deleted.length > 0) return true;
  await db
    .update(oxyFileReferenceSyncs)
    .set({ leaseExpiresAt: null, nextAttemptAt: now })
    .where(keyIs(claimed));
  return false;
}

/** The attempt failed: record why, back off, release the lease. */
export async function failReferenceSync(
  db: DatabaseOrTransaction,
  claimed: ClaimedReferenceSync,
  params: { readonly nextAttemptAt: Date; readonly error: string },
): Promise<void> {
  const t = oxyFileReferenceSyncs;
  await db
    .update(t)
    .set({
      // A change queued meanwhile reset `attempts` and the due time; keep that.
      attempts: sql`case when ${t.version} = ${claimed.version} then ${t.attempts} + 1 else ${t.attempts} end`,
      nextAttemptAt: sql`case when ${t.version} = ${claimed.version} then ${params.nextAttemptAt.toISOString()}::timestamptz else ${t.nextAttemptAt} end`,
      lastError: params.error,
      leaseExpiresAt: null,
    })
    .where(keyIs(claimed));
}

/**
 * Whether this database, NOW, uses the file for the entity — what the sync
 * makes Oxy agree with. Exhaustive over `OxyFileEntityType`, so a new use
 * without its own answer does not compile.
 */
export async function isReferenceWanted(
  db: DatabaseOrTransaction,
  key: FileReferenceKey,
): Promise<boolean> {
  switch (key.entityType) {
    case 'merchant_avatar': {
      const [row] = await db
        .select({ id: merchants.id })
        .from(merchants)
        .where(and(eq(merchants.publicId, key.entityId), eq(merchants.avatarFileId, key.fileId)));
      return row !== undefined;
    }
    default: {
      const unhandled: never = key.entityType;
      throw new Error(`no reference rule for entity type ${String(unhandled)}`);
    }
  }
}
