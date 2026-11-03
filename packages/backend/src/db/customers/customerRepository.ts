import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Address, Shipping } from '@peable.to/shared-types';
import { customerProviderBindings, customers, paymentMethods } from '../schema';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import type { DatabaseOrTransaction } from '../postgres';
import type { ProviderId } from '../../services/providers/provider';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { keyset, type KeysetPage } from '../keyset';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';

/**
 * Reads and writes for `customers` (ADR 0016) and their provider bindings.
 */
export interface CustomerRow {
  readonly livemode: boolean;
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly description: string | null;
  readonly address: Address | null;
  readonly shipping: Shipping | null;
  readonly defaultPaymentMethodId: string | null;
  /** The default method's public `pm_…`, read in the same statement. */
  readonly defaultPaymentMethodPublicId: string | null;
  readonly metadata: Record<string, string>;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const CUSTOMER_COLUMNS = {
  livemode: merchantLivemodeOf(customers.merchantId),
  id: customers.id,
  publicId: customers.publicId,
  merchantId: customers.merchantId,
  email: customers.email,
  name: customers.name,
  phone: customers.phone,
  description: customers.description,
  address: customers.address,
  shipping: customers.shipping,
  defaultPaymentMethodId: customers.defaultPaymentMethodId,
  defaultPaymentMethodPublicId: sql<
    string | null
  >`(select ${paymentMethods.publicId} from ${paymentMethods} where ${paymentMethods.id} = ${customers.defaultPaymentMethodId})`,
  metadata: customers.metadata,
  deletedAt: customers.deletedAt,
  createdAt: customers.createdAt,
  updatedAt: customers.updatedAt,
} as const;

/**
 * A live (not deleted) customer by `cus_…`, scoped to the merchant in the
 * predicate — what every create that NAMES a customer resolves through.
 */
export async function findLiveCustomerForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<CustomerRow | null> {
  const [row] = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(
      and(
        eq(customers.publicId, publicId),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt),
      ),
    );
  return (row as CustomerRow | undefined) ?? null;
}

/** The provider customer bound to this customer, or `null` before the first attach. */
export async function findCustomerBinding(
  db: DatabaseOrTransaction,
  customerId: string,
  provider: ProviderId,
): Promise<string | null> {
  const [row] = await db
    .select({ providerObjectId: customerProviderBindings.providerObjectId })
    .from(customerProviderBindings)
    .where(
      and(
        eq(customerProviderBindings.customerId, customerId),
        eq(customerProviderBindings.provider, provider),
      ),
    );
  return row?.providerObjectId ?? null;
}

/**
 * Record the provider customer a customer is bound to. `on conflict do
 * nothing`: two concurrent first attaches both create at the provider with the
 * SAME idempotency key (`ensureProviderCustomer`), so they hold the same id and
 * either insert is the right one. Returns the binding that stands.
 */
export async function insertCustomerBinding(
  db: DatabaseOrTransaction,
  params: {
    readonly customerId: string;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
  },
): Promise<string> {
  await db
    .insert(customerProviderBindings)
    .values({
      id: uuidv7(),
      customerId: params.customerId,
      provider: params.provider,
      providerObjectId: params.providerObjectId,
    })
    .onConflictDoNothing({
      target: [customerProviderBindings.customerId, customerProviderBindings.provider],
    });
  return (
    (await findCustomerBinding(db, params.customerId, params.provider)) ?? params.providerObjectId
  );
}

/**
 * Several customers by public id, merchant-scoped — the `expand[]` loader. A
 * deleted customer is still returned: an intent that names one expands to the
 * tombstone, as on Stripe.
 */
export async function findCustomersForMerchantByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<CustomerRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(and(eq(customers.merchantId, merchantId), inArray(customers.publicId, [...publicIds])));
  return rows as CustomerRow[];
}

/** `cus_…` scoped to the merchant, deleted or not — the retrieve (a tombstone answers `deleted: true`). */
export async function findCustomerForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<CustomerRow | null> {
  const [row] = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(and(eq(customers.publicId, publicId), eq(customers.merchantId, merchantId)));
  return (row as CustomerRow | undefined) ?? null;
}

/** By INTERNAL id — the reference a SetupIntent or a payment method holds. */
export async function findCustomerById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CustomerRow | null> {
  const [row] = await db.select(CUSTOMER_COLUMNS).from(customers).where(eq(customers.id, id));
  return (row as CustomerRow | undefined) ?? null;
}

