import { createDatabase, type OxyDatabase } from '@oxy.so/db';
import type postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';

/** The drizzle handle over this service's own schema. */
export type Database = OxyDatabase<typeof schema>;

/** The handle drizzle hands a `db.transaction(cb)` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What every repository function takes as its first argument.
 *
 * A repository that declares `Database` cannot be called inside a transaction,
 * and one that reaches for the module-level handle itself cannot be called
 * inside a transaction EITHER — it would silently open a second connection and
 * commit outside the caller's block. Taking the union is what keeps both
 * possible, and it is the reason the type is exported from here rather than
 * being spelled out per module.
 */
export type DatabaseOrTransaction = Database | Transaction;

/** Pool ceiling. One task, several concurrent requests; RDS is shared across apps. */
const MAX_POOL_CONNECTIONS = 10;
/** Seconds an idle pooled connection is kept before being closed. */
const IDLE_TIMEOUT_SECONDS = 30;
/** Seconds to wait for in-flight queries on shutdown before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

let database: Database | undefined;
let client: postgres.Sql | undefined;

/**
 * Thrown when something asks for the database before it has been opened, or on
 * a deployment where `DATABASE_URL` is not set.
 *
 * A named error rather than a `!`: "the pool is not open" and "this deployment
 * has no database configured" are both operator-actionable, and neither should
 * surface as `Cannot read properties of undefined`.
 */
export class PostgresNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresNotConnectedError';
  }
}

/**
 * Open the pool and prove it works with one round trip.
 *
 * The round trip is the point: without it a bad `DATABASE_URL` surfaces on the
 * first request that happens to need the database, minutes later, as that
 * request's 500 rather than as a boot failure.
 *
 * NOT called at boot yet. This foundation change lands the schema, the migrator
 * and the reservation repositories; no route reads Postgres, so making the
 * variable mandatory now would crash-loop a task definition that does not carry
 * it yet. The change that moves the first route calls this from `server.ts` and
 * makes `DATABASE_URL` required in `config.ts` at the same time.
 */
export async function connectPostgres(databaseUrl = config.databaseUrl): Promise<Database> {
  if (database) return database;
  if (!databaseUrl) {
    throw new PostgresNotConnectedError('DATABASE_URL is not set');
  }

  const created = createDatabase({
    databaseUrl,
    schema,
    client: {
      max: MAX_POOL_CONNECTIONS,
      idle_timeout: IDLE_TIMEOUT_SECONDS,
      // postgres.js' `onnotice` default prints every NOTICE to stderr, which
      // during a migration run is hundreds of `relation already exists, skipping`
      // lines. Migration output belongs to the migrator's own logger.
      onnotice: () => {},
    },
  });

  await created.client`select 1`;

  database = created.db;
  client = created.client;
  return database;
}

/** The open handle, or a named throw. Never `undefined`, never a `!`. */
export function getDb(): Database {
  if (!database) {
    throw new PostgresNotConnectedError('connectPostgres() has not been called');
  }
  return database;
}

/**
 * Whether the database answers, right now, with one round trip.
 *
 * Separate from `connectPostgres`'s own probe because it answers a different
 * question at a different time: that one is "can this process boot", asked
 * once; this is "can this task serve a request", asked by `/ready` for as long
 * as the task lives. A pool opened at boot can stop answering — a failover, a
 * security-group change, RDS restarting — and a task that is still LISTENING
 * through that is exactly the task a deploy gate must not promote.
 *
 * Never throws: the caller is an HTTP handler whose status code is the answer.
 */
export async function isPostgresReady(): Promise<boolean> {
  const open = client;
  if (!open) return false;
  try {
    await open`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Close the pool. Safe to call when it was never opened. */
export async function disconnectPostgres(): Promise<void> {
  const open = client;
  database = undefined;
  client = undefined;
  if (open) {
    await open.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
}

/**
 * Point the module-level handle at an already-built database — the throwaway
 * one a test suite created.
 *
 * Exists so a test can exercise a repository that calls `getDb()` itself
 * without every such repository growing an injectable parameter that only tests
 * would ever pass.
 */
export function setDatabaseForTesting(db: Database | undefined, sql?: postgres.Sql): void {
  database = db;
  client = sql;
}
