import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { TestClockStatus } from '@peable.to/shared-types';
import { testClocks } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { nowMs } from './columns';

/** Reads and writes for `test_clocks` (ADR 0018 §3). */

export interface TestClockRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly name: string | null;
  readonly frozenTime: Date;
  readonly status: TestClockStatus;
  readonly deletesAfter: Date;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

const COLUMNS = {
  id: testClocks.id,
  publicId: testClocks.publicId,
  merchantId: testClocks.merchantId,
  name: testClocks.name,
  frozenTime: testClocks.frozenTime,
  status: testClocks.status,
  deletesAfter: testClocks.deletesAfter,
  deletedAt: testClocks.deletedAt,
  createdAt: testClocks.createdAt,
} as const;

const toRow = (row: { status: string; [key: string]: unknown }) => row as unknown as TestClockRow;

export async function insertTestClock(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly name: string | null;
    readonly frozenTime: Date;
    readonly deletesAfter: Date;
  },
): Promise<TestClockRow> {
  const [row] = await db
    .insert(testClocks)
    .values({ id: uuidv7(), ...params })
    .returning(COLUMNS);
  if (!row) throw new Error('test clock insert returned no row');
  return toRow(row);
}

/** A clock that is not deleted, by `clock_…`, scoped to the merchant. */
export async function findLiveTestClockForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<TestClockRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(testClocks)
    .where(
      and(
        eq(testClocks.publicId, publicId),
        eq(testClocks.merchantId, merchantId),
        isNull(testClocks.deletedAt),
      ),
    );
  return row ? toRow(row) : null;
}

export async function findTestClockById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<TestClockRow | null> {
  const [row] = await db.select(COLUMNS).from(testClocks).where(eq(testClocks.id, id));
  return row ? toRow(row) : null;
}

export async function lockTestClock(tx: Transaction, id: string): Promise<TestClockRow | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(testClocks)
    .where(eq(testClocks.id, id))
    .for('update');
  return row ? toRow(row) : null;
}

export async function updateTestClock(
  db: DatabaseOrTransaction,
  id: string,
  patch: {
    readonly frozenTime?: Date;
    readonly status?: TestClockStatus;
    readonly deletedAt?: Date;
  },
): Promise<TestClockRow> {
  const [row] = await db
    .update(testClocks)
    .set({ ...patch, updatedAt: nowMs })
    .where(eq(testClocks.id, id))
    .returning(COLUMNS);
  if (!row) throw new Error(`test clock ${id} vanished`);
  return toRow(row);
}

export async function listTestClocksForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  page: KeysetPage,
): Promise<{ data: TestClockRow[]; hasMore: boolean }> {
  const walk = keyset(testClocks.id, testClocks.createdAt, page);
  const rows = await db
    .select(COLUMNS)
    .from(testClocks)
    .where(and(eq(testClocks.merchantId, merchantId), isNull(testClocks.deletedAt), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}