/** The fields a create or update writes. `null` clears; absent leaves as is. */
export interface CustomerFields {
  readonly email?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly description?: string | null;
  readonly address?: Address | null;
  readonly shipping?: Shipping | null;
}

function fieldValues(fields: CustomerFields) {
  return {
    ...(fields.email !== undefined ? { email: fields.email } : {}),
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.address !== undefined ? { address: fields.address } : {}),
    ...(fields.shipping !== undefined ? { shipping: fields.shipping } : {}),
  };
}

export async function insertCustomer(
  db: DatabaseOrTransaction,
  params: CustomerFields & {
    readonly publicId: string;
    readonly merchantId: string;
    readonly metadata: Record<string, string>;
  },
): Promise<CustomerRow> {
  const [row] = await db
    .insert(customers)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      metadata: params.metadata,
      ...fieldValues(params),
    })
    .returning(CUSTOMER_COLUMNS);
  if (!row) throw new Error(`customer ${params.publicId} was not inserted`);
  return row as CustomerRow;
}

/**
 * Update a LIVE customer's own fields, metadata merged in the same statement
 * (`db/metadata.ts`). `defaultPaymentMethodId` must name one of the customer's
 * own attached methods — the composite reference refuses anything else; the
 * caller checks first so the answer is a 400 rather than a constraint.
 */
export async function updateCustomer(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
  patch: CustomerFields & {
    readonly metadata?: MetadataPatch | undefined;
    readonly defaultPaymentMethodId?: string | null | undefined;
  },
): Promise<CustomerRow | 'missing' | 'limit_exceeded'> {
  const scope = and(
    eq(customers.publicId, publicId),
    eq(customers.merchantId, merchantId),
    isNull(customers.deletedAt),
  );
  const merged =
    patch.metadata === undefined ? undefined : mergedMetadata(customers.metadata, patch.metadata);
  const [row] = await db
    .update(customers)
    .set({
      ...fieldValues(patch),
      ...(merged !== undefined ? { metadata: merged } : {}),
      ...(patch.defaultPaymentMethodId !== undefined
        ? { defaultPaymentMethodId: patch.defaultPaymentMethodId }
        : {}),
      // `$onUpdate` maintains `updated_at`; an all-absent patch still touches it.
    })
    .where(and(scope, merged === undefined ? undefined : metadataWithinLimit(merged)))
    .returning(CUSTOMER_COLUMNS);
  if (row) return row as CustomerRow;
  const [exists] = await db.select({ id: customers.id }).from(customers).where(scope);
  return exists ? 'limit_exceeded' : 'missing';
}

/**
 * Tombstone a customer: its default cleared, every attached method detached,
 * and `deleted_at` stamped — in the CALLER's transaction, so the three commit
 * together. Returns the customer as it was and the methods it detached, or
 * `null` when there is no live customer by that id.
 */
export async function tombstoneCustomer(
  tx: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<{ customer: CustomerRow; detachedMethodIds: string[] } | null> {
  const [locked] = await tx
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(
      and(
        eq(customers.publicId, publicId),
        eq(customers.merchantId, merchantId),
        isNull(customers.deletedAt),
      ),
    )
    .for('update');
  if (!locked) return null;
  const customer = locked as CustomerRow;
  // The default first: `customers_default_payment_method_fkey` references
  // `(id, customer_id)`, so a method cannot lose its customer while named.
  await tx
    .update(customers)
    .set({ defaultPaymentMethodId: null })
    .where(eq(customers.id, customer.id));
  const detached = await tx
    .update(paymentMethods)
    .set({ customerId: null, detachedAt: sql`date_trunc('milliseconds', now())` })
    .where(eq(paymentMethods.customerId, customer.id))
    .returning({ id: paymentMethods.id });
  await tx
    .update(customers)
    .set({ deletedAt: sql`date_trunc('milliseconds', now())` })
    .where(eq(customers.id, customer.id));
  return { customer, detachedMethodIds: detached.map((row) => row.id) };
}

/** One page of a merchant's LIVE customers, newest first, optionally by exact email. */
export async function listCustomersForMerchant(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly email?: string | undefined;
    readonly page: KeysetPage;
  },
): Promise<{ data: CustomerRow[]; hasMore: boolean }> {
  const walk = keyset(customers.id, customers.createdAt, params.page);
  const rows = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(
      and(
        eq(customers.merchantId, params.merchantId),
        isNull(customers.deletedAt),
        params.email === undefined ? undefined : eq(customers.email, params.email),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows as CustomerRow[]);
}
