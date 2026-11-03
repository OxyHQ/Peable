import { and, count, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  PriceBillingScheme,
  PriceTaxBehavior,
  PriceTiersMode,
  PriceType,
  RecurringInterval,
  RecurringUsageType,
  TransformQuantityRound,
} from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { prices } from '../schema';
import type { StoredPriceTier } from '../schema/catalog';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';

/**
 * Reads and writes for `prices` (ADR 0018).
 *
 * A price's amount and shape never change once written: `insertPrice` is the
 * only statement that sets them, and `updatePrice` names only the columns a
 * price may change. The lookup key is the one piece of state two prices can
 * contend for, and both writers settle it in the transaction that moves it.
 */

const LOOKUP_KEY_CONSTRAINT = 'prices_merchant_lookup_key_key';

export interface PriceRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  /** INTERNAL product id. */
  readonly productId: string;
  /** Its public `prod_…`, what the wire calls `product`. */
  readonly productPublicId: string;
  readonly active: boolean;
  readonly currency: CurrencyCode;
  readonly unitAmount: string | null;
  readonly billingScheme: PriceBillingScheme;
  readonly tiers: StoredPriceTier[] | null;
  readonly tiersMode: PriceTiersMode | null;
  readonly transformQuantityDivideBy: number | null;
  readonly transformQuantityRound: TransformQuantityRound | null;
  readonly type: PriceType;
  readonly recurringInterval: RecurringInterval | null;
  readonly recurringIntervalCount: number | null;
  readonly recurringUsageType: RecurringUsageType | null;
  /** The meter a `metered` price bills (ADR 0018 §7), internal and public. */
  readonly meterId: string | null;
  readonly meterPublicId: string | null;
  readonly taxBehavior: PriceTaxBehavior;
  readonly lookupKey: string | null;
  readonly nickname: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

const PRICE_COLUMNS = {
  id: prices.id,
  publicId: prices.publicId,
  merchantId: prices.merchantId,
  livemode: merchantLivemodeOf(prices.merchantId),
  productId: prices.productId,
  // Raw and table-qualified: RETURNING renders column refs unqualified.
  productPublicId: sql<string>`(${sql.raw(
    'select p.public_id from products p where p.id = "prices"."product_id"',
  )})`,
  active: prices.active,
  currency: prices.currency,
  unitAmount: prices.unitAmount,
  billingScheme: prices.billingScheme,
  tiers: prices.tiers,
  tiersMode: prices.tiersMode,
  transformQuantityDivideBy: prices.transformQuantityDivideBy,
  transformQuantityRound: prices.transformQuantityRound,
  type: prices.type,
  recurringInterval: prices.recurringInterval,
  recurringIntervalCount: prices.recurringIntervalCount,
  recurringUsageType: prices.recurringUsageType,
  meterId: prices.meterId,
  meterPublicId: sql<string | null>`(${sql.raw(
    'select m.public_id from billing_meters m where m.id = "prices"."meter_id"',
  )})`,
  taxBehavior: prices.taxBehavior,
  lookupKey: prices.lookupKey,
  nickname: prices.nickname,
  metadata: prices.metadata,
  createdAt: prices.createdAt,
} as const;

/** The text columns are CHECK-constrained to these sets; the casts only restate it. */
function toPriceRow(row: {
  currency: string;
  billingScheme: string;
  tiersMode: string | null;
  transformQuantityRound: string | null;
  type: string;
  recurringInterval: string | null;
  recurringUsageType: string | null;
  taxBehavior: string;
  [key: string]: unknown;
}): PriceRow {
  return row as unknown as PriceRow;
}

/** What a new price IS — everything but who owns it and what it is called. */
export interface PriceShape {
  readonly currency: CurrencyCode;
  readonly unitAmount: string | null;
  readonly billingScheme: PriceBillingScheme;
  readonly tiers: readonly StoredPriceTier[] | null;
  readonly tiersMode: PriceTiersMode | null;
  readonly transformQuantity: { divideBy: number; round: TransformQuantityRound } | null;
  readonly recurring: {
    interval: RecurringInterval;
    intervalCount: number;
    usageType: RecurringUsageType;
    /** INTERNAL id of the meter, exactly when `usageType` is `metered` (set by the service). */
    meterId?: string | null;
    /** The `mtr_…` a request named, before the service resolved it. */
    meterPublicId?: string;
  } | null;
  readonly taxBehavior: PriceTaxBehavior;
}

