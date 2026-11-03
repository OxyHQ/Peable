import { and, asc, count, eq, gte, inArray, isNull, lt, lte, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  CollectionMethod,
  CurrencyCode,
  PauseCollectionBehavior,
  SubscriptionCancellationReason,
  SubscriptionStatus,
  TrialEndBehavior,
} from '@peable.to/shared-types';
import { subscriptionItems, subscriptions, testClocks } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type CreatedRange, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { nowMs, publicIdOf, requiredPublicIdOf } from './columns';

/**
 * Reads and writes for `subscriptions` and `subscription_items` (ADR 0018).
 * `status` is written ONLY by {@link setSubscriptionStatus}, a compare-and-swap
 * on the status the caller read — `transitionSubscription` is its one caller.
 */

export interface SubscriptionRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly testClockId: string | null;
  readonly testClockPublicId: string | null;
  readonly status: SubscriptionStatus;
  readonly currency: CurrencyCode;
  readonly collectionMethod: CollectionMethod;
  readonly daysUntilDue: number | null;
  readonly defaultPaymentMethodId: string | null;
  readonly defaultPaymentMethodPublicId: string | null;
  readonly description: string | null;
  readonly billingCycleAnchor: Date;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly startDate: Date;
  readonly trialStart: Date | null;
  readonly trialEnd: Date | null;
  readonly trialWillEndSentAt: Date | null;
  readonly upcomingNoticeSentAt: Date | null;
  readonly trialEndBehavior: TrialEndBehavior;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelAt: Date | null;
  readonly canceledAt: Date | null;
  readonly endedAt: Date | null;
  readonly cancellationReason: SubscriptionCancellationReason | null;
  readonly cancellationComment: string | null;
  readonly pauseBehavior: PauseCollectionBehavior | null;
  readonly pauseResumesAt: Date | null;
  readonly automaticTax: boolean;
  readonly discountCouponId: string | null;
  readonly discountCouponPublicId: string | null;
  readonly discountPromotionCodeId: string | null;
  readonly discountPromotionCodePublicId: string | null;
  readonly discountStart: Date | null;
  readonly discountEnd: Date | null;
  readonly latestInvoiceId: string | null;
  readonly latestInvoicePublicId: string | null;
  readonly metadata: Record<string, string>;
  readonly nextActionAt: Date | null;
  readonly createdAt: Date;
}

const S = 'subscriptions';
const COLUMNS = {
  id: subscriptions.id,
  publicId: subscriptions.publicId,
  merchantId: subscriptions.merchantId,
  livemode: merchantLivemodeOf(subscriptions.merchantId),
  customerId: subscriptions.customerId,
  customerPublicId: requiredPublicIdOf('customers', S, 'customer_id'),
  testClockId: subscriptions.testClockId,
  testClockPublicId: publicIdOf('test_clocks', S, 'test_clock_id'),
  status: subscriptions.status,
  currency: subscriptions.currency,
  collectionMethod: subscriptions.collectionMethod,
  daysUntilDue: subscriptions.daysUntilDue,
  defaultPaymentMethodId: subscriptions.defaultPaymentMethodId,
  defaultPaymentMethodPublicId: publicIdOf('payment_methods', S, 'default_payment_method_id'),
  description: subscriptions.description,
  billingCycleAnchor: subscriptions.billingCycleAnchor,
  currentPeriodStart: subscriptions.currentPeriodStart,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  startDate: subscriptions.startDate,
  trialStart: subscriptions.trialStart,
  trialEnd: subscriptions.trialEnd,
  trialWillEndSentAt: subscriptions.trialWillEndSentAt,
  upcomingNoticeSentAt: subscriptions.upcomingNoticeSentAt,
  trialEndBehavior: subscriptions.trialEndBehavior,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  cancelAt: subscriptions.cancelAt,
  canceledAt: subscriptions.canceledAt,
  endedAt: subscriptions.endedAt,
  cancellationReason: subscriptions.cancellationReason,
  cancellationComment: subscriptions.cancellationComment,
  pauseBehavior: subscriptions.pauseBehavior,
  pauseResumesAt: subscriptions.pauseResumesAt,
  automaticTax: subscriptions.automaticTax,
  discountCouponId: subscriptions.discountCouponId,
  discountCouponPublicId: publicIdOf('coupons', S, 'discount_coupon_id'),
  discountPromotionCodeId: subscriptions.discountPromotionCodeId,
  discountPromotionCodePublicId: publicIdOf('promotion_codes', S, 'discount_promotion_code_id'),
  discountStart: subscriptions.discountStart,
  discountEnd: subscriptions.discountEnd,
  latestInvoiceId: subscriptions.latestInvoiceId,
  latestInvoicePublicId: publicIdOf('invoices', S, 'latest_invoice_id'),
  metadata: subscriptions.metadata,
  nextActionAt: subscriptions.nextActionAt,
  createdAt: subscriptions.createdAt,
} as const;

