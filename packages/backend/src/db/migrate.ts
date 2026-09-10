import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_RUNS,
  type MigrationRun,
  type RequiredExtension,
  readTargetDatabase,
  runMigrations,
} from '@oxy.so/db/migrate';

/**
 * The ONLY thing that applies migrations to an Peable database.
 *
 * Run locally as `bun run db:migrate -- --target-database=<name> --phase=<run>`
 * and in production as the compiled `dist/db/migrate.js`, launched as a
 * one-shot ECS task before the service rolls. `drizzle-kit migrate` is NOT an
 * alternative: it is a devDependency and never reaches the production image.
 *
 * `--target-database` is mandatory here even though `@oxy.so/db` leaves it
 * optional. A migrator pointed at the wrong database does not fail — it finds
 * an empty ledger, applies the whole journal, prints a success line and exits
 * 0, over a database nobody meant to touch.
 */

/**
 * Extensions this schema depends on: NONE.
 *
 * Measured rather than assumed — no geography column, no text search, and ids
 * are generated in the application. Stated as an explicit empty list because
 * `runMigrations` requires the decision, and because an empty list is a fact
 * about this schema rather than an oversight.
 *
 * An extension can NOT be added here later by writing `CREATE EXTENSION IF NOT
 * EXISTS` into a migration: that statement short-circuits on the
 * already-exists check before the privilege check, so it is a silent no-op
 * where the extension is installed and a hard failure where it is not.
 * Extensions are a database prerequisite, installed once by a privileged role.
 */
const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [];

/**
 * Where the generated SQL lives. Exported so the deploy-workflow gate can check
 * the path the workflow greps against the path this entrypoint actually reads —
 * two copies of a directory name, one of which is in YAML where nothing checks
 * it.
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function readRun(argv: readonly string[]): MigrationRun {
  const flag = argv.find((argument) => argument.startsWith('--phase='));
  const value = flag?.slice('--phase='.length);
  if (value === undefined) {
    throw new Error(
      `Refusing to migrate: no --phase=<${MIGRATION_RUNS.join('|')}>. ` +
        '`pre` applies additive migrations while the previous image is still serving; ' +
        '`post` applies drops, renames and narrowings once the new image is live; ' +
        '`all` applies the whole chain in one run and is for a from-zero genesis or a ' +
        'cutover batch, never a normal release.'
    );
  }
  if (!MIGRATION_RUNS.includes(value as MigrationRun)) {
    throw new Error(
      `Refusing to migrate: --phase=${JSON.stringify(value)} is not one of ${MIGRATION_RUNS.join(', ')}.`
    );
  }
  return value as MigrationRun;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Refusing to migrate: DATABASE_URL is not set.');
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: MIGRATIONS_FOLDER,
    extensions: REQUIRED_EXTENSIONS,
    run: readRun(argv),
    expectedDatabase: readTargetDatabase(argv),
    dryRun: argv.includes('--dry-run'),
    logger: {
      info: (message) => {
        process.stdout.write(`${message}\n`);
      },
      debug: (message) => {
        process.stdout.write(`${message}\n`);
      },
    },
  });
}

// `import.meta.main` is true only when this file is the entrypoint, so
// importing it from a test harness does not run a migration.
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
