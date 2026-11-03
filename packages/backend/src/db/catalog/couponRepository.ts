import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { CouponDuration, CurrencyCode } from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { couponProducts, coupons } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';

/**
 * Reads and writes for `coupons` and `coupon_products` (ADR 0018).
 *
 * A coupon's public id is unique per MERCHANT and over deleted coupons too
 * (`coupons_merchant_public_id_key`): a delete sets `deleted_at`, and every
 * ordinary read skips such rows, but the id stays taken so whatever named the
 * coupon keeps naming the same terms.
 */

export interface CouponRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly name: string | null;
  readonly percentOffBps: number | null;
  readonly amountOff: string | null;
  readonly currency: CurrencyCode | null;
  readonly duration: CouponDuration;
  readonly durationInMonths: number | null;
  readonly maxRedemptions: number | null;
  readonly redeemBy: Date | null;
  readonly timesRedeemed: number;
  readonly metadata: Record<string, string>;
  readonly deletedAt: Date | null;
  /** INTERNAL product ids of `applies_to`, or `null` for every product. */
  readonly appliesToProductIds: string[] | null;
  /** Their public `prod_…`, in the same order. */
  readonly appliesToProducts: string[] | null;
  readonly createdAt: Date;
}

/**
 * One column of the coupon's `applies_to` products, as an array. Written out
 * with aliases and the OUTER row named in full: drizzle renders the selected
 * table's own columns unqualified, and an unqualified `id` inside this
 * subquery would bind to `products.id` and match nothing.
 */
function appliesTo(column: 'id' | 'public_id'): SQL<string[] | null> {
  return sql<string[] | null>`(${sql.raw(
    `select array_agg(p.${column} order by p.public_id) from coupon_products cp join products p on p.id = cp.product_id where cp.coupon_id = "coupons"."id"`,
  )})`;
}

const COUPON_COLUMNS = {
  id: coupons.id,
  publicId: coupons.publicId,
  merchantId: coupons.merchantId,
  livemode: merchantLivemodeOf(coupons.merchantId),
  name: coupons.name,
  percentOffBps: coupons.percentOffBps,
  amountOff: coupons.amountOff,
  currency: coupons.currency,
  duration: coupons.duration,
  durationInMonths: coupons.durationInMonths,
  maxRedemptions: coupons.maxRedemptions,
  redeemBy: coupons.redeemBy,
  timesRedeemed: coupons.timesRedeemed,
  metadata: coupons.metadata,
  deletedAt: coupons.deletedAt,
  // `array_agg` over no rows is NULL — exactly "applies to every product".
  appliesToProductIds: appliesTo('id'),
  appliesToProducts: appliesTo('public_id'),
  createdAt: coupons.createdAt,
} as const;

function toCouponRow(row: { currency: string | null; duration: string; [key: string]: unknown }) {
  return row as unknown as CouponRow;
}

export interface InsertCouponParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly name: string | null;
  readonly percentOffBps: number | null;
  readonly amountOff: string | null;
  readonly currency: CurrencyCode | null;
  readonly duration: CouponDuration;
  readonly durationInMonths: number | null;
  readonly maxRedemptions: number | null;
  readonly redeemBy: Date | null;
  readonly metadata: Record<string, string>;
  /** INTERNAL ids of products of the same merchant; empty for every product. */
  readonly appliesToProductIds: readonly string[];
}

/** Insert a coupon and its `applies_to`. `id_taken` when the merchant ever used that id. */
export async function insertCoupon(
  tx: Transaction,
  params: InsertCouponParams,
): Promise<CouponRow | 'id_taken'> {
  const id = uuidv7();
  const inserted = await tx
    .insert(coupons)
    .values({
      id,
      publicId: params.publicId,
      merchantId: params.merchantId,
      name: params.name,
      percentOffBps: params.percentOffBps,
      amountOff: params.amountOff,
      currency: params.currency,
      duration: params.duration,
      durationInMonths: params.durationInMonths,
      maxRedemptions: params.maxRedemptions,
      redeemBy: params.redeemBy,
      metadata: params.metadata,
    })
    .onConflictDoNothing()
    .returning({ id: coupons.id });
  if (inserted.length === 0) return 'id_taken';
  if (params.appliesToProductIds.length > 0) {
    await tx.insert(couponProducts).values(
      [...new Set(params.appliesToProductIds)].map((productId) => ({
        couponId: id,
        productId,
        merchantId: params.merchantId,
      })),
    );
  }
  const row = await findCouponById(tx, id);
  if (!row) throw new Error('coupon insert vanished');
  return row;
}

/**
 * One coupon by its id, scoped to the merchant. Deleted coupons are not found
 * unless `includeDeleted` (an expansion of a promotion code naming one).
 */