const toRow = (row: Record<string, unknown>) => row as unknown as SubscriptionRow;

export interface InsertSubscriptionParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly testClockId: string | null;
  readonly status: SubscriptionStatus;
  readonly currency: CurrencyCode;
  readonly collectionMethod: CollectionMethod;
  readonly daysUntilDue: number | null;
  readonly defaultPaymentMethodId: string | null;
  readonly description: string | null;
  readonly billingCycleAnchor: Date;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly startDate: Date;
  readonly trialStart: Date | null;
  readonly trialEnd: Date | null;
  readonly trialEndBehavior: TrialEndBehavior;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelAt: Date | null;
  readonly automaticTax: boolean;
  readonly discountCouponId: string | null;
  readonly discountPromotionCodeId: string | null;
  readonly discountStart: Date | null;
  readonly discountEnd: Date | null;
  readonly metadata: Record<string, string>;
  readonly nextActionAt: Date | null;
}

export async function insertSubscription(
  tx: Transaction,
  params: InsertSubscriptionParams,
): Promise<SubscriptionRow> {
  const [row] = await tx
    .insert(subscriptions)
    .values({ id: uuidv7(), ...params })
    .returning(COLUMNS);
  if (!row) throw new Error('subscription insert returned no row');
  return toRow(row);
}

export async function findSubscriptionForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(subscriptions)
    .where(and(eq(subscriptions.publicId, publicId), eq(subscriptions.merchantId, merchantId)));
  return row ? toRow(row) : null;
}

export async function findSubscriptionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db.select(COLUMNS).from(subscriptions).where(eq(subscriptions.id, id));
  return row ? toRow(row) : null;
}

export async function findSubscriptionsByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<SubscriptionRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(COLUMNS)
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.merchantId, merchantId),
        inArray(subscriptions.publicId, [...publicIds]),
      ),
    );
  return rows.map(toRow);
}

/** Lock the row for the caller's transaction and read it as it stands. */
export async function lockSubscription(
  tx: Transaction,
  id: string,
): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(subscriptions)
    .where(eq(subscriptions.id, id))
    .for('update');
  return row ? toRow(row) : null;
}

/** Every column a write may move besides `status`. */
export interface SubscriptionPatch {
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number | null;
  readonly defaultPaymentMethodId?: string | null;
  readonly description?: string | null;
  readonly billingCycleAnchor?: Date;
  readonly currentPeriodStart?: Date;
  readonly currentPeriodEnd?: Date;
  readonly trialStart?: Date | null;
  readonly trialEnd?: Date | null;
  readonly trialWillEndSentAt?: Date | null;
  readonly upcomingNoticeSentAt?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: Date | null;
  readonly canceledAt?: Date | null;
  readonly endedAt?: Date | null;
  readonly cancellationReason?: SubscriptionCancellationReason | null;
  readonly cancellationComment?: string | null;
  readonly pauseBehavior?: PauseCollectionBehavior | null;
  readonly pauseResumesAt?: Date | null;
  readonly automaticTax?: boolean;
  readonly discountCouponId?: string | null;
  readonly discountPromotionCodeId?: string | null;
  readonly discountStart?: Date | null;
  readonly discountEnd?: Date | null;
  readonly latestInvoiceId?: string | null;
  readonly nextActionAt?: Date | null;
  readonly metadata?: MetadataPatch;
}