export interface InsertPriceParams {
  readonly publicId: string;
  readonly merchantId: string;
  /** INTERNAL id of a product of the same merchant, locked by the caller. */
  readonly productId: string;
  readonly shape: PriceShape;
  readonly active: boolean;
  readonly lookupKey: string | null;
  /** Take `lookupKey` from the price holding it, instead of refusing. */
  readonly transferLookupKey: boolean;
  readonly nickname: string | null;
  readonly metadata: Record<string, string>;
}

export interface WrittenPrice {
  readonly row: PriceRow;
  /** The price that gave up its lookup key to this one (it emits `price.updated` too). */
  readonly displaced: PriceRow | null;
}

/**
 * Take `lookupKey` off whichever other price of the merchant holds it. Returns
 * that price as it now stands, or `null` when none held it.
 */
async function releaseLookupKey(
  tx: Transaction,
  merchantId: string,
  lookupKey: string,
  exceptId: string | null,
): Promise<PriceRow | null> {
  const [row] = await tx
    .update(prices)
    .set({ lookupKey: null, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(prices.merchantId, merchantId),
        eq(prices.lookupKey, lookupKey),
        exceptId === null ? undefined : ne(prices.id, exceptId),
      ),
    )
    .returning(PRICE_COLUMNS);
  return row ? toPriceRow(row) : null;
}

/**
 * Insert a price. `lookup_key_taken` when another price holds the key and the
 * caller did not ask to transfer it — decided by the unique index itself
 * (`ON CONFLICT DO NOTHING`), so two concurrent creates cannot both win.
 */
export async function insertPrice(
  tx: Transaction,
  params: InsertPriceParams,
): Promise<WrittenPrice | 'lookup_key_taken'> {
  const displaced =
    params.lookupKey !== null && params.transferLookupKey
      ? await releaseLookupKey(tx, params.merchantId, params.lookupKey, null)
      : null;
  const { shape } = params;
  const [row] = await tx
    .insert(prices)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      productId: params.productId,
      active: params.active,
      currency: shape.currency,
      unitAmount: shape.unitAmount,
      billingScheme: shape.billingScheme,
      tiers: shape.tiers === null ? null : [...shape.tiers],
      tiersMode: shape.tiersMode,
      transformQuantityDivideBy: shape.transformQuantity?.divideBy ?? null,
      transformQuantityRound: shape.transformQuantity?.round ?? null,
      type: shape.recurring ? 'recurring' : 'one_time',
      recurringInterval: shape.recurring?.interval ?? null,
      recurringIntervalCount: shape.recurring?.intervalCount ?? null,
      recurringUsageType: shape.recurring?.usageType ?? null,
      meterId: shape.recurring?.meterId ?? null,
      taxBehavior: shape.taxBehavior,
      lookupKey: params.lookupKey,
      nickname: params.nickname,
      metadata: params.metadata,
    })
    // The only unique a fresh insert can meet besides a 96-bit public id is
    // the lookup key.
    .onConflictDoNothing()
    .returning(PRICE_COLUMNS);
  if (!row) return 'lookup_key_taken';
  return { row: toPriceRow(row), displaced };
}

/** One price by its public `price_…`, scoped to the merchant. */
export async function findPriceForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<PriceRow | null> {
  const [row] = await db
    .select(PRICE_COLUMNS)
    .from(prices)
    .where(and(eq(prices.publicId, publicId), eq(prices.merchantId, merchantId)));
  return row ? toPriceRow(row) : null;
}

/**
 * Prices by INTERNAL id, whatever merchant — what a subscription item or an
 * invoice line already names (its own composite reference proved the merchant).
 */
export async function findPricesByRowIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<PriceRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(PRICE_COLUMNS)
    .from(prices)
    .where(inArray(prices.id, [...new Set(ids)]));
  return rows.map(toPriceRow);
}

export async function findPricesByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<PriceRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(PRICE_COLUMNS)
    .from(prices)
    .where(and(eq(prices.merchantId, merchantId), inArray(prices.publicId, [...publicIds])));
  return rows.map(toPriceRow);
}

export interface PriceListFilters {
  readonly merchantId: string;
  readonly page: KeysetPage;
  /** INTERNAL product id. */
  readonly productId?: string | undefined;
  readonly active?: boolean | undefined;
  readonly type?: PriceType | undefined;
  readonly currency?: CurrencyCode | undefined;
  readonly lookupKeys?: readonly string[] | undefined;
  readonly recurringInterval?: RecurringInterval | undefined;
  readonly recurringUsageType?: RecurringUsageType | undefined;
  /** A predicate compiled by `lib/search` over this table's fields — never caller text. */
  readonly search?: SQL | undefined;
}

