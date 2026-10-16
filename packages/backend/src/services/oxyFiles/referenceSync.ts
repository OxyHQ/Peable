/**
 * The loop that makes Oxy's file references agree with this database.
 *
 * `db/oxyFiles/referenceSyncRepository.ts` owns the statements; this owns the
 * schedule and the calls. Each claimed pair is decided from the database AT
 * THE MOMENT OF ACTING (`isReferenceWanted`): wanted → `references.add`, not
 * wanted → `references.remove`. Both are idempotent at Oxy (`exists`,
 * `not_found`), so a retry after a lost answer is harmless.
 *
 * There is no dead letter. A sync is convergence to a state, not a message:
 * giving up would leave a reference Oxy keeps a file alive for, or one missing
 * that Oxy needs to tell Peable a logo was taken down. It backs off to six
 * hours and keeps trying, with the last error on the row; the nightly
 * reconciliation (`referenceReconciliation.ts`) repairs the same state from
 * the other side.
 */
import { getDb } from '../../db/postgres';
import {
  type ClaimedReferenceSync,
  claimDueReferenceSyncs,
  completeReferenceSync,
  failReferenceSync,
  isReferenceWanted,
} from '../../db/oxyFiles/referenceSyncRepository';
import { type OxyFilesClient, oxyFilesClient } from './client';

/** Wait after the Nth consecutive failure; the last entry repeats. */
const BACKOFF_MS: readonly number[] = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;
/** Longer than one Oxy call can take (the SDK bounds it), short enough to recover a dead pass quickly. */
const DEFAULT_LEASE_MS = 2 * 60_000;
const LAST_ERROR_MAX = 500;

export function referenceSyncBackoffMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index] ?? DEFAULT_INTERVAL_MS;
}

export interface ReferenceSyncDeps {
  readonly files?: OxyFilesClient;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}

export interface ReferenceSyncPassResult {
  readonly claimed: number;
  readonly added: number;
  readonly removed: number;
  readonly failed: number;
}

/** Claim a batch of due pairs and bring each in line. Never throws for one pair's sake. */
export async function runReferenceSyncPass(
  deps: ReferenceSyncDeps = {},
): Promise<ReferenceSyncPassResult> {
  const db = getDb();
  const files = deps.files ?? oxyFilesClient;
  const now = deps.now ?? (() => new Date());
  const claimed = await claimDueReferenceSyncs(db, {
    limit: deps.batchSize ?? DEFAULT_BATCH_SIZE,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
    now: now(),
  });

  let added = 0;
  let removed = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      const wanted = await syncOne(files, row);
      await completeReferenceSync(db, row, now());
      if (wanted) added += 1;
      else removed += 1;
    } catch (error) {
      failed += 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(
        0,
        LAST_ERROR_MAX,
      );
      try {
        await failReferenceSync(db, row, {
          nextAttemptAt: new Date(now().getTime() + referenceSyncBackoffMs(row.attempts + 1)),
          error: message,
        });
      } catch {
        // The lease expires on its own and the pair is claimed again.
      }
      process.emitWarning(
        `Peable file reference sync failed for ${row.entityType} ${row.entityId}: ${message}`,
      );
    }
  }
  return { claimed: claimed.length, added, removed, failed };
}

/** Make Oxy agree with the database for one pair; returns whether it is wanted. */
async function syncOne(files: OxyFilesClient, row: ClaimedReferenceSync): Promise<boolean> {
  const wanted = await isReferenceWanted(getDb(), row);
  const reference = { fileId: row.fileId, entityType: row.entityType, entityId: row.entityId };
  // `not_found` is a final answer either way: on add, Oxy will not let Peable
  // reference the file (deleted, or made private) — the file event for that
  // is what changes the avatar, and retrying cannot; on remove, there was
  // nothing to remove.
  if (wanted) await files.addReferences([reference]);
  else await files.removeReferences([reference]);
  return wanted;
}

let timer: ReturnType<typeof setInterval> | null = null;
let runningWith: ReferenceSyncDeps | null = null;

export function startReferenceSync(
  options: ReferenceSyncDeps & { intervalMs?: number } = {},
): void {
  if (timer !== null) return;
  runningWith = options;
  timer = setInterval(() => {
    void runReferenceSyncPass(options).catch((error: unknown) => {
      process.emitWarning(
        `Peable file reference sync tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Like every loop here: never the reason a process or a test run stays up.
  timer.unref?.();
}

export function stopReferenceSync(): void {
  runningWith = null;
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Run a pass now. A no-op with no loop running, like `kickWebhookOutbox`: the
 * sync is already durably queued, so a missed kick costs latency, never the
 * reference — and a suite must not reach Oxy because a route kicked.
 */
export function kickReferenceSync(): void {
  if (runningWith === null) return;
  void runReferenceSyncPass(runningWith).catch((error: unknown) => {
    process.emitWarning(
      `Peable file reference sync kick failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
