/**
 * Run the Oxy file-reference reconciliation once, by hand:
 *
 *     bun run oxy-files:reconcile -- --dry-run   # report only
 *     bun run oxy-files:reconcile                # apply
 *
 * Runs every entity type now, whatever the schedule says, but still takes the
 * one-at-a-time claim, so it cannot overlap a scheduled run on a live task.
 * Needs `DATABASE_URL` and a way to authenticate as Peable (the service pair
 * or a task's workload identity) — run it as a one-shot ECS task of the
 * release image, like a migration.
 */
import { connectPostgres, disconnectPostgres } from '../../db/postgres';
import { canUseOxyServiceLane } from '../../oxy';
import { runReferenceReconciliation } from './referenceReconciliation';

async function main(): Promise<void> {
  if (!canUseOxyServiceLane()) {
    throw new Error(
      'this process cannot authenticate to Oxy as Peable (no service pair, no workload identity)',
    );
  }
  const dryRun = process.argv.includes('--dry-run');
  await connectPostgres();
  try {
    const results = await runReferenceReconciliation({ dryRun, force: true });
    console.info(JSON.stringify(results, null, 2));
    if (results.some((result) => result.outcome === 'failed')) process.exitCode = 1;
  } finally {
    await disconnectPostgres();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
