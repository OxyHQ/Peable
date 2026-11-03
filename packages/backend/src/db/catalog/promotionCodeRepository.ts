import { and, eq, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { promotionCodes } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';

/**
 * Reads and writes for `promotion_codes` (ADR 0018). A code is compared
 * case-insensitively (`lower(code)`), and only ACTIVE codes contend for one
 * spelling — the partial unique index decides, never a read-then-write.
 */

const ACTIVE_CODE_CONSTRAINT = 'promotion_codes_merchant_active_code_key';

export interface PromotionCodeRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  /** INTERNAL coupon id. */
  readonly couponId: string;
  /** The coupon's own id, what the wire calls `coupon`. */
  readonly couponPublicId: string;
  /** INTERNAL id of the one customer who may redeem it. */
  readonly customerId: string | null;
  /** Its public `cus_…`, what the wire calls `customer`. */
  readonly customerPublicId: string | null;
  readonly code: string;
  readonly active: boolean;
  readonly maxRedemptions: number | null;
  readonly expiresAt: Date | null;
  readonly timesRedeemed: number;
  readonly firstTimeTransaction: boolean;
  readonly minimumAmount: string | null;
  readonly minimumAmountCurrency: CurrencyCode | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

const PROMOTION_CODE_COLUMNS = {
  id: promotionCodes.id,
  publicId: promotionCodes.publicId,
  merchantId: promotionCodes.merchantId,
  livemode: merchantLivemodeOf(promotionCodes.merchantId),
  couponId: promotionCodes.couponId,
  // Raw and table-qualified: RETURNING renders column refs unqualified.
  couponPublicId: sql<string>`(${sql.raw(
    'select c.public_id from coupons c where c.id = "promotion_codes"."coupon_id"',
  )})`,
  customerId: promotionCodes.customerId,
  customerPublicId: sql<string | null>`(${sql.raw(
    'select c.public_id from customers c where c.id = "promotion_codes"."customer_id"',
  )})`,
  code: promotionCodes.code,
  active: promotionCodes.active,
  maxRedemptions: promotionCodes.maxRedemptions,
  expiresAt: promotionCodes.expiresAt,
  timesRedeemed: promotionCodes.timesRedeemed,
  firstTimeTransaction: promotionCodes.firstTimeTransaction,
  minimumAmount: promotionCodes.minimumAmount,
  minimumAmountCurrency: promotionCodes.minimumAmountCurrency,
  metadata: promotionCodes.metadata,
  createdAt: promotionCodes.createdAt,
} as const;

function toPromotionCodeRow(row: {
  minimumAmountCurrency: string | null;
  [key: string]: unknown;
}): PromotionCodeRow {
  return row as unknown as PromotionCodeRow;
}

export interface InsertPromotionCodeParams {
  readonly publicId: string;
  readonly merchantId: string;
  /** INTERNAL id of a live coupon of the same merchant. */
  readonly couponId: string;
  /** INTERNAL id of a live customer of the same merchant, or `null`. */
  readonly customerId: string | null;
  readonly code: string;
  readonly active: boolean;
  readonly maxRedemptions: number | null;
  readonly expiresAt: Date | null;
  readonly firstTimeTransaction: boolean;
  readonly minimumAmount: string | null;
  readonly minimumAmountCurrency: CurrencyCode | null;
  readonly metadata: Record<string, string>;
}

/** Insert a code. `code_taken` when an active code of the merchant already spells it. */
export async function insertPromotionCode(
  tx: Transaction,
  params: InsertPromotionCodeParams,
): Promise<PromotionCodeRow | 'code_taken'> {
  const [row] = await tx
    .insert(promotionCodes)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(PROMOTION_CODE_COLUMNS);
  return row ? toPromotionCodeRow(row) : 'code_taken';
}

export async function findPromotionCodeForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<PromotionCodeRow | null> {
  const [row] = await db
    .select(PROMOTION_CODE_COLUMNS)
    .from(promotionCodes)
    .where(and(eq(promotionCodes.publicId, publicId), eq(promotionCodes.merchantId, merchantId)));
  return row ? toPromotionCodeRow(row) : null;
}

/** Lock one code for the rest of the transaction. */
export async function lockPromotionCode(
  tx: Transaction,
  publicId: string,
  merchantId: string,
): Promise<PromotionCodeRow | null> {
  const [row] = await tx
    .select(PROMOTION_CODE_COLUMNS)
    .from(promotionCodes)
    .where(and(eq(promotionCodes.publicId, publicId), eq(promotionCodes.merchantId, merchantId)))
    .for('update', { of: promotionCodes });
  return row ? toPromotionCodeRow(row) : null;
}

export interface PromotionCodeListFilters {
  readonly merchantId: string;
  readonly page: KeysetPage;
  /** Compared case-insensitively. */
  readonly code?: string | undefined;
  /** INTERNAL coupon id. */
  readonly couponId?: string | undefined;
  /** INTERNAL customer id. */
  readonly customerId?: string | undefined;
  readonly active?: boolean | undefined;
}

export async function listPromotionCodesForMerchant(
  db: DatabaseOrTransaction,
  filters: PromotionCodeListFilters,
): Promise<{ data: PromotionCodeRow[]; hasMore: boolean }> {
  const walk = keyset(promotionCodes.id, promotionCodes.createdAt, filters.page);
  const rows = await db
    .select(PROMOTION_CODE_COLUMNS)
    .from(promotionCodes)
    .where(
      and(
        eq(promotionCodes.merchantId, filters.merchantId),
        filters.code === undefined
          ? undefined
          : sql`lower(${promotionCodes.code}) = lower(${filters.code})`,
        filters.couponId === undefined ? undefined : eq(promotionCodes.couponId, filters.couponId),
        filters.customerId === undefined
          ? undefined
          : eq(promotionCodes.customerId, filters.customerId),
        filters.active === undefined ? undefined : eq(promotionCodes.active, filters.active),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toPromotionCodeRow));
}

/**
 * `active` and `metadata` of a LOCKED code. Re-activating a code another
 * active code now spells is `code_taken`, decided by the unique index under a
 * savepoint so the caller's transaction survives the refusal.
 */
export async function updatePromotionCode(
  tx: Transaction,
  codeId: string,
  patch: { readonly active?: boolean | undefined; readonly metadata?: MetadataPatch | undefined },
): Promise<PromotionCodeRow | 'limit_exceeded' | 'code_taken'> {
  const merged = patch.metadata ? mergedMetadata(promotionCodes.metadata, patch.metadata) : null;
  const scope = eq(promotionCodes.id, codeId);
  try {
    return await tx.transaction(async (savepoint) => {
      const [row] = await savepoint
        .update(promotionCodes)
        .set({
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(merged ? { metadata: merged } : {}),
          updatedAt: sql`date_trunc('milliseconds', now())`,
        })
        .where(merged ? and(scope, metadataWithinLimit(merged)) : scope)
        .returning(PROMOTION_CODE_COLUMNS);
      return row ? toPromotionCodeRow(row) : ('limit_exceeded' as const);
    });
  } catch (error) {
    if (isUniqueViolation(error, ACTIVE_CODE_CONSTRAINT)) return 'code_taken';
    throw error;
  }
}