function patchValues(patch: SubscriptionPatch): Record<string, unknown> {
  const { metadata, ...rest } = patch;
  const values: Record<string, unknown> = { updatedAt: nowMs };
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) values[key] = value;
  if (metadata) values.metadata = mergedMetadata(subscriptions.metadata, metadata);
  return values;
}

/**
 * Write a patch (never the status). `limit_exceeded` when a metadata patch
 * would leave more keys than allowed.
 */
export async function updateSubscription(
  tx: Transaction,
  id: string,
  patch: SubscriptionPatch,
): Promise<SubscriptionRow | 'limit_exceeded'> {
  const where: SQL[] = [eq(subscriptions.id, id)];
  if (patch.metadata) {
    where.push(metadataWithinLimit(mergedMetadata(subscriptions.metadata, patch.metadata)));
  }
  const [row] = await tx
    .update(subscriptions)
    .set(patchValues(patch))
    .where(and(...where))
    .returning(COLUMNS);
  if (!row) return 'limit_exceeded';
  return toRow(row);
}

/**
 * The status compare-and-swap: move `from` → `to` with `patch` in ONE
 * statement, or answer `stale` when another writer moved the row first.
 */
export async function setSubscriptionStatus(
  tx: Transaction,
  id: string,
  from: SubscriptionStatus,
  to: SubscriptionStatus,
  patch: SubscriptionPatch = {},
): Promise<SubscriptionRow | 'stale'> {
  const [row] = await tx
    .update(subscriptions)
    .set({ ...patchValues(patch), status: to })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.status, from)))
    .returning(COLUMNS);
  return row ? toRow(row) : 'stale';
}

/** What a list of subscriptions walks — its filters, without the page. */
export interface SubscriptionListScope {
  readonly merchantId: string;
  readonly customerId?: string | undefined;
  readonly priceId?: string | undefined;
  readonly status?: SubscriptionStatus | 'all' | 'ended' | undefined;
  readonly testClockId?: string | undefined;
  readonly currentPeriodEnd?: CreatedRange | undefined;
  /** A compiled search predicate (`GET /v1/subscriptions/search`). */
  readonly search?: SQL | undefined;
}

export interface SubscriptionListFilters extends SubscriptionListScope {
  readonly page: KeysetPage;
}

function subscriptionListWhere(filters: SubscriptionListScope): SQL | undefined {
  const conditions: (SQL | undefined)[] = [eq(subscriptions.merchantId, filters.merchantId)];
  if (filters.customerId) conditions.push(eq(subscriptions.customerId, filters.customerId));
  if (filters.testClockId) conditions.push(eq(subscriptions.testClockId, filters.testClockId));
  if (filters.priceId) {
    conditions.push(
      sql`exists (select 1 from ${subscriptionItems} where ${subscriptionItems.subscriptionId} = ${subscriptions.id} and ${subscriptionItems.priceId} = ${filters.priceId} and ${subscriptionItems.deletedAt} is null)`,
    );
  }
  // Stripe's default hides canceled subscriptions; `all` shows every one.
  const status = filters.status;
  if (status === undefined) conditions.push(sql`${subscriptions.status} <> 'canceled'`);
  else if (status === 'ended') {
    conditions.push(inArray(subscriptions.status, ['canceled', 'incomplete_expired']));
  } else if (status !== 'all') conditions.push(eq(subscriptions.status, status));
  const range = filters.currentPeriodEnd;
  if (range) {
    const at = (s: number) => new Date(s * 1000);
    if (range.gte !== undefined)
      conditions.push(gte(subscriptions.currentPeriodEnd, at(range.gte)));
    if (range.gt !== undefined)
      conditions.push(gte(subscriptions.currentPeriodEnd, at(range.gt + 1)));
    if (range.lt !== undefined) conditions.push(lt(subscriptions.currentPeriodEnd, at(range.lt)));
    if (range.lte !== undefined)
      conditions.push(lt(subscriptions.currentPeriodEnd, at(range.lte + 1)));
  }
  conditions.push(filters.search);
  return and(...conditions);
}

