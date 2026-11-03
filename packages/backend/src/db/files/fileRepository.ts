/**
 * Reads and writes for `files` — Orbit Files over Oxy Files.
 *
 * `insertFile` is the one writer of a row and queues the row's Oxy reference
 * (`file`, entity = `file_…`) in its own transaction; the file-event writers
 * below are the only other statements that change a row, and only its
 * standing (`withheld`, `removed_at`), never its bytes or owner.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FilePurpose, FileStatus, FileType } from '@peable.to/shared-types';
import { files } from '../schema';
import type { FileRemovalEventType, FileWithheldReason } from '../schema/valueSets';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { enqueueReferenceSync } from '../oxyFiles/referenceSyncRepository';

export interface FileRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly purpose: FilePurpose;
  readonly oxyFileId: string;
  readonly filename: string | null;
  readonly size: number;
  readonly type: FileType;
  readonly withheld: FileWithheldReason | null;
  readonly removedAt: Date | null;
  readonly removedBy: FileRemovalEventType | null;
  readonly createdAt: Date;
}

const FILE_COLUMNS = {
  id: files.id,
  publicId: files.publicId,
  merchantId: files.merchantId,
  livemode: merchantLivemodeOf(files.merchantId),
  purpose: files.purpose,
  oxyFileId: files.oxyFileId,
  filename: files.filename,
  size: files.size,
  type: files.type,
  withheld: files.withheld,
  removedAt: files.removedAt,
  removedBy: files.removedBy,
  createdAt: files.createdAt,
} as const;

/** The CHECKs keep every narrowed column in its closed set. */
function toRow(row: Record<string, unknown>): FileRow {
  return row as unknown as FileRow;
}

/** What a File's standing reads as on the wire. */
export function fileStatusOf(row: Pick<FileRow, 'withheld' | 'removedAt'>): FileStatus {
  if (row.removedAt !== null) return 'removed';
  return row.withheld === null ? 'available' : 'withheld';
}

export interface InsertFileParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly purpose: FilePurpose;
  readonly oxyFileId: string;
  readonly filename: string | null;
  readonly size: number;
  readonly type: FileType;
}

/**
 * Record a File and queue its Oxy reference, in ONE transaction.
 *
 * The reference was already registered at Oxy by the call that stored or
 * accepted the bytes; the queued sync is what makes that durable from this
 * side — if this insert is the thing that fails, the caller queues the same
 * pair outside it and the sync, finding no row, removes the reference.
 */
export async function insertFile(
  db: DatabaseOrTransaction,
  params: InsertFileParams,
): Promise<FileRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(files)
      .values({
        publicId: params.publicId,
        merchantId: params.merchantId,
        purpose: params.purpose,
        oxyFileId: params.oxyFileId,
        filename: params.filename,
        size: params.size,
        type: params.type,
      })
      .returning(FILE_COLUMNS);
    if (!row) throw new Error(`file ${params.publicId} could not be read back after insert`);
    await enqueueReferenceSync(tx, {
      fileId: params.oxyFileId,
      entityType: 'file',
      entityId: params.publicId,
    });
    return toRow(row);
  });
}

/** By `file_…`, SCOPED TO THE MERCHANT: another merchant's file is "not found". */
export async function findFileByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<FileRow | null> {
  const [row] = await db
    .select(FILE_COLUMNS)
    .from(files)
    .where(and(eq(files.merchantId, merchantId), eq(files.publicId, publicId)))
    .limit(1);
  return row ? toRow(row) : null;
}

/** Several Files of one merchant by INTERNAL id (what references hold). */
export async function findFilesByIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  ids: readonly string[],
): Promise<FileRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(FILE_COLUMNS)
    .from(files)
    .where(and(eq(files.merchantId, merchantId), inArray(files.id, [...ids])));
  return rows.map(toRow);
}

