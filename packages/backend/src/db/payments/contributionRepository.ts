import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { paymentLinks, paymentIntents, merchants, refunds } from '../schema';
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
export async function listContributions(
  db: DatabaseOrTransaction,
  merchantId: string,
  organizationId: string,
  limit: number,
  after?: string,
) {
  return db
    .select({ publicId: paymentLinks.publicId })
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.merchantId, merchantId),
        sql`${paymentLinks.contribution}->>'organizationId' = ${organizationId}`,
        after ? lt(paymentLinks.publicId, after) : undefined,
      ),
    )
    .orderBy(desc(paymentLinks.publicId))
    .limit(limit + 1);
}
export async function listContributionCollections(
  db: DatabaseOrTransaction,
  merchantId: string,
  paymentLinkId: string,
  limit: number,
  after?: string,
) {
  return db
    .select({
      id: paymentIntents.id,
      publicId: paymentIntents.publicId,
      amount: paymentIntents.amount,
      currency: paymentIntents.currency,
      status: paymentIntents.status,
      createdAt: paymentIntents.createdAt,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.merchantId, merchantId),
        eq(paymentIntents.paymentLinkId, paymentLinkId),
        after ? lt(paymentIntents.publicId, after) : undefined,
      ),
    )
    .orderBy(desc(paymentIntents.publicId))
    .limit(limit + 1);
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
