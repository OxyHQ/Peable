/**
 * The nightly reconciliation of Peable's Oxy file references (ADR 0043 D6).
 *
 * Every write registers or queues its reference, but a crash between the Oxy
 * call and the database write, an old bug, or an avatar set before references
 * existed can still leave Oxy disagreeing with this database. Once a day per
 * entity type, Peable sends Oxy its whole inventory — every (file, entity) it
 * uses — and Oxy adds what is missing and removes what is stale (only
 * references created before the run began, so a write racing the inventory is
 * never undone). The first run is how avatars set before this change enter the
 * model.
 *
 * One run per entity type at a time across every task: the claim is a row in
 * `oxy_file_reconciliation_runs`, which is also the report — mode, counts,
 * error. `OXY_FILE_RECONCILIATION_MODE=dry-run` makes Oxy report what it would
 * change and change nothing; `bun run oxy-files:reconcile -- --dry-run` runs it
 * once by hand.
 */
import { getDb } from '../../db/postgres';
import { listMerchantAvatarUses } from '../../db/merchants/merchantRepository';
import {
  claimReconciliationRun,
  finishReconciliationRun,
  pruneFileEvents,
} from '../../db/oxyFiles/reconciliationRunRepository';
import { OXY_FILE_ENTITY_TYPES, type OxyFileEntityType } from '../../db/schema/valueSets';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { type OxyFilesClient, oxyFilesClient } from './client';

/** How often each task looks for a due run. The run itself is at most daily. */
const DEFAULT_INTERVAL_MS = 30 * 60_000;

/**
 * The inventory of one entity type. Exhaustive, so a new entity type without
 * one does not compile.
 */
export function inventoryFor(
  db: DatabaseOrTransaction,
  entityType: OxyFileEntityType,
): AsyncIterable<{ fileId: string; entityId: string }> {
  switch (entityType) {
    case 'merchant_avatar':
      return listMerchantAvatarUses(db);
    default: {
      const unhandled: never = entityType;
      throw new Error(`no inventory for entity type ${String(unhandled)}`);
    }
  }
}

export interface ReconciliationDeps {
  readonly files?: OxyFilesClient;
  readonly dryRun: boolean;
  /** Run even if a run succeeded within the day — the operator's run by hand. */
  readonly force?: boolean;
  readonly now?: () => Date;
}

export type EntityReconciliation =
  | { readonly entityType: OxyFileEntityType; readonly outcome: 'not_due' }
  | {
      readonly entityType: OxyFileEntityType;
      readonly outcome: 'succeeded';
      readonly dryRun: boolean;
      readonly added: number;
      readonly removed: number;
      readonly unchanged: number;
      readonly refused: number;
    }
  | { readonly entityType: OxyFileEntityType; readonly outcome: 'failed'; readonly error: string };

/** Run every DUE entity type once, and prune event rows Oxy can no longer redeliver. */
export async function runReferenceReconciliation(
  deps: ReconciliationDeps,
): Promise<EntityReconciliation[]> {
  const db = getDb();
  const files = deps.files ?? oxyFilesClient;
  const now = deps.now ?? (() => new Date());
  const results: EntityReconciliation[] = [];

  for (const entityType of OXY_FILE_ENTITY_TYPES) {
    const runId = await claimReconciliationRun(db, entityType, deps.dryRun, now(), {
      force: deps.force === true,
    });
    if (runId === null) {
      results.push({ entityType, outcome: 'not_due' });
      continue;
    }
    try {
      const result = await files.reconcile(entityType, inventoryFor(db, entityType), {
        dryRun: deps.dryRun,
      });
      const counts = {
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged,
        refused: result.refused,
      };
      await finishReconciliationRun(db, runId, { status: 'succeeded', ...counts }, now());
      results.push({ entityType, outcome: 'succeeded', dryRun: deps.dryRun, ...counts });
      console.info(
        `Peable file reference reconciliation ${entityType}${deps.dryRun ? ' (dry run)' : ''}: ` +
          `added=${counts.added} removed=${counts.removed} unchanged=${counts.unchanged} refused=${counts.refused}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finishReconciliationRun(db, runId, { status: 'failed', error: message }, now());
      results.push({ entityType, outcome: 'failed', error: message });
      process.emitWarning(`Peable file reference reconciliation ${entityType} failed: ${message}`);
    }
  }

  await pruneFileEvents(db, now());
  return results;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Look for a due run every half hour; the claim makes the run daily. */
export function startReferenceReconciliation(
  deps: ReconciliationDeps & { intervalMs?: number },
): void {
  if (timer !== null) return;
  const tick = () => {
    void runReferenceReconciliation(deps).catch((error: unknown) => {
      process.emitWarning(
        `Peable file reference reconciliation tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  timer = setInterval(tick, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopReferenceReconciliation(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
