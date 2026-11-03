/**
 * Reads and writes for `payouts` — the mirror of an account's payouts
 * (ADR 0015 §4–§5). Every status here is the PROVIDER's: a payout is executed by
 * the provider, and this table records what it said.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { PayoutStatus } from '@peable.to/shared-types';
import { connectedAccounts, payouts } from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { PayoutOrigin } from '../schema/valueSets';
import type { ProviderPayout } from '../../services/providers/provider';

export interface PayoutRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly connectedAccountId: string;
  readonly connectedAccountPublicId: string;
  readonly origin: PayoutOrigin;
  readonly provider: string;
  readonly providerObjectId: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly status: PayoutStatus;
  readonly method: 'standard' | 'instant';
  readonly type: 'bank_account' | 'card';
  readonly automatic: boolean;
  readonly arrivalDate: Date | null;
  readonly description: string | null;
  readonly statementDescriptor: string | null;
  readonly failureCode: string | null;
  readonly metadata: Record<string, string>;
  readonly providerCreatedAt: Date | null;
  readonly transactionsSyncedAt: Date | null;
  /** The payout's own ledger row (`txn_…`), once ingested. */
  readonly balanceTransactionPublicId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const PAYOUT_COLUMNS = {
  livemode: merchantLivemodeOf(payouts.merchantId),
  id: payouts.id,
  publicId: payouts.publicId,
  merchantId: payouts.merchantId,
  connectedAccountId: payouts.connectedAccountId,
  connectedAccountPublicId: sql<string>`(select ${connectedAccounts.publicId} from ${connectedAccounts} where ${connectedAccounts.id} = ${payouts.connectedAccountId})`,
  origin: payouts.origin,
  provider: payouts.provider,
  providerObjectId: payouts.providerObjectId,
  amount: payouts.amount,
  currency: payouts.currency,
  status: payouts.status,
  method: payouts.method,
  type: payouts.type,
  automatic: payouts.automatic,
  arrivalDate: payouts.arrivalDate,
  description: payouts.description,
  statementDescriptor: payouts.statementDescriptor,
  failureCode: payouts.failureCode,
  metadata: payouts.metadata,
  providerCreatedAt: payouts.providerCreatedAt,
  transactionsSyncedAt: payouts.transactionsSyncedAt,
  // Raw and table-qualified, for the RETURNING reason `CONVENTIONS.md` records.
  balanceTransactionPublicId: sql<string | null>`${sql.raw(
    `(select b.public_id from balance_transactions b where b.source_type = 'payout' and b.source_id = "payouts"."public_id" order by b.occurred_at limit 1)`,
  )}`,
  createdAt: payouts.createdAt,
  updatedAt: payouts.updatedAt,
} as const;

function toRow(row: Record<string, unknown>): PayoutRow {
  return row as unknown as PayoutRow;
}

/** The provider's fields of a payout — what every mirror write sets. */
function mirroredFields(payout: ProviderPayout) {
  return {
    amount: payout.amount,
    currency: payout.currency,
    status: payout.status,
    method: payout.method,
    type: payout.type,
    arrivalDate: payout.arrivalDate,
    description: payout.description,
    statementDescriptor: payout.statementDescriptor,
    failureCode: payout.failureCode,
    providerCreatedAt: payout.created,
  };
}

/**
 * Record a payout INSTRUCTION before the provider is called (the two-step every
 * money movement here uses): a crash between the two leaves a row a retry
 * resumes under the same idempotency key.
 */
export async function insertPayoutInstruction(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly connectedAccountId: string;
    readonly provider: string;
    readonly amount: string;
    readonly currency: string;
    readonly method: 'standard' | 'instant';
    readonly description: string | null;
    readonly statementDescriptor: string | null;
    readonly metadata: Record<string, string>;
  },
): Promise<PayoutRow> {
  const [row] = await db
    .insert(payouts)
    .values({
      id: uuidv7(),
      ...params,
      origin: 'merchant',
      automatic: false,
      status: 'pending',
    })
    .returning(PAYOUT_COLUMNS);
  if (!row) throw new Error('payout instruction insert returned no row');
  return toRow(row);
}

