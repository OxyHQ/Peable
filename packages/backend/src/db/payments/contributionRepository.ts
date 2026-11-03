import { and, desc, eq } from 'drizzle-orm';
import { paymentLinks, merchants, refunds } from '../schema';
import type { Database, DatabaseOrTransaction } from '../postgres';
import {
  findLinkByPublicId,
  insertPaymentLink,
  type InsertPaymentLinkParams,
} from './paymentLinkRepository';
export async function createContributionLink(db: Database, params: InsertPaymentLinkParams) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, params.merchantId))
      .for('update');
    const [existing] = await tx
      .select({ publicId: paymentLinks.publicId })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.merchantId, params.merchantId),
          eq(paymentLinks.contributionKey, params.contributionKey ?? ''),
        ),
      );
    if (existing) {
      const row = await findLinkByPublicId(tx, existing.publicId);
      if (
        !row ||
        row.amount !== params.amount ||
        row.currency !== params.currency ||
        ['organizationId', 'purpose', 'amountMode', 'expiresAt'].some(
          (key) =>
            row.contribution?.[key as keyof NonNullable<typeof row.contribution>] !==
            params.contribution?.[key as keyof NonNullable<typeof params.contribution>],
        )
      )
        return null;
      return row;
    }
    if (params.contribution?.expiresAt && Date.parse(params.contribution.expiresAt) <= Date.now())
      return 'expired' as const;
    return insertPaymentLink(tx, params);
  });
}
export async function contributionRefunds(db: DatabaseOrTransaction, intentId: string) {
  return db
    .select({
      id: refunds.publicId,
      amount: refunds.amount,
      status: refunds.status,
      createdAt: refunds.createdAt,
    })
    .from(refunds)
    .where(eq(refunds.paymentIntentId, intentId))
    .orderBy(desc(refunds.id));
}
