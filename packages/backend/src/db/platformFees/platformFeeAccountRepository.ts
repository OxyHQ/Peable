/**
 * Reads and writes for `platform_fee_accounts` — a platform's own FairCoin fee
 * key (ADR 0013).
 *
 * The key is written by ONE function, `registerPlatformFeeKey`, reached only
 * from the Oxy-user route a platform OWNER uses in the Peable wallet. No
 * service-authed path can set it, and nothing here returns it to a DTO.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NetworkType } from '@fairco.in/core';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { assertWatchOnly } from '../../services/watchOnly';
import { isWatchOnlyKeyInUse } from '../keys/keyInUse';
import { platformFeeAccounts } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ReservedDerivationIndex } from '../merchants/derivationIndex';

export interface PlatformFeeAccountRow {
  readonly id: string;
  readonly merchantId: string;
  readonly network: NetworkType;
  readonly registeredByOxyUserId: string;
  readonly registeredAt: Date;
}

const FEE_ACCOUNT_COLUMNS = {
  id: platformFeeAccounts.id,
  merchantId: platformFeeAccounts.merchantId,
  network: platformFeeAccounts.network,
  registeredByOxyUserId: platformFeeAccounts.registeredByOxyUserId,
  registeredAt: platformFeeAccounts.registeredAt,
} as const;

function toRow(row: Record<string, unknown>): PlatformFeeAccountRow {
  return row as unknown as PlatformFeeAccountRow;
}

export type RegisterFeeKeyResult =
  | { readonly ok: true; readonly account: PlatformFeeAccountRow }
  | { readonly ok: false; readonly refusal: 'already_registered' | 'key_in_use' };

/**
 * Store a platform's fee key — THE single writer of
 * `platform_fee_accounts.xpub`, and where the non-custody firewall runs for it.
 *
 * In order, every one a refusal that writes nothing: `assertWatchOnly` (a key
 * that can spend, or one for the other network, throws); the key must not
 * already derive addresses for anyone; and one key per platform per network,
 * immutable — the unique constraint converges a double registration onto the
 * first.
 *
 * @throws {WatchOnlyViolationError}
 */
export async function registerPlatformFeeKey(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly network: NetworkType;
    readonly xpub: string;
    readonly oxyUserId: string;
    readonly now?: Date;
  },
): Promise<RegisterFeeKeyResult> {
  assertWatchOnly(params.xpub, params.network);
  if (await findPlatformFeeAccount(db, params.merchantId, params.network)) {
    return { ok: false, refusal: 'already_registered' };
  }
  if (await isWatchOnlyKeyInUse(db, params.xpub)) return { ok: false, refusal: 'key_in_use' };
  try {
    const [row] = await db
      .insert(platformFeeAccounts)
      .values({
        id: uuidv7(),
        merchantId: params.merchantId,
        network: params.network,
        xpub: params.xpub,
        registeredByOxyUserId: params.oxyUserId,
        registeredAt: params.now ?? new Date(),
      })
      .returning(FEE_ACCOUNT_COLUMNS);
    if (!row) throw new Error('platform fee account insert returned no row');
    return { ok: true, account: toRow(row) };
  } catch (error) {
    if (isUniqueViolation(error, 'platform_fee_accounts_merchant_id_network_key')) {
      return { ok: false, refusal: 'already_registered' };
    }
    if (isUniqueViolation(error, 'platform_fee_accounts_xpub_key')) {
      return { ok: false, refusal: 'key_in_use' };
    }
    throw error;
  }
}

export async function findPlatformFeeAccount(
  db: DatabaseOrTransaction,
  merchantId: string,
  network: NetworkType,
): Promise<PlatformFeeAccountRow | null> {
  const [row] = await db
    .select(FEE_ACCOUNT_COLUMNS)
    .from(platformFeeAccounts)
    .where(
      and(eq(platformFeeAccounts.merchantId, merchantId), eq(platformFeeAccounts.network, network)),
    );
  return row ? toRow(row) : null;
}

export async function listPlatformFeeAccounts(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<readonly PlatformFeeAccountRow[]> {
  const rows = await db
    .select(FEE_ACCOUNT_COLUMNS)
    .from(platformFeeAccounts)
    .where(eq(platformFeeAccounts.merchantId, merchantId))
    .orderBy(asc(platformFeeAccounts.network));
  return rows.map(toRow);
}

/**
 * Claim the platform's next fee-key index, atomically — the same ONE statement
 * as every other reservation here (`db/merchants/derivationIndex.ts` says why):
 * `UPDATE … SET x = x + 1 … RETURNING x - 1`, with the key and network in the
 * same statement, `integer` so the index is a number and never a string.
 *
 * @returns the account id with the reservation, or `null` when this platform
 *   has no fee key on that network — nothing was reserved.
 */
export async function reserveNextPlatformFeeDerivationIndex(
  db: DatabaseOrTransaction,
  merchantId: string,
  network: NetworkType,
): Promise<(ReservedDerivationIndex & { readonly accountId: string }) | null> {
  const [row] = await db
    .update(platformFeeAccounts)
    .set({ nextDerivationIndex: sql`${platformFeeAccounts.nextDerivationIndex} + 1` })
    .where(
      and(eq(platformFeeAccounts.merchantId, merchantId), eq(platformFeeAccounts.network, network)),
    )
    .returning({
      accountId: platformFeeAccounts.id,
      index: sql<number>`${platformFeeAccounts.nextDerivationIndex} - 1`,
      xpub: platformFeeAccounts.xpub,
      network: platformFeeAccounts.network,
    });
  if (!row) return null;
  return {
    accountId: row.accountId,
    index: row.index,
    xpub: row.xpub,
    network: row.network as NetworkType,
  };
}
