import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { BillingDetails, CardDetails } from '@peable.to/shared-types';
import { customers, paymentMethods } from '../schema';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import type { ProviderId } from '../../services/providers/provider';

/**
 * Reads and writes for `payment_methods` (ADR 0016): Peable's `pm_…` over a
 * provider payment method, which stays a binding (`provider_object_id`) that
 * never reaches the wire.
 */
export interface PaymentMethodRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly customerId: string | null;
  readonly customerPublicId: string | null;
  readonly type: 'card';
  readonly card: CardDetails;
  readonly billingDetails: BillingDetails;
  readonly provider: ProviderId;
  readonly providerObjectId: string;
  readonly metadata: Record<string, string>;
  readonly detachedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const PAYMENT_METHOD_COLUMNS = {
  livemode: merchantLivemodeOf(paymentMethods.merchantId),
  id: paymentMethods.id,
  publicId: paymentMethods.publicId,
  merchantId: paymentMethods.merchantId,
  customerId: paymentMethods.customerId,
  customerPublicId: sql<
    string | null
  >`(select ${customers.publicId} from ${customers} where ${customers.id} = ${paymentMethods.customerId})`,
  type: paymentMethods.type,
  card: paymentMethods.card,
  billingDetails: paymentMethods.billingDetails,
  provider: paymentMethods.provider,
  providerObjectId: paymentMethods.providerObjectId,
  metadata: paymentMethods.metadata,
  detachedAt: paymentMethods.detachedAt,
  createdAt: paymentMethods.createdAt,
  updatedAt: paymentMethods.updatedAt,
} as const;

/** `pm_…` scoped to the merchant in the predicate. */
export async function findPaymentMethodForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<PaymentMethodRow | null> {
  const [row] = await db
    .select(PAYMENT_METHOD_COLUMNS)
    .from(paymentMethods)
    .where(and(eq(paymentMethods.publicId, publicId), eq(paymentMethods.merchantId, merchantId)));
  return (row as PaymentMethodRow | undefined) ?? null;
}

/** By INTERNAL id — the reference an intent holds. Unscoped: the intent already is. */
export async function findPaymentMethodById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<PaymentMethodRow | null> {
  const [row] = await db
    .select(PAYMENT_METHOD_COLUMNS)
    .from(paymentMethods)
    .where(eq(paymentMethods.id, id));
  return (row as PaymentMethodRow | undefined) ?? null;
}

/** Several payment methods by public id, merchant-scoped — the `expand[]` loader. */
export async function findPaymentMethodsForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<PaymentMethodRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(PAYMENT_METHOD_COLUMNS)
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.merchantId, merchantId),
        inArray(paymentMethods.publicId, [...publicIds]),
      ),
    );
  return rows as PaymentMethodRow[];
}

/** The provider object's registration, if it has one — the idempotency of saving a card. */
export async function findPaymentMethodByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string,
): Promise<PaymentMethodRow | null> {
  const [row] = await db
    .select(PAYMENT_METHOD_COLUMNS)
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.provider, provider),
        eq(paymentMethods.providerObjectId, providerObjectId),
      ),
    );
  return (row as PaymentMethodRow | undefined) ?? null;
}

/**
 * Register a provider payment method as a Peable `pm_…`, attached to a customer.
 *
 * `on conflict (provider, provider_object_id) do nothing`: one provider method
 * is ONE `pm_…`, so a SetupIntent event redelivered, or a payment's saved card
 * read twice, converges on the first registration. `created` says whether this
 * call made it — only a creation is `payment_method.attached`.
 */
export async function registerPaymentMethod(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly customerId: string;
    readonly card: CardDetails;
    readonly billingDetails: BillingDetails;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
  },
): Promise<{ row: PaymentMethodRow; created: boolean }> {
  const [inserted] = await db
    .insert(paymentMethods)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      customerId: params.customerId,
      type: 'card',
      card: params.card,
      billingDetails: params.billingDetails,
      provider: params.provider,
      providerObjectId: params.providerObjectId,
    })
    .onConflictDoNothing({ target: [paymentMethods.provider, paymentMethods.providerObjectId] })
    .returning(PAYMENT_METHOD_COLUMNS);
  if (inserted) return { row: inserted as PaymentMethodRow, created: true };
  const existing = await findPaymentMethodByProviderObject(
    db,
    params.provider,
    params.providerObjectId,
  );
  if (!existing)
    throw new Error(`payment method ${params.providerObjectId} neither inserted nor found`);
  return { row: existing, created: false };
}

/**
 * Detach a method — permanently: it names no customer and can never be used
 * again (Stripe's model). The customer's default is cleared first, in the
 * CALLER's transaction, because the default references `(id, customer_id)`.
 *
 * @returns the detached row, or `null` when it was not attached.
 */
export async function detachPaymentMethod(
  tx: DatabaseOrTransaction,
  id: string,
): Promise<PaymentMethodRow | null> {
  await tx
    .update(customers)
    .set({ defaultPaymentMethodId: null })
    .where(eq(customers.defaultPaymentMethodId, id));
  const [row] = await tx
    .update(paymentMethods)
    .set({ customerId: null, detachedAt: sql`date_trunc('milliseconds', now())` })
    .where(and(eq(paymentMethods.id, id), isNull(paymentMethods.detachedAt)))
    .returning(PAYMENT_METHOD_COLUMNS);
  return (row as PaymentMethodRow | undefined) ?? null;
}

/** Billing details (replaced whole) and metadata (patched), scoped to the merchant. */
export async function updatePaymentMethod(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: {
    readonly billingDetails?: BillingDetails | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<PaymentMethodRow | 'missing' | 'limit_exceeded'> {
  const scope = and(
    eq(paymentMethods.publicId, publicId),
    eq(paymentMethods.merchantId, merchantId),
  );
  const merged =
    patch.metadata === undefined
      ? undefined
      : mergedMetadata(paymentMethods.metadata, patch.metadata);
  const [row] = await db
    .update(paymentMethods)
    .set({
      ...(patch.billingDetails !== undefined ? { billingDetails: patch.billingDetails } : {}),
      ...(merged !== undefined ? { metadata: merged } : {}),
    })
    .where(and(scope, merged === undefined ? undefined : metadataWithinLimit(merged)))
    .returning(PAYMENT_METHOD_COLUMNS);
  if (row) return row as PaymentMethodRow;
  const [exists] = await db.select({ id: paymentMethods.id }).from(paymentMethods).where(scope);
  return exists ? 'limit_exceeded' : 'missing';
}

/** One page of a customer's ATTACHED methods, newest first. */
export async function listPaymentMethodsForCustomer(
  db: DatabaseOrTransaction,
  params: { readonly customerId: string; readonly page: KeysetPage },
): Promise<{ data: PaymentMethodRow[]; hasMore: boolean }> {
  const walk = keyset(paymentMethods.id, paymentMethods.createdAt, params.page);
  const rows = await db
    .select(PAYMENT_METHOD_COLUMNS)
    .from(paymentMethods)
    .where(and(eq(paymentMethods.customerId, params.customerId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows as PaymentMethodRow[]);
}

/** Several methods by INTERNAL id — the ones a customer deletion detached. */
export async function findPaymentMethodsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<PaymentMethodRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(PAYMENT_METHOD_COLUMNS)
    .from(paymentMethods)
    .where(inArray(paymentMethods.id, [...ids]));
  return rows as PaymentMethodRow[];
}
