import { and, desc, eq, lt } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres';
import type { MerchantRow } from '../merchants/merchantRepository';
import { billingObjectBindings, recurringMirrors } from '../schema';

/** Whitelisted owned records only; never an account-wide provider list or raw payload. */
export async function listDashboardBilling(
  db: DatabaseOrTransaction,
  merchant: MerchantRow,
  kind: 'customers' | 'subscriptions' | 'invoices',
  limit: number,
  after?: string,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page limit');
  if (kind === 'customers') {
    const scope = and(
      eq(billingObjectBindings.merchantId, merchant.id),
      eq(billingObjectBindings.oxyAppId, merchant.oxyAppId),
      eq(billingObjectBindings.environment, merchant.environment),
      eq(billingObjectBindings.livemode, merchant.livemode),
      eq(billingObjectBindings.kind, 'customer'),
    );
    const cursor = after
      ? await db
          .select({ id: billingObjectBindings.id })
          .from(billingObjectBindings)
          .where(and(scope, eq(billingObjectBindings.providerRef, after)))
          .limit(2)
      : undefined;
    if (cursor && cursor.length !== 1) return null;
    const rows = await db
      .select({
        id: billingObjectBindings.providerRef,
        subjectRef: billingObjectBindings.externalSubjectRef,
        createdAt: billingObjectBindings.createdAt,
        livemode: billingObjectBindings.livemode,
      })
      .from(billingObjectBindings)
      .where(and(scope, cursor?.[0] ? lt(billingObjectBindings.id, cursor[0].id) : undefined))
      .orderBy(desc(billingObjectBindings.id))
      .limit(limit + 1);
    return {
      data: rows
        .slice(0, limit)
        .map((row) => ({
          ...row,
          object: 'billing_customer' as const,
          createdAt: row.createdAt.toISOString(),
        })),
      hasMore: rows.length > limit,
    };
  }
  const mirrorKind = kind === 'subscriptions' ? 'subscription' : 'invoice';
  const scope = and(
    eq(recurringMirrors.merchantId, merchant.id),
    eq(recurringMirrors.oxyAppId, merchant.oxyAppId),
    eq(recurringMirrors.environment, merchant.environment),
    eq(recurringMirrors.livemode, merchant.livemode),
    eq(recurringMirrors.kind, mirrorKind),
  );
  const cursor = after
    ? await db
        .select({ id: recurringMirrors.id })
        .from(recurringMirrors)
        .where(and(scope, eq(recurringMirrors.objectRef, after)))
        .limit(2)
    : undefined;
  if (cursor && cursor.length !== 1) return null;
  const rows = await db
    .select({
      id: recurringMirrors.objectRef,
      snapshot: recurringMirrors.snapshot,
      observedAt: recurringMirrors.observedAt,
      createdAt: recurringMirrors.createdAt,
      livemode: recurringMirrors.livemode,
    })
    .from(recurringMirrors)
    .where(and(scope, cursor?.[0] ? lt(recurringMirrors.id, cursor[0].id) : undefined))
    .orderBy(desc(recurringMirrors.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit).map((row) => {
    const snapshot = row.snapshot;
    if (
      snapshot &&
      (snapshot.objectRef !== row.id ||
        snapshot.kind !== mirrorKind ||
        snapshot.livemode !== merchant.livemode)
    )
      throw new Error('Recurring observation identity mismatch');
    const common = {
      id: row.id,
      object: `billing_${mirrorKind}`,
      livemode: row.livemode,
      status: snapshot?.status ?? 'unknown',
      observedAt: row.observedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      periods:
        snapshot?.periods.map((period) => ({ start: period.start, end: period.end })) ?? null,
    };
    if (mirrorKind === 'subscription')
      return {
        ...common,
        cancelAtPeriodEnd: snapshot?.kind === 'subscription' ? snapshot.cancelAtPeriodEnd : null,
      };
    return {
      ...common,
      subscriptionId: snapshot?.kind === 'invoice' ? snapshot.subscriptionRef : null,
      currency: snapshot?.kind === 'invoice' ? snapshot.currency : null,
      amountDue: snapshot?.kind === 'invoice' ? snapshot.amountDue : null,
      amountPaid: snapshot?.kind === 'invoice' ? snapshot.amountPaid : null,
      amountRemaining: snapshot?.kind === 'invoice' ? snapshot.amountRemaining : null,
    };
  });
  return { data, hasMore: rows.length > limit };
}
