import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import { createDatabase } from '@oxy.so/db';
import type postgres from 'postgres';
import { main as runMigrateEntrypoint } from './migrate';
import * as schema from './schema';
import { setDatabaseForTesting, type Database } from './postgres';

/**
 * A throwaway, fully migrated database for one test FILE.
 *
 * Per file rather than per run: the whole schema is one migration, so creating
 * a database costs a few hundred milliseconds, and the alternative — a shared
 * database across files — buys that back by making every suite's rows visible
 * to every other suite. The contention that produces (`too many clients
 * already`, and rows one file deleted that another was counting) reads exactly
 * like a regression in the code under test, which is the expensive failure.
 *
 * The migration runs through `db/migrate.ts`'s own `main`, not a second
 * composition of `runMigrations`. A harness that assembles its own migration
 * call can drift from the entrypoint production uses, and then the suite is
 * testing a schema no deployment ever gets.
 */

/**
 * Where throwaway databases are created. No default: a guessed local server
 * would create databases somewhere nobody intended, and an absent value must
 * be visible rather than silently routed.
 */
export const TEST_ADMIN_URL = process.env.TEST_DATABASE_URL;

/** Whether the real-database suites can run at all in this environment. */
export const POSTGRES_TESTS_ENABLED = Boolean(TEST_ADMIN_URL);

export interface SuiteDatabase {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly databaseUrl: string;
}

/**
 * Create the database, apply the migrations, and point the module-level handle
 * in `db/postgres.ts` at it so repositories that call `getDb()` themselves work
 * unchanged.
 */
export async function createSuiteDatabase(): Promise<SuiteDatabase> {
  if (!TEST_ADMIN_URL) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the local server with ' +
        '`docker compose -f docker-compose.postgres.yml up -d` and export ' +
        'TEST_DATABASE_URL=postgres://peable:peable@localhost:5439/postgres'
    );
  }

  const databaseUrl = await createTestDatabase({
    adminUrl: TEST_ADMIN_URL,
    migrate: async (url) => {
      // `all` is correct for a fresh database: `pre` and `post` describe the
      // two sides of a rolling deploy, and a database created seconds ago has
      // no previous image to be compatible with.
      const name = new URL(url).pathname.slice(1);
      await runMigrateEntrypoint([`--target-database=${name}`, '--phase=all'], {
        ...process.env,
        DATABASE_URL: url,
      });
    },
  });

  const { db, client } = createDatabase({ databaseUrl, schema, client: { max: 4 } });
  setDatabaseForTesting(db, client);
  return { db, client, databaseUrl };
}

/** Close the pool and drop the database. Safe to call after a failed creation. */
export async function dropSuiteDatabase(suite: SuiteDatabase | undefined): Promise<void> {
  setDatabaseForTesting(undefined);
  if (!suite) return;
  await suite.client.end({ timeout: 5 });
  await dropTestDatabase(suite.databaseUrl);
}
