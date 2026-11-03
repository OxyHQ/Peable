/**
 * Reads and writes for `application_fees` and `application_fee_refunds` —
 * Orbit's fee as the provider took it (ADR 0015 §3). Both are written only from
 * the provider's own fee object; `amount_refunded` is the sum of the refund
 * rows, read in the same statement and never stored.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import {
  applicationFeeRefunds,
  applicationFees,
  connectedAccounts,
  paymentIntents,
} from '../schema';
import { keyset, type KeysetPage } from '../keyset';
import type { DatabaseOrTransaction } from '../postgres';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';

export interface ApplicationFeeRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly paymentIntentPublicId: string;
  readonly chargePublicId: string | null;
  readonly connectedAccountId: string;
  readonly connectedAccountPublicId: string;
  readonly amount: string;
  readonly amountRefunded: string;
  readonly currency: string;
  readonly provider: string;
  readonly providerObjectId: string;
  readonly createdAt: Date;
}

export interface FeeRefundRow {
  readonly id: string;
  readonly publicId: string;
  readonly applicationFeeId: string;
  readonly applicationFeePublicId: string;
  readonly amount: string;
  readonly currency: string;
  readonly createdAt: Date;
}

const FEE_COLUMNS = {
  livemode: merchantLivemodeOf(applicationFees.merchantId),
  id: applicationFees.id,
  publicId: applicationFees.publicId,
  merchantId: applicationFees.merchantId,
  paymentIntentId: applicationFees.paymentIntentId,
  paymentIntentPublicId: sql<string>`(select ${paymentIntents.publicId} from ${paymentIntents} where ${paymentIntents.id} = ${applicationFees.paymentIntentId})`,
  chargePublicId: sql<string | null>`${sql.raw(
    '(select ch.public_id from charges ch where ch.payment_intent_id = "application_fees"."payment_intent_id")',
  )}`,
  connectedAccountId: applicationFees.connectedAccountId,
  connectedAccountPublicId: sql<string>`(select ${connectedAccounts.publicId} from ${connectedAccounts} where ${connectedAccounts.id} = ${applicationFees.connectedAccountId})`,
  amount: applicationFees.amount,
  amountRefunded: sql<string>`${sql.raw(
    '(select coalesce(sum(r.amount::numeric), 0)::text from application_fee_refunds r where r.application_fee_id = "application_fees"."id")',
  )}`,
  currency: applicationFees.currency,
  provider: applicationFees.provider,
  providerObjectId: applicationFees.providerObjectId,
  createdAt: applicationFees.createdAt,
} as const;

const REFUND_COLUMNS = {
  id: applicationFeeRefunds.id,
  publicId: applicationFeeRefunds.publicId,
  applicationFeeId: applicationFeeRefunds.applicationFeeId,
  applicationFeePublicId: sql<string>`(select ${applicationFees.publicId} from ${applicationFees} where ${applicationFees.id} = ${applicationFeeRefunds.applicationFeeId})`,
  amount: applicationFeeRefunds.amount,
  currency: applicationFeeRefunds.currency,
  createdAt: applicationFeeRefunds.createdAt,
} as const;

function toFee(row: Record<string, unknown>): ApplicationFeeRow {
  return row as unknown as ApplicationFeeRow;
}
function toRefund(row: Record<string, unknown>): FeeRefundRow {
  return row as unknown as FeeRefundRow;
}

/**
 * Record a fee the provider took. `created: false` when it was already
 * recorded (`application_fees_provider_object_key`) — a redelivered event.
 */
export async function insertApplicationFee(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly paymentIntentId: string;
    readonly connectedAccountId: string;
    readonly amount: string;
    readonly currency: string;
    readonly provider: string;
    readonly providerObjectId: string;
  },
): Promise<{ fee: ApplicationFeeRow; created: boolean }> {
  const [row] = await db
    .insert(applicationFees)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(FEE_COLUMNS);
  if (row) return { fee: toFee(row), created: true };
  const existing = await findFeeByProviderObject(db, params.provider, params.providerObjectId);
  if (!existing) {
    throw new Error(
      `application fee for payment ${params.paymentIntentId} conflicted with a different provider fee`,
    );
  }
  return { fee: existing, created: false };
}

/** Record a fee refund; `false` when it was already recorded. */
export async function insertFeeRefund(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly applicationFeeId: string;
    readonly amount: string;
    readonly currency: string;
    readonly provider: string;
    readonly providerObjectId: string;
    readonly createdAt: Date;
  },
): Promise<boolean> {
  const inserted = await db
    .insert(applicationFeeRefunds)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning({ id: applicationFeeRefunds.id });
  return inserted.length > 0;
}

export async function findFeeByProviderObject(
  db: DatabaseOrTransaction,
  provider: string,
  providerObjectId: string,
): Promise<ApplicationFeeRow | null> {
  const [row] = await db
    .select(FEE_COLUMNS)
    .from(applicationFees)
    .where(
      and(
        eq(applicationFees.provider, provider),
        eq(applicationFees.providerObjectId, providerObjectId),
      ),
    );
  return row ? toFee(row) : null;
}

export async function findFeeByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string,
): Promise<ApplicationFeeRow | null> {
  const [row] = await db
    .select(FEE_COLUMNS)
    .from(applicationFees)
    .where(and(eq(applicationFees.merchantId, merchantId), eq(applicationFees.publicId, publicId)));
  return row ? toFee(row) : null;
}

export async function findFeeForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string,
): Promise<ApplicationFeeRow | null> {
  const [row] = await db
    .select(FEE_COLUMNS)
    .from(applicationFees)
    .where(eq(applicationFees.paymentIntentId, paymentIntentId));
  return row ? toFee(row) : null;
}

export async function listApplicationFees(
  db: DatabaseOrTransaction,
  merchantId: string,
  filter: { readonly paymentIntentId?: string },
  page: KeysetPage,
): Promise<{ data: ApplicationFeeRow[]; hasMore: boolean }> {
  const walk = keyset(applicationFees.id, applicationFees.createdAt, page);
  const rows = await db
    .select(FEE_COLUMNS)
    .from(applicationFees)
    .where(
      and(
        eq(applicationFees.merchantId, merchantId),
        filter.paymentIntentId !== undefined
          ? eq(applicationFees.paymentIntentId, filter.paymentIntentId)
          : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toFee));
}

/** Every refund of one fee, oldest first — a fee carries few. */
export async function listFeeRefunds(
  db: DatabaseOrTransaction,
  applicationFeeId: string,
): Promise<FeeRefundRow[]> {
  const rows = await db
    .select(REFUND_COLUMNS)
    .from(applicationFeeRefunds)
    .where(eq(applicationFeeRefunds.applicationFeeId, applicationFeeId))
    .orderBy(asc(applicationFeeRefunds.createdAt));
  return rows.map(toRefund);
}
