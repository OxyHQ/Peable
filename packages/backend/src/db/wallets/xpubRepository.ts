import { and, eq, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { walletXpubs } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';

/**
 * Reads and writes for `wallet_xpubs` — the account-level watch-only key a
 * user's signing device published so its own other surfaces can show the
 * wallet. See the table's header for why the key has to travel at all.
 *
 * Written by `PUT /v1/wallet/me/xpub`, read by `GET /v1/wallet/me/xpub`.
 */

export interface UpsertWalletXpubParams {
  readonly oxyUserId: string;
  readonly network: NetworkType;
  readonly xpub: string;
}

/**
 * Publish (or re-publish) the caller's account xpub.
 *
 * `ON CONFLICT DO UPDATE` on the unique `(oxy_user_id, network)` index, and the
 * lazy create is folded into the same statement — the shape
 * `db/social/receiveCursor.ts` uses, for the same reason: reading first to
 * decide insert-vs-update leaves a window where two publishes both insert, and
 * the loser gets a duplicate-key error instead of converging.
 */
export async function upsertWalletXpub(
  db: DatabaseOrTransaction,
  params: UpsertWalletXpubParams
): Promise<void> {
  await db
    .insert(walletXpubs)
    .values({
      oxyUserId: params.oxyUserId,
      network: params.network,
      xpub: params.xpub,
    })
    .onConflictDoUpdate({
      target: [walletXpubs.oxyUserId, walletXpubs.network],
      set: { xpub: params.xpub, updatedAt: sql`date_trunc('milliseconds', now())` },
    });
}

/** The caller's published account xpub, or `null` when no device published one. */
export async function findWalletXpub(
  db: DatabaseOrTransaction,
  oxyUserId: string,
  network: NetworkType
): Promise<string | null> {
  const rows = await db
    .select({ xpub: walletXpubs.xpub })
    .from(walletXpubs)
    .where(and(eq(walletXpubs.oxyUserId, oxyUserId), eq(walletXpubs.network, network)))
    .limit(1);
  return rows[0]?.xpub ?? null;
}