/** One page of a merchant's Files, newest first (`db/keyset.ts`). */
export async function listFilesForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly purpose?: FilePurpose | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: FileRow[]; hasMore: boolean }> {
  const walk = keyset(files.id, files.createdAt, params.page);
  const rows = await db
    .select(FILE_COLUMNS)
    .from(files)
    .where(
      and(
        eq(files.merchantId, params.merchantId),
        params.purpose === undefined ? undefined : eq(files.purpose, params.purpose),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/** Whether a live File holds `oxyFileId` as `publicId` — the `file` reference rule. */
export async function isFileReferenceWanted(
  db: DatabaseOrTransaction,
  oxyFileId: string,
  publicId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(eq(files.publicId, publicId), eq(files.oxyFileId, oxyFileId), isNull(files.removedAt)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Every (Oxy file, `file_…`) pair a live File holds, a page at a time by
 * primary key — the `file` inventory of the nightly reconciliation.
 */
export async function* listFileUses(
  db: DatabaseOrTransaction,
  pageSize = 500,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let after: string | null = null;
  for (;;) {
    const page: { id: string; publicId: string; oxyFileId: string }[] = await db
      .select({ id: files.id, publicId: files.publicId, oxyFileId: files.oxyFileId })
      .from(files)
      .where(and(isNull(files.removedAt), after === null ? undefined : sql`${files.id} > ${after}`))
      .orderBy(files.id)
      .limit(pageSize);
    for (const row of page) yield { fileId: row.oxyFileId, entityId: row.publicId };
    const last = page.at(-1);
    if (!last || page.length < pageSize) return;
    after = last.id;
  }
}

/** One Oxy file event, as the File writers need it. */
export interface FileEventFacts {
  readonly fileId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
}

/** What one event did to one File. */
export interface FileEventChange {
  readonly fileId: string;
  readonly action: 'removed' | 'withheld' | 'released';
}

/**
 * The Oxy file is gone for good (deleted, taken down, lost): every live File
 * over it is REMOVED, and its reference queued for release — in the event's
 * transaction. Removal is final, so event ordering does not apply: a removal
 * that arrives before an older `restored` still removes.
 */
export async function removeFilesForOxyFile(
  tx: DatabaseOrTransaction,
  event: FileEventFacts & { readonly eventType: FileRemovalEventType },
): Promise<FileEventChange[]> {
  const removed = await tx
    .update(files)
    .set({
      removedAt: event.occurredAt,
      removedBy: event.eventType,
      withheld: null,
      oxyFileEventAt: event.occurredAt,
    })
    .where(and(eq(files.oxyFileId, event.fileId), isNull(files.removedAt)))
    .returning({ id: files.id, publicId: files.publicId });
  for (const row of removed) {
    await enqueueReferenceSync(tx, {
      fileId: event.fileId,
      entityType: 'file',
      entityId: row.publicId,
    });
  }
  return removed.map((row) => ({ fileId: row.id, action: 'removed' as const }));
}

/**
 * The Oxy file still exists and its owner changed whether it is served
 * (trash, restore, visibility). Applies `withheld` to every live File over it
 * whose last applied event is OLDER than this one.
 */
export async function setFilesWithheldForOxyFile(
  tx: DatabaseOrTransaction,
  event: FileEventFacts,
  withheld: FileWithheldReason | null,
): Promise<FileEventChange[]> {
  const candidates = await tx
    .select({ id: files.id, withheld: files.withheld })
    .from(files)
    .where(
      and(
        eq(files.oxyFileId, event.fileId),
        isNull(files.removedAt),
        lt(files.oxyFileEventAt, event.occurredAt),
      ),
    )
    .for('update');
  const changes: FileEventChange[] = [];
  for (const candidate of candidates) {
    await tx
      .update(files)
      .set({ withheld, oxyFileEventAt: event.occurredAt })
      .where(eq(files.id, candidate.id));
    if (candidate.withheld === withheld) continue;
    changes.push({ fileId: candidate.id, action: withheld === null ? 'released' : 'withheld' });
  }
  return changes;
}