function priceListWhere(filters: Omit<PriceListFilters, 'page'>): SQL | undefined {
  return and(
    eq(prices.merchantId, filters.merchantId),
    filters.productId === undefined ? undefined : eq(prices.productId, filters.productId),
    filters.active === undefined ? undefined : eq(prices.active, filters.active),
    filters.type === undefined ? undefined : eq(prices.type, filters.type),
    filters.currency === undefined ? undefined : eq(prices.currency, filters.currency),
    filters.lookupKeys === undefined
      ? undefined
      : inArray(prices.lookupKey, [...filters.lookupKeys]),
    filters.recurringInterval === undefined
      ? undefined
      : eq(prices.recurringInterval, filters.recurringInterval),
    filters.recurringUsageType === undefined
      ? undefined
      : eq(prices.recurringUsageType, filters.recurringUsageType),
    filters.search,
  );
}

/** One page of a merchant's prices, newest first. */
export async function listPricesForMerchant(
  db: DatabaseOrTransaction,
  filters: PriceListFilters,
): Promise<{ data: PriceRow[]; hasMore: boolean }> {
  const walk = keyset(prices.id, prices.createdAt, filters.page);
  const rows = await db
    .select(PRICE_COLUMNS)
    .from(prices)
    .where(and(priceListWhere(filters), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toPriceRow));
}

/** How many prices {@link listPricesForMerchant} would walk — a search's `total_count`. */
export async function countPricesForMerchant(
  db: DatabaseOrTransaction,
  filters: Omit<PriceListFilters, 'page'>,
): Promise<number> {
  const [row] = await db.select({ n: count() }).from(prices).where(priceListWhere(filters));
  return row?.n ?? 0;
}

/** Lock one price row for the rest of the transaction. */
export async function lockPrice(tx: Transaction, priceId: string): Promise<PriceRow | null> {
  const [row] = await tx
    .select(PRICE_COLUMNS)
    .from(prices)
    .where(eq(prices.id, priceId))
    .for('update', { of: prices });
  return row ? toPriceRow(row) : null;
}

export interface PricePatch {
  readonly active?: boolean | undefined;
  /** `null` clears. */
  readonly nickname?: string | null | undefined;
  readonly metadata?: MetadataPatch | undefined;
  /** `null` clears. */
  readonly lookupKey?: string | null | undefined;
  readonly transferLookupKey?: boolean | undefined;
  /** The caller proved the stored one is `unspecified` (or equal). */
  readonly taxBehavior?: PriceTaxBehavior | undefined;
}

/**
 * Apply an update to a price the caller has LOCKED (`lockPrice`). The lookup
 * key is written under a savepoint: a concurrent holder of the same key makes
 * the unique index refuse it, and that refusal must not abort the caller's
 * transaction.
 */
export async function updatePrice(
  tx: Transaction,
  locked: PriceRow,
  patch: PricePatch,
): Promise<WrittenPrice | 'limit_exceeded' | 'lookup_key_taken'> {
  const values: Partial<typeof prices.$inferInsert> = {};
  if (patch.active !== undefined) values.active = patch.active;
  if (patch.nickname !== undefined) values.nickname = patch.nickname;
  if (patch.taxBehavior !== undefined) values.taxBehavior = patch.taxBehavior;
  if (patch.lookupKey !== undefined) values.lookupKey = patch.lookupKey;
  const merged = patch.metadata ? mergedMetadata(prices.metadata, patch.metadata) : null;
  const scope = eq(prices.id, locked.id);
  try {
    return await tx.transaction(async (savepoint) => {
      const displaced =
        patch.lookupKey && patch.transferLookupKey
          ? await releaseLookupKey(savepoint, locked.merchantId, patch.lookupKey, locked.id)
          : null;
      const [row] = await savepoint
        .update(prices)
        .set({
          ...values,
          ...(merged ? { metadata: merged } : {}),
          updatedAt: sql`date_trunc('milliseconds', now())`,
        })
        .where(merged ? and(scope, metadataWithinLimit(merged)) : scope)
        .returning(PRICE_COLUMNS);
      if (!row) return 'limit_exceeded' as const;
      return { row: toPriceRow(row), displaced };
    });
  } catch (error) {
    if (isUniqueViolation(error, LOOKUP_KEY_CONSTRAINT)) return 'lookup_key_taken';
    throw error;
  }
}

/** The merchant's prices among these INTERNAL ids (any order). */
export async function findPricesByIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  ids: readonly string[],
): Promise<PriceRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(PRICE_COLUMNS)
    .from(prices)
    .where(and(eq(prices.merchantId, merchantId), inArray(prices.id, [...ids])));
  return rows.map(toPriceRow);
}
