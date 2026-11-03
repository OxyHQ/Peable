import { and, eq, isNull, sql } from 'drizzle-orm';
import { coupons, invoices, promotionCodes } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';

/**
 * Redemptions (ADR 0018): applying a coupon to a subscription or an invoice
 * counts ONE redemption of it, and of the promotion code it came through.
 *
 * Each count is one compare-and-swap statement — `times_redeemed + 1` WHERE it
 * is still below `max_redemptions` — so two concurrent subscriptions cannot
 * both take the last redemption: the loser's update matches no row and the
 * apply is refused. The CHECK `times_redeemed <= max_redemptions` is the
 * backstop.
 */
export async function redeemCoupon(tx: Transaction, couponId: string): Promise<boolean> {
  const rows = await tx
    .update(coupons)
    .set({ timesRedeemed: sql`${coupons.timesRedeemed} + 1` })
    .where(
      and(
        eq(coupons.id, couponId),
        isNull(coupons.deletedAt),
        sql`(${coupons.maxRedemptions} is null or ${coupons.timesRedeemed} < ${coupons.maxRedemptions})`,
      ),
    )
    .returning({ id: coupons.id });
  return rows.length === 1;
}

export async function redeemPromotionCode(
  tx: Transaction,
  promotionCodeId: string,
): Promise<boolean> {
  const rows = await tx
    .update(promotionCodes)
    .set({ timesRedeemed: sql`${promotionCodes.timesRedeemed} + 1` })
    .where(
      and(
        eq(promotionCodes.id, promotionCodeId),
        eq(promotionCodes.active, true),
        sql`(${promotionCodes.maxRedemptions} is null or ${promotionCodes.timesRedeemed} < ${promotionCodes.maxRedemptions})`,
      ),
    )
    .returning({ id: promotionCodes.id });
  return rows.length === 1;
}

/** Whether the customer has never paid an invoice of this merchant — a first-time-only code's test. */
export async function customerHasPaidBefore(
  db: DatabaseOrTransaction,
  customerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.status, 'paid')))
    .limit(1);
  return row !== undefined;
}
