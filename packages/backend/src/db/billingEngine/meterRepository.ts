import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { MeterAggregation, MeterStatus } from '@peable.to/shared-types';
import { billingMeterEvents, billingMeters } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { nowMs } from './columns';

/** Reads and writes for usage meters and their events (ADR 0018 §7). */

export interface MeterRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly displayName: string;
  readonly eventName: string;
  readonly aggregation: MeterAggregation;
  readonly customerPayloadKey: string;
  readonly valuePayloadKey: string;
  readonly status: MeterStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COLUMNS = {
  id: billingMeters.id,
  publicId: billingMeters.publicId,
  merchantId: billingMeters.merchantId,
  livemode: merchantLivemodeOf(billingMeters.merchantId),
  displayName: billingMeters.displayName,
  eventName: billingMeters.eventName,
  aggregation: billingMeters.aggregation,
  customerPayloadKey: billingMeters.customerPayloadKey,
  valuePayloadKey: billingMeters.valuePayloadKey,
  status: billingMeters.status,
  createdAt: billingMeters.createdAt,
  updatedAt: billingMeters.updatedAt,
} as const;

const toRow = (row: Record<string, unknown>) => row as unknown as MeterRow;

/** `event_name_taken` when an ACTIVE meter of the merchant already listens for it. */
export async function insertMeter(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly displayName: string;
    readonly eventName: string;
    readonly aggregation: MeterAggregation;
    readonly customerPayloadKey: string;
    readonly valuePayloadKey: string;
  },
): Promise<MeterRow | 'event_name_taken'> {
  const [row] = await db
    .insert(billingMeters)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(COLUMNS);
  return row ? toRow(row) : 'event_name_taken';
}

export async function findMeterForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<MeterRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(billingMeters)
    .where(and(eq(billingMeters.publicId, publicId), eq(billingMeters.merchantId, merchantId)));
  return row ? toRow(row) : null;
}

export async function findActiveMeterByEvent(
  db: DatabaseOrTransaction,
  merchantId: string,
  eventName: string,
): Promise<MeterRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(billingMeters)
    .where(
      and(
        eq(billingMeters.merchantId, merchantId),
        eq(billingMeters.eventName, eventName),
        eq(billingMeters.status, 'active'),
      ),
    );
  return row ? toRow(row) : null;
}

export async function findMeterById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MeterRow | null> {
  const [row] = await db.select(COLUMNS).from(billingMeters).where(eq(billingMeters.id, id));
  return row ? toRow(row) : null;
}

/** `event_name_taken` when reactivating a meter whose event another active meter now has. */
export async function updateMeter(
  db: DatabaseOrTransaction,
  id: string,
  patch: { readonly displayName?: string; readonly status?: MeterStatus },
): Promise<MeterRow | 'event_name_taken'> {
  try {
    const [row] = await db
      .update(billingMeters)
      .set({ ...patch, updatedAt: nowMs })
      .where(eq(billingMeters.id, id))
      .returning(COLUMNS);
    if (!row) throw new Error(`meter ${id} vanished`);
    return toRow(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return 'event_name_taken';
    throw error;
  }
}

export async function listMeters(
  db: DatabaseOrTransaction,
  filters: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    readonly status?: MeterStatus | undefined;
  },
): Promise<{ data: MeterRow[]; hasMore: boolean }> {
  const walk = keyset(billingMeters.id, billingMeters.createdAt, filters.page);
  const rows = await db
    .select(COLUMNS)
    .from(billingMeters)
    .where(
      and(
        eq(billingMeters.merchantId, filters.merchantId),
        filters.status ? eq(billingMeters.status, filters.status) : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

export interface MeterEventRow {
  readonly identifier: string;
  readonly eventName: string;
  readonly payload: Record<string, string>;
  readonly timestamp: Date;
  readonly createdAt: Date;
}

/**
 * Record one usage event. `duplicate` (with the stored event) when the
 * merchant already recorded this identifier — the retry is the same event and
 * is not counted twice.
 */
export async function insertMeterEvent(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly meterId: string;
    readonly customerId: string;
    readonly identifier: string;
    readonly eventName: string;
    readonly value: string;
    readonly payload: Record<string, string>;
    readonly timestamp: Date;
  },
): Promise<{ readonly event: MeterEventRow; readonly duplicate: boolean }> {
  const columns = {
    identifier: billingMeterEvents.identifier,
    eventName: billingMeterEvents.eventName,
    payload: billingMeterEvents.payload,
    timestamp: billingMeterEvents.timestamp,
    createdAt: billingMeterEvents.createdAt,
  };
  const [row] = await db
    .insert(billingMeterEvents)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(columns);
  if (row) return { event: row, duplicate: false };
  const [existing] = await db
    .select(columns)
    .from(billingMeterEvents)
    .where(
      and(
        eq(billingMeterEvents.merchantId, params.merchantId),
        eq(billingMeterEvents.identifier, params.identifier),
      ),
    );
  if (!existing) throw new Error('meter event neither inserted nor found');
  return { event: existing, duplicate: true };
}

/**
 * A customer's aggregate on a meter over `[start, end)`: the sum or count of
 * the events, or the value of the latest one (`last`). Exact: the values are
 * integer strings summed as `numeric`.
 */
export async function aggregateMeter(
  db: DatabaseOrTransaction,
  input: {
    readonly meterId: string;
    readonly customerId: string;
    readonly start: Date;
    readonly end: Date;
    readonly aggregation: MeterAggregation;
  },
): Promise<bigint> {
  const window = and(
    eq(billingMeterEvents.meterId, input.meterId),
    eq(billingMeterEvents.customerId, input.customerId),
    gte(billingMeterEvents.timestamp, input.start),
    lt(billingMeterEvents.timestamp, input.end),
  );
  if (input.aggregation === 'last') {
    const [row] = await db
      .select({ value: billingMeterEvents.value })
      .from(billingMeterEvents)
      .where(window)
      .orderBy(sql`${billingMeterEvents.timestamp} desc, ${billingMeterEvents.id} desc`)
      .limit(1);
    return row ? BigInt(row.value) : 0n;
  }
  const [row] = await db
    .select({
      value:
        input.aggregation === 'count'
          ? sql<string>`count(*)::text`
          : sql<string>`coalesce(sum(${billingMeterEvents.value}::numeric), 0)::text`,
    })
    .from(billingMeterEvents)
    .where(window);
  return BigInt(row?.value ?? '0');
}
