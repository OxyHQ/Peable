import { eq } from 'drizzle-orm';
import { connectedAccounts, merchants, platformFeeAccounts } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Whether this watch-only key already derives addresses for ANYONE in this
 * gateway — a merchant, a seller or a platform's fee account (ADR 0012 D4,
 * ADR 0013).
 *
 * Two derivation counters walking one key hand out the SAME addresses, and two
 * payments on one address are two payments the gateway can attribute to
 * neither. Each table has its own unique index on its key; this is the
 * cross-table half no constraint can state, read inside the writer's
 * transaction. A registration racing another in a different table in the same
 * instant is the residual risk, written down in ADR 0012.
 *
 * Every writer of a seller or fee key calls it. `insertMerchant` does not —
 * merchants have always been able to register the same key under several
 * applications, and closing that is its own decision.
 */
export async function isWatchOnlyKeyInUse(db: DatabaseOrTransaction, xpub: string): Promise<boolean> {
  const [merchant] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.xpub, xpub))
    .limit(1);
  if (merchant) return true;
  const [seller] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.xpub, xpub))
    .limit(1);
  if (seller) return true;
  const [fee] = await db
    .select({ id: platformFeeAccounts.id })
    .from(platformFeeAccounts)
    .where(eq(platformFeeAccounts.xpub, xpub))
    .limit(1);
  return fee !== undefined;
}