export async function findCouponForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<CouponRow | null> {
  const [row] = await db
    .select(COUPON_COLUMNS)
    .from(coupons)
    .where(
      and(
        eq(coupons.publicId, publicId),
        eq(coupons.merchantId, merchantId),
        options.includeDeleted ? undefined : isNull(coupons.deletedAt),
      ),
    );
  return row ? toCouponRow(row) : null;
}

/** Coupons by id, deleted ones included — what a promotion code's `coupon` names. */
export async function findCouponsByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<CouponRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(COUPON_COLUMNS)
    .from(coupons)
    .where(and(eq(coupons.merchantId, merchantId), inArray(coupons.publicId, [...publicIds])));
  return rows.map(toCouponRow);
}

/** One page of a merchant's coupons (not deleted), newest first. */
export async function listCouponsForMerchant(
  db: DatabaseOrTransaction,
  params: { readonly merchantId: string; readonly page: KeysetPage },
): Promise<{ data: CouponRow[]; hasMore: boolean }> {
  const walk = keyset(coupons.id, coupons.createdAt, params.page);
  const rows = await db
    .select(COUPON_COLUMNS)
    .from(coupons)
    .where(and(eq(coupons.merchantId, params.merchantId), isNull(coupons.deletedAt), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toCouponRow));
}

/** Lock a live coupon for the rest of the transaction. */
export async function lockCoupon(
  tx: Transaction,
  publicId: string,
  merchantId: string,
): Promise<CouponRow | null> {
  const [row] = await tx
    .select(COUPON_COLUMNS)
    .from(coupons)
    .where(
      and(
        eq(coupons.publicId, publicId),
        eq(coupons.merchantId, merchantId),
        isNull(coupons.deletedAt),
      ),
    )
    .for('update', { of: coupons });
  return row ? toCouponRow(row) : null;
}

/** Name and metadata — the only parts of a coupon that may change. */
export async function updateCoupon(
  tx: Transaction,
  couponId: string,
  patch: {
    readonly name?: string | null | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<CouponRow | 'limit_exceeded'> {
  const merged = patch.metadata ? mergedMetadata(coupons.metadata, patch.metadata) : null;
  const scope = eq(coupons.id, couponId);
  const [row] = await tx
    .update(coupons)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(merged ? { metadata: merged } : {}),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(merged ? and(scope, metadataWithinLimit(merged)) : scope)
    .returning(COUPON_COLUMNS);
  return row ? toCouponRow(row) : 'limit_exceeded';
}

/** Mark a coupon deleted. Its id stays taken. */
export async function deleteCoupon(tx: Transaction, couponId: string): Promise<CouponRow> {
  const [row] = await tx
    .update(coupons)
    .set({
      deletedAt: sql`date_trunc('milliseconds', now())`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(and(eq(coupons.id, couponId), isNull(coupons.deletedAt)))
    .returning(COUPON_COLUMNS);
  if (!row) throw new Error(`coupon ${couponId} was not live under its lock`);
  return toCouponRow(row);
}

/** A coupon by its INTERNAL id, deleted or not — what a session's discount names. */
export async function findCouponById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CouponRow | null> {
  const [row] = await db.select(COUPON_COLUMNS).from(coupons).where(eq(coupons.id, id));
  return row ? toCouponRow(row) : null;
}

/**
 * Count one redemption — at checkout completion, in its transaction. ONE
 * statement: the increment and the `max_redemptions` bound are the same
 * `UPDATE`, so two completions racing for the last redemption cannot both
 * count it (`coupons_redemptions_check` would refuse the second anyway).
 * Checkout reserved the redemption when the payer confirmed, so a refusal here
 * means the bound moved under a reservation — `false`, never an exception that
 * would roll back the payment it is counted for.
 */
export async function redeemCoupon(tx: DatabaseOrTransaction, id: string): Promise<boolean> {
  const rows = await tx
    .update(coupons)
    .set({ timesRedeemed: sql`${coupons.timesRedeemed} + 1` })
    .where(
      and(
        eq(coupons.id, id),
        sql`(${coupons.maxRedemptions} is null or ${coupons.timesRedeemed} < ${coupons.maxRedemptions})`,
      ),
    )
    .returning({ id: coupons.id });
  return rows.length > 0;
}

/** Lock a coupon by its INTERNAL id (a session's reservation check). */
export async function lockCouponById(tx: Transaction, id: string): Promise<CouponRow | null> {
  const [row] = await tx
    .select(COUPON_COLUMNS)
    .from(coupons)
    .where(eq(coupons.id, id))
    .for('update', { of: coupons });
  return row ? toCouponRow(row) : null;
}
