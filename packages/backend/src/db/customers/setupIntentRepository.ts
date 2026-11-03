import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  PaymentIntentLastPaymentError,
  SetupIntentCancellationReason,
  SetupIntentStatus,
  SetupIntentUsage,
} from '@peable.to/shared-types';
import { customers, paymentMethods, setupIntents } from '../schema';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import type { ProviderId } from '../../services/providers/provider';

/**
 * Reads and writes for `setup_intents` (ADR 0016, ADR 0019). Every status write
 * is a compare-and-swap on the status it was decided from — the same rule
 * `updateIntentState` enforces for payment intents.
 */
export interface SetupIntentRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly status: SetupIntentStatus;
  readonly usage: SetupIntentUsage;
  readonly clientSecret: string;
  readonly description: string | null;
  readonly metadata: Record<string, string>;
  readonly lastSetupError: PaymentIntentLastPaymentError | null;
  readonly cancellationReason: SetupIntentCancellationReason | null;
  readonly paymentMethodId: string | null;
  readonly paymentMethodPublicId: string | null;
  readonly provider: ProviderId;
  readonly providerObjectId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SETUP_INTENT_COLUMNS = {
  livemode: merchantLivemodeOf(setupIntents.merchantId),
  id: setupIntents.id,
  publicId: setupIntents.publicId,
  merchantId: setupIntents.merchantId,
  customerId: setupIntents.customerId,
  customerPublicId: sql<string>`(select ${customers.publicId} from ${customers} where ${customers.id} = ${setupIntents.customerId})`,
  status: setupIntents.status,
  usage: setupIntents.usage,
  clientSecret: setupIntents.clientSecret,
  description: setupIntents.description,
  metadata: setupIntents.metadata,
  lastSetupError: setupIntents.lastSetupError,
  cancellationReason: setupIntents.cancellationReason,
  paymentMethodId: setupIntents.paymentMethodId,
  paymentMethodPublicId: sql<
    string | null
  >`(select ${paymentMethods.publicId} from ${paymentMethods} where ${paymentMethods.id} = ${setupIntents.paymentMethodId})`,
  provider: setupIntents.provider,
  providerObjectId: setupIntents.providerObjectId,
  createdAt: setupIntents.createdAt,
  updatedAt: setupIntents.updatedAt,
} as const;

function toRow(row: unknown): SetupIntentRow {
  return row as SetupIntentRow;
}

export async function insertSetupIntent(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly customerId: string;
    readonly usage: SetupIntentUsage;
    readonly clientSecret: string;
    readonly description: string | null;
    readonly metadata: Record<string, string>;
    readonly provider: ProviderId;
  },
): Promise<SetupIntentRow> {
  const [row] = await db
    .insert(setupIntents)
    .values({ id: uuidv7(), status: 'requires_payment_method', ...params })
    .returning(SETUP_INTENT_COLUMNS);
  if (!row) throw new Error(`setup intent ${params.publicId} was not inserted`);
  return toRow(row);
}

/** Fill the provider binding, once — never repoint it (the `linkProviderObject` rule). */
export async function linkSetupIntentObject(
  db: DatabaseOrTransaction,
  id: string,
  providerObjectId: string,
): Promise<boolean> {
  const rows = await db
    .update(setupIntents)
    .set({ providerObjectId })
    .where(and(eq(setupIntents.id, id), isNull(setupIntents.providerObjectId)))
    .returning({ id: setupIntents.id });
  return rows.length === 1;
}

/** `seti_…` scoped to the merchant in the predicate. */
export async function findSetupIntentForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<SetupIntentRow | null> {
  const [row] = await db
    .select(SETUP_INTENT_COLUMNS)
    .from(setupIntents)
    .where(and(eq(setupIntents.publicId, publicId), eq(setupIntents.merchantId, merchantId)));
  return row ? toRow(row) : null;
}

/** The PAYER path: `seti_…` alone, authorized by `client_secret` rather than by ownership. */
export async function findSetupIntentByPublicId(
  db: DatabaseOrTransaction,
  publicId: string,
): Promise<SetupIntentRow | null> {
  const [row] = await db
    .select(SETUP_INTENT_COLUMNS)
    .from(setupIntents)
    .where(eq(setupIntents.publicId, publicId));
  return row ? toRow(row) : null;
}

export async function findSetupIntentById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<SetupIntentRow | null> {
  const [row] = await db
    .select(SETUP_INTENT_COLUMNS)
    .from(setupIntents)
    .where(eq(setupIntents.id, id));
  return row ? toRow(row) : null;
}

/** The drain's lookup: which SetupIntent is this provider object? */
export async function findSetupIntentByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string,
): Promise<SetupIntentRow | null> {
  const [row] = await db
    .select(SETUP_INTENT_COLUMNS)
    .from(setupIntents)
    .where(
      and(eq(setupIntents.provider, provider), eq(setupIntents.providerObjectId, providerObjectId)),
    );
  return row ? toRow(row) : null;
}

export async function listSetupIntentsForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly customerId?: string | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: SetupIntentRow[]; hasMore: boolean }> {
  const walk = keyset(setupIntents.id, setupIntents.createdAt, params.page);
  const rows = await db
    .select(SETUP_INTENT_COLUMNS)
    .from(setupIntents)
    .where(
      and(
        eq(setupIntents.merchantId, params.merchantId),
        params.customerId === undefined
          ? undefined
          : eq(setupIntents.customerId, params.customerId),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

export interface SetupIntentStateChange {
  /** The compare half: the status this change was decided from. */
  readonly from: SetupIntentStatus;
  readonly status: SetupIntentStatus;
  /** Written by every change; absent clears it. */
  readonly lastSetupError?: PaymentIntentLastPaymentError | undefined;
  readonly cancellationReason?: SetupIntentCancellationReason | undefined;
  /** Required with `succeeded` — `setup_intents_succeeded_saved_a_method_check`. */
  readonly paymentMethodId?: string | undefined;
}

export type SetupIntentStateResult =
  | { readonly kind: 'updated'; readonly row: SetupIntentRow }
  | { readonly kind: 'stale'; readonly current: SetupIntentStatus }
  | { readonly kind: 'missing' };

/** Advance a SetupIntent, compare-and-swap on `status = from`, in the caller's db. */
export async function updateSetupIntentState(
  db: DatabaseOrTransaction,
  id: string,
  change: SetupIntentStateChange,
): Promise<SetupIntentStateResult> {
  const [row] = await db
    .update(setupIntents)
    .set({
      status: change.status,
      lastSetupError: change.lastSetupError ?? null,
      cancellationReason: change.status === 'canceled' ? (change.cancellationReason ?? null) : null,
      paymentMethodId: change.status === 'succeeded' ? (change.paymentMethodId ?? null) : null,
    })
    .where(and(eq(setupIntents.id, id), eq(setupIntents.status, change.from)))
    .returning(SETUP_INTENT_COLUMNS);
  if (row) return { kind: 'updated', row: toRow(row) };
  const [current] = await db
    .select({ status: setupIntents.status })
    .from(setupIntents)
    .where(eq(setupIntents.id, id));
  if (!current) return { kind: 'missing' };
  return { kind: 'stale', current: current.status as SetupIntentStatus };
}

/** The merchant's SetupIntents among these `seti_…` (an expansion's loader). */
export async function findSetupIntentsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<SetupIntentRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(SETUP_INTENT_COLUMNS)
    .from(setupIntents)
    .where(
      and(eq(setupIntents.merchantId, merchantId), inArray(setupIntents.publicId, [...publicIds])),
    );
  return rows.map(toRow);
}
