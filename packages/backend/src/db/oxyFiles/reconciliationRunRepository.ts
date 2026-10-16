/**
 * `oxy_file_reconciliation_runs`: the lease and the report of the scheduled
 * reference reconciliation, and the pruning of `oxy_file_events`.
 */
import { and, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { oxyFileEvents, oxyFileReconciliationRuns } from '../schema';
import type { OxyFileEntityType } from '../schema/valueSets';
import type { DatabaseOrTransaction } from '../postgres';

/** A run that started this long ago and never finished belonged to a task that died. */
export const RECONCILIATION_STALE_AFTER_MS = 2 * 60 * 60_000;
/** One successful run a day. */
export const RECONCILIATION_PERIOD_MS = 23 * 60 * 60_000;
/** A failed run is retried after this long. */
export const RECONCILIATION_RETRY_AFTER_MS = 60 * 60_000;
/**
 * Oxy expires an undelivered event 30 days after creating it, so an event
 * received longer ago than this can never be redelivered and its dedupe row
 * protects nothing.
 */
export const FILE_EVENT_RETENTION_MS = 45 * 24 * 60 * 60_000;

/**
 * Claim a run of `entityType` if one is due (or `force`). `null` when it is not due, or a
 * sibling task holds it (the partial unique index on `running` refuses the
 * second claim).
 */
export async function claimReconciliationRun(
  db: DatabaseOrTransaction,
  entityType: OxyFileEntityType,
  dryRun: boolean,
  now: Date = new Date(),
  options: { readonly force?: boolean } = {},
): Promise<string | null> {
  const t = oxyFileReconciliationRuns;
  // A task that died mid-run leaves `running` behind; without this the partial
  // unique would refuse every later claim forever.
  await db
    .update(t)
    .set({ status: 'abandoned', finishedAt: now, error: 'never finished' })
    .where(
      and(
        eq(t.entityType, entityType),
        eq(t.status, 'running'),
        lt(t.startedAt, new Date(now.getTime() - RECONCILIATION_STALE_AFTER_MS)),
      ),
    );

  const [recent] = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.entityType, entityType),
        or(
          and(
            inArray(t.status, ['running', 'succeeded']),
            gt(t.startedAt, new Date(now.getTime() - RECONCILIATION_PERIOD_MS)),
          ),
          and(
            eq(t.status, 'failed'),
            gt(t.startedAt, new Date(now.getTime() - RECONCILIATION_RETRY_AFTER_MS)),
          ),
        ),
      ),
    )
    .limit(1);
  // `force` (an operator's run by hand) skips only the schedule, never the
  // one-running-at-a-time claim below.
  if (recent && !options.force) return null;

  const id = uuidv7();
  try {
    await db.insert(t).values({ id, entityType, dryRun, status: 'running', startedAt: now });
  } catch (error) {
    if (isUniqueViolation(error, 'oxy_file_reconciliation_runs_one_running_key')) return null;
    throw error;
  }
  return id;
}

export async function finishReconciliationRun(
  db: DatabaseOrTransaction,
  id: string,
  result:
    | {
        readonly status: 'succeeded';
        readonly added: number;
        readonly removed: number;
        readonly unchanged: number;
        readonly refused: number;
      }
    | { readonly status: 'failed'; readonly error: string },
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(oxyFileReconciliationRuns)
    .set(
      result.status === 'succeeded'
        ? {
            status: 'succeeded',
            finishedAt: now,
            added: result.added,
            removed: result.removed,
            unchanged: result.unchanged,
            refused: result.refused,
          }
        : { status: 'failed', finishedAt: now, error: result.error },
    )
    .where(eq(oxyFileReconciliationRuns.id, id));
}

/** Delete event dedupe rows Oxy can no longer redeliver; returns how many. */
export async function pruneFileEvents(
  db: DatabaseOrTransaction,
  now: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(oxyFileEvents)
    .where(lt(oxyFileEvents.receivedAt, new Date(now.getTime() - FILE_EVENT_RETENTION_MS)))
    .returning({ eventId: oxyFileEvents.eventId });
  return deleted.length;
}
