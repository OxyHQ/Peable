import { and, count, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../postgres';
import {
  merchants,
  paymentIntents,
  connectedAccounts,
  transfers,
  billingObjectBindings,
  billingOperations,
  recurringMirrors,
} from '../schema';
/** Operator-only read audit. Counts do not disclose payer details or capabilities. */
export async function countProviderInventory(db: Database, accountId: string) {
  const [merchantModes, cardPayments, cardAccounts, cardTransfers, bindings, operations, mirrors] =
    await Promise.all([
      db
        .select({ environment: merchants.environment, count: count() })
        .from(merchants)
        .groupBy(merchants.environment),
      db
        .select({ count: count() })
        .from(paymentIntents)
        .innerJoin(merchants, eq(paymentIntents.merchantId, merchants.id))
        .where(
          and(
            eq(merchants.environment, 'production'),
            eq(paymentIntents.provider, 'stripe'),
            isNotNull(paymentIntents.providerObjectId),
          ),
        ),
      db
        .select({ count: count() })
        .from(connectedAccounts)
        .innerJoin(merchants, eq(connectedAccounts.merchantId, merchants.id))
        .where(
          and(eq(merchants.environment, 'production'), eq(connectedAccounts.provider, 'stripe')),
        ),
      db
        .select({ count: count() })
        .from(transfers)
        .innerJoin(merchants, eq(transfers.merchantId, merchants.id))
        .where(and(eq(merchants.environment, 'production'), eq(transfers.provider, 'stripe'))),
      db
        .select({ kind: billingObjectBindings.kind, count: count() })
        .from(billingObjectBindings)
        .where(
          and(
            eq(billingObjectBindings.platformAccountId, accountId),
            eq(billingObjectBindings.livemode, true),
          ),
        )
        .groupBy(billingObjectBindings.kind),
      db
        .select({ state: billingOperations.state, count: count() })
        .from(billingOperations)
        .where(
          and(
            eq(billingOperations.platformAccountId, accountId),
            eq(billingOperations.livemode, true),
          ),
        )
        .groupBy(billingOperations.state),
      db
        .select({ count: count() })
        .from(recurringMirrors)
        .where(
          and(
            eq(recurringMirrors.platformAccountId, accountId),
            eq(recurringMirrors.livemode, true),
          ),
        ),
    ]);
  return {
    merchantModes,
    liveCardPayments: cardPayments[0]?.count,
    liveCardAccounts: cardAccounts[0]?.count,
    liveCardTransfers: cardTransfers[0]?.count,
    bindings,
    operations,
    recurringMirrors: mirrors[0]?.count,
  };
}