/** Bind an instruction to the provider's payout and take its fields. Fills the gap only. */
export async function linkPayoutInstruction(
  db: DatabaseOrTransaction,
  id: string,
  provider: string,
  payout: ProviderPayout,
): Promise<PayoutRow | null> {
  const [row] = await db
    .update(payouts)
    .set({ providerObjectId: payout.providerObjectId, ...mirroredFields(payout) })
    .where(
      and(eq(payouts.id, id), eq(payouts.provider, provider), isNull(payouts.providerObjectId)),
    )
    .returning(PAYOUT_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Mirror a provider payout: insert one this table has not seen (the account's
 * schedule created it), or overwrite the provider's fields of one it has.
 * Returns the row BEFORE (null when new) and after, so the caller can tell the
 * merchant what changed in the same transaction.
 */
export async function upsertProviderPayout(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly connectedAccountId: string;
    readonly provider: string;
    readonly payout: ProviderPayout;
  },
): Promise<{ before: PayoutRow | null; after: PayoutRow }> {
  const before = await findPayoutByProviderObject(
    db,
    params.provider,
    params.payout.providerObjectId,
    {
      forUpdate: true,
    },
  );
  if (before) {
    const [row] = await db
      .update(payouts)
      .set(mirroredFields(params.payout))
      .where(eq(payouts.id, before.id))
      .returning(PAYOUT_COLUMNS);
    if (!row) throw new Error(`payout ${before.publicId} vanished underneath the update`);
    return { before, after: toRow(row) };
  }
  const [row] = await db
    .insert(payouts)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      connectedAccountId: params.connectedAccountId,
      origin: params.payout.automatic ? 'provider' : 'merchant',
      automatic: params.payout.automatic,
      provider: params.provider,
      providerObjectId: params.payout.providerObjectId,
      ...mirroredFields(params.payout),
    })
    .onConflictDoNothing()
    .returning(PAYOUT_COLUMNS);
  if (row) return { before: null, after: toRow(row) };
  // A concurrent reader inserted it first: take its row and apply over it.
  return upsertProviderPayout(db, params);
}

export async function markPayoutTransactionsSynced(
  db: DatabaseOrTransaction,
  id: string,
  at: Date = new Date(),
): Promise<void> {
  await db.update(payouts).set({ transactionsSyncedAt: at }).where(eq(payouts.id, id));
}

export async function findPayoutByProviderObject(
  db: DatabaseOrTransaction,
  provider: string,
  providerObjectId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PayoutRow | null> {
  const query = db
    .select(PAYOUT_COLUMNS)
    .from(payouts)
    .where(and(eq(payouts.provider, provider), eq(payouts.providerObjectId, providerObjectId)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ? toRow(row) : null;
}

/** By `po_…`, scoped to the merchant and the account read through. */
export async function findPayoutByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  connectedAccountId: string,
  publicId: string,
): Promise<PayoutRow | null> {
  const [row] = await db
    .select(PAYOUT_COLUMNS)
    .from(payouts)
    .where(
      and(
        eq(payouts.merchantId, merchantId),
        eq(payouts.connectedAccountId, connectedAccountId),
        eq(payouts.publicId, publicId),
      ),
    );
  return row ? toRow(row) : null;
}

/** By `po_…` anywhere in the merchant — a `payout=` filter on the ledger. */
export async function findPayoutForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<PayoutRow | null> {
  const [row] = await db
    .select(PAYOUT_COLUMNS)
    .from(payouts)
    .where(and(eq(payouts.merchantId, merchantId), eq(payouts.publicId, publicId)));
  return row ? toRow(row) : null;
}

export async function listPayouts(
  db: DatabaseOrTransaction,
  merchantId: string,
  connectedAccountId: string,
  filter: { readonly status?: PayoutStatus },
  page: KeysetPage,
): Promise<{ data: PayoutRow[]; hasMore: boolean }> {
  const walk = keyset(payouts.id, payouts.createdAt, page);
  const rows = await db
    .select(PAYOUT_COLUMNS)
    .from(payouts)
    .where(
      and(
        eq(payouts.merchantId, merchantId),
        eq(payouts.connectedAccountId, connectedAccountId),
        filter.status !== undefined ? eq(payouts.status, filter.status) : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/** Every payout of an account created at or after `since` — the reconciliation window. */
export async function listPayoutsSince(
  db: DatabaseOrTransaction,
  connectedAccountId: string,
  since: Date,
): Promise<readonly PayoutRow[]> {
  const rows = await db
    .select(PAYOUT_COLUMNS)
    .from(payouts)
    .where(
      and(
        eq(payouts.connectedAccountId, connectedAccountId),
        sql`coalesce(${payouts.providerCreatedAt}, ${payouts.createdAt}) >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return rows.map(toRow);
}