export async function listSubscriptions(
  db: DatabaseOrTransaction,
  filters: SubscriptionListFilters,
): Promise<{ data: SubscriptionRow[]; hasMore: boolean }> {
  const walk = keyset(subscriptions.id, subscriptions.createdAt, filters.page);
  const rows = await db
    .select(COLUMNS)
    .from(subscriptions)
    .where(and(subscriptionListWhere(filters), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/** How many subscriptions {@link listSubscriptions} would walk — a search's `total_count`. */
export async function countSubscriptions(
  db: DatabaseOrTransaction,
  filters: SubscriptionListScope,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(subscriptionListWhere(filters));
  return row?.n ?? 0;
}

/** Subscriptions of a customer in the given statuses — entitlements and the portal. */
export async function listCustomerSubscriptions(
  db: DatabaseOrTransaction,
  customerId: string,
  statuses?: readonly SubscriptionStatus[],
): Promise<SubscriptionRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        statuses ? inArray(subscriptions.status, [...statuses]) : undefined,
      ),
    )
    .orderBy(asc(subscriptions.id));
  return rows.map(toRow);
}

/**
 * The scheduler's claim: up to `limit` subscriptions whose `next_action_at`
 * has come by THEIR clock — the test clock's `frozen_time` when they live on
 * one, the database's `now()` otherwise — and whose lease is free. One
 * statement, `FOR UPDATE SKIP LOCKED` inside it, so two workers never claim
 * the same row; the lease keeps it theirs while they work outside a
 * transaction (provider calls).
 */
