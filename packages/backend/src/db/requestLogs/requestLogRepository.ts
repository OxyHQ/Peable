import { and, between, eq, gt, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import {
  REQUEST_LOG_RETENTION_DAYS,
  type RequestLogMethod,
  type RequestLogStatusFilter,
} from '@peable.to/shared-types';
import { apiRequestLogs } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

/**
 * Reads and writes for `api_request_logs`. The one writer is
 * {@link insertRequestLog}, reached only from `lib/requestLog.ts`, which also
 * signals the live tail on the same transaction.
 */

export interface RequestLogRow {
  readonly id: string;
  readonly requestId: string;
  readonly merchantId: string;
  /** The merchant's mode, read in the row's own statement (ADR 0017). */
  readonly livemode: boolean;
  readonly method: RequestLogMethod;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

const REQUEST_LOG_COLUMNS = {
  livemode: merchantLivemodeOf(apiRequestLogs.merchantId),
  id: apiRequestLogs.id,
  requestId: apiRequestLogs.requestId,
  merchantId: apiRequestLogs.merchantId,
  method: apiRequestLogs.method,
  path: apiRequestLogs.path,
  status: apiRequestLogs.status,
  durationMs: apiRequestLogs.durationMs,
  idempotencyKey: apiRequestLogs.idempotencyKey,
  createdAt: apiRequestLogs.createdAt,
} as const;

/** Inside the API's retention horizon. */
function retained(): SQL {
  return gt(
    apiRequestLogs.createdAt,
    sql`now() - make_interval(days => ${REQUEST_LOG_RETENTION_DAYS})`,
  );
}

export interface InsertRequestLogParams {
  readonly requestId: string;
  readonly merchantId: string;
  readonly method: RequestLogMethod;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly idempotencyKey: string | null;
}

/**
 * Record one answered request. Returns the row's id, or `null` when a row for
 * that `Request-Id` already exists — never an error: the row already says what
 * the request was.
 */
export async function insertRequestLog(
  db: DatabaseOrTransaction,
  params: InsertRequestLogParams,
): Promise<string | null> {
  const [row] = await db
    .insert(apiRequestLogs)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning({ id: apiRequestLogs.id });
  return row?.id ?? null;
}

/** One log by its PRIMARY key, scoped to the merchant and the retention horizon. */
export async function findRequestLogByIdForMerchant(
  db: DatabaseOrTransaction,
  id: string,
  merchantId: string,
): Promise<RequestLogRow | null> {
  const [row] = await db
    .select(REQUEST_LOG_COLUMNS)
    .from(apiRequestLogs)
    .where(and(eq(apiRequestLogs.id, id), eq(apiRequestLogs.merchantId, merchantId), retained()));
  return (row as RequestLogRow | undefined) ?? null;
}

/** One log by its `Request-Id` (`req_…`), scoped to the merchant and the retention horizon. */
export async function findRequestLogForMerchant(
  db: DatabaseOrTransaction,
  requestId: string,
  merchantId: string,
): Promise<RequestLogRow | null> {
  const [row] = await db
    .select(REQUEST_LOG_COLUMNS)
    .from(apiRequestLogs)
    .where(
      and(
        eq(apiRequestLogs.requestId, requestId),
        eq(apiRequestLogs.merchantId, merchantId),
        retained(),
      ),
    );
  return (row as RequestLogRow | undefined) ?? null;
}

export interface ListRequestLogsParams {
  readonly merchantId: string;
  readonly page: KeysetPage;
  readonly status?: RequestLogStatusFilter | undefined;
  readonly method?: RequestLogMethod | undefined;
}

/** The status predicate: one code, or a class (`4xx` is 400–499). */
function statusPredicate(status: RequestLogStatusFilter): SQL {
  if (typeof status === 'number') return eq(apiRequestLogs.status, status);
  const floor = Number(status[0]) * 100;
  return between(apiRequestLogs.status, floor, floor + 99);
}

/** Whether a row passes the same filters — the live tail's in-memory twin of the SQL. */
export function requestLogMatches(
  row: Pick<RequestLogRow, 'status' | 'method'>,
  filters: Pick<ListRequestLogsParams, 'status' | 'method'>,
): boolean {
  if (filters.method !== undefined && row.method !== filters.method) return false;
  if (filters.status === undefined) return true;
  if (typeof filters.status === 'number') return row.status === filters.status;
  const floor = Number(filters.status[0]) * 100;
  return row.status >= floor && row.status <= floor + 99;
}

/** One page of a merchant's request logs, newest first, inside the retention horizon. */
export async function listRequestLogsForMerchant(
  db: DatabaseOrTransaction,
  params: ListRequestLogsParams,
): Promise<{ data: RequestLogRow[]; hasMore: boolean }> {
  const walk = keyset(apiRequestLogs.id, apiRequestLogs.createdAt, params.page);
  const conditions: (SQL | undefined)[] = [
    eq(apiRequestLogs.merchantId, params.merchantId),
    retained(),
    walk.where,
    params.status === undefined ? undefined : statusPredicate(params.status),
    params.method === undefined ? undefined : eq(apiRequestLogs.method, params.method),
  ];
  const rows = await db
    .select(REQUEST_LOG_COLUMNS)
    .from(apiRequestLogs)
    .where(and(...conditions))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows as RequestLogRow[]);
}