export async function claimDueSubscriptions(
  db: DatabaseOrTransaction,
  options: { readonly limit: number; readonly leaseSeconds: number; readonly testClockId?: string },
): Promise<string[]> {
  const clockFilter = options.testClockId
    ? sql`and s.test_clock_id = ${options.testClockId}`
    : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    update ${subscriptions} set lease_expires_at = now() + make_interval(secs => ${options.leaseSeconds})
    where ${subscriptions.id} in (
      select s.id from ${subscriptions} s
      left join ${testClocks} tc on tc.id = s.test_clock_id
      where s.next_action_at is not null
        and s.next_action_at <= coalesce(tc.frozen_time, now())
        and (s.lease_expires_at is null or s.lease_expires_at < now())
        ${clockFilter}
      order by s.next_action_at
      limit ${options.limit}
      for update of s skip locked
    )
    returning ${subscriptions.id} as id`);
  return [...rows].map((row) => row.id);
}

export async function releaseSubscriptionLease(
  db: DatabaseOrTransaction,
  id: string,
): Promise<void> {
  await db.update(subscriptions).set({ leaseExpiresAt: null }).where(eq(subscriptions.id, id));
}

/** Whether anything on this clock is still due at its frozen time (an advance is done when not). */
export async function clockHasDueSubscriptions(
  db: DatabaseOrTransaction,
  testClockId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(testClocks, eq(testClocks.id, subscriptions.testClockId))
    .where(
      and(
        eq(subscriptions.testClockId, testClockId),
        lte(subscriptions.nextActionAt, testClocks.frozenTime),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---- Items ----------------------------------------------------------------------

export interface SubscriptionItemRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly subscriptionId: string;
  readonly subscriptionPublicId: string;
  readonly priceId: string;
  readonly quantity: number;
  readonly metadata: Record<string, string>;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

const I = 'subscription_items';
const ITEM_COLUMNS = {
  id: subscriptionItems.id,
  publicId: subscriptionItems.publicId,
  merchantId: subscriptionItems.merchantId,
  livemode: merchantLivemodeOf(subscriptionItems.merchantId),
  subscriptionId: subscriptionItems.subscriptionId,
  subscriptionPublicId: requiredPublicIdOf('subscriptions', I, 'subscription_id'),
  priceId: subscriptionItems.priceId,
  quantity: subscriptionItems.quantity,
  metadata: subscriptionItems.metadata,
  deletedAt: subscriptionItems.deletedAt,
  createdAt: subscriptionItems.createdAt,
} as const;

const toItem = (row: Record<string, unknown>) => row as unknown as SubscriptionItemRow;

export async function insertSubscriptionItem(
  tx: Transaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly subscriptionId: string;
    readonly priceId: string;
    readonly quantity: number;
    readonly metadata: Record<string, string>;
  },
): Promise<SubscriptionItemRow | 'price_taken'> {
  const [row] = await tx
    .insert(subscriptionItems)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(ITEM_COLUMNS);
  return row ? toItem(row) : 'price_taken';
}

/** The live items of a subscription, oldest first (the order lines are built in). */
export async function listLiveItems(
  db: DatabaseOrTransaction,
  subscriptionId: string,
): Promise<SubscriptionItemRow[]> {
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        isNull(subscriptionItems.deletedAt),
      ),
    )
    .orderBy(asc(subscriptionItems.id));
  return rows.map(toItem);
}

/** The live items of several subscriptions at once. */
export async function listLiveItemsFor(
  db: DatabaseOrTransaction,
  subscriptionIds: readonly string[],
): Promise<SubscriptionItemRow[]> {
  if (subscriptionIds.length === 0) return [];
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(subscriptionItems)
    .where(
      and(
        inArray(subscriptionItems.subscriptionId, [...subscriptionIds]),
        isNull(subscriptionItems.deletedAt),
      ),
    )
    .orderBy(asc(subscriptionItems.id));
  return rows.map(toItem);
}

export async function findItemForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<SubscriptionItemRow | null> {
  const [row] = await db
    .select(ITEM_COLUMNS)
    .from(subscriptionItems)
    .where(
      and(eq(subscriptionItems.publicId, publicId), eq(subscriptionItems.merchantId, merchantId)),
    );
  return row ? toItem(row) : null;
}

export async function listItemsPage(
  db: DatabaseOrTransaction,
  subscriptionId: string,
  page: KeysetPage,
): Promise<{ data: SubscriptionItemRow[]; hasMore: boolean }> {
  const walk = keyset(subscriptionItems.id, subscriptionItems.createdAt, page);
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        isNull(subscriptionItems.deletedAt),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toItem));
}

export async function updateSubscriptionItem(
  tx: Transaction,
  id: string,
  patch: {
    readonly priceId?: string;
    readonly quantity?: number;
    readonly metadata?: MetadataPatch;
    readonly deletedAt?: Date;
  },
): Promise<SubscriptionItemRow | 'limit_exceeded' | 'price_taken'> {
  const { metadata, ...rest } = patch;
  const where: SQL[] = [eq(subscriptionItems.id, id)];
  if (metadata)
    where.push(metadataWithinLimit(mergedMetadata(subscriptionItems.metadata, metadata)));
  try {
    const [row] = await tx.transaction(async (savepoint) =>
      savepoint
        .update(subscriptionItems)
        .set({
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          ...(metadata ? { metadata: mergedMetadata(subscriptionItems.metadata, metadata) } : {}),
          updatedAt: nowMs,
        })
        .where(and(...where))
        .returning(ITEM_COLUMNS),
    );
    return row ? toItem(row) : 'limit_exceeded';
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return 'price_taken';
    throw error;
  }
}
