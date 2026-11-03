import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { customerEntitlementSummaries, entitlementFeatures, productFeatures } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { nowMs, requiredPublicIdOf } from './columns';

/** Reads and writes for entitlement features, their product attachments and summaries (ADR 0018 §6). */

export interface FeatureRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly lookupKey: string;
  readonly name: string;
  readonly active: boolean;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

const FEATURE_COLUMNS = {
  id: entitlementFeatures.id,
  publicId: entitlementFeatures.publicId,
  merchantId: entitlementFeatures.merchantId,
  livemode: merchantLivemodeOf(entitlementFeatures.merchantId),
  lookupKey: entitlementFeatures.lookupKey,
  name: entitlementFeatures.name,
  active: entitlementFeatures.active,
  metadata: entitlementFeatures.metadata,
  createdAt: entitlementFeatures.createdAt,
} as const;

/** `lookup_key_taken` when the merchant already has a feature with that key (ever). */
export async function insertFeature(
  tx: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly lookupKey: string;
    readonly name: string;
    readonly metadata: Record<string, string>;
  },
): Promise<FeatureRow | 'lookup_key_taken'> {
  const [row] = await tx
    .insert(entitlementFeatures)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(FEATURE_COLUMNS);
  return row ?? 'lookup_key_taken';
}

export async function findFeatureForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<FeatureRow | null> {
  const [row] = await db
    .select(FEATURE_COLUMNS)
    .from(entitlementFeatures)
    .where(
      and(
        eq(entitlementFeatures.publicId, publicId),
        eq(entitlementFeatures.merchantId, merchantId),
      ),
    );
  return row ?? null;
}

export async function updateFeature(
  tx: DatabaseOrTransaction,
  id: string,
  patch: {
    readonly name?: string | undefined;
    readonly active?: boolean | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<FeatureRow | 'limit_exceeded'> {
  const where = [eq(entitlementFeatures.id, id)];
  if (patch.metadata) {
    where.push(metadataWithinLimit(mergedMetadata(entitlementFeatures.metadata, patch.metadata)));
  }
  const [row] = await tx
    .update(entitlementFeatures)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.metadata
        ? { metadata: mergedMetadata(entitlementFeatures.metadata, patch.metadata) }
        : {}),
      updatedAt: nowMs,
    })
    .where(and(...where))
    .returning(FEATURE_COLUMNS);
  return row ?? 'limit_exceeded';
}

export async function listFeatures(
  db: DatabaseOrTransaction,
  filters: {
    readonly merchantId: string;
    readonly page: KeysetPage;
    readonly lookupKey?: string | undefined;
    readonly active?: boolean | undefined;
  },
): Promise<{ data: FeatureRow[]; hasMore: boolean }> {
  const walk = keyset(entitlementFeatures.id, entitlementFeatures.createdAt, filters.page);
  const rows = await db
    .select(FEATURE_COLUMNS)
    .from(entitlementFeatures)
    .where(
      and(
        eq(entitlementFeatures.merchantId, filters.merchantId),
        filters.lookupKey !== undefined
          ? eq(entitlementFeatures.lookupKey, filters.lookupKey)
          : undefined,
        filters.active !== undefined ? eq(entitlementFeatures.active, filters.active) : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export interface ProductFeatureRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly productId: string;
  readonly productPublicId: string;
  readonly featureId: string;
  readonly createdAt: Date;
}

const PF = 'product_features';
const PRODUCT_FEATURE_COLUMNS = {
  id: productFeatures.id,
  publicId: productFeatures.publicId,
  merchantId: productFeatures.merchantId,
  livemode: merchantLivemodeOf(productFeatures.merchantId),
  productId: productFeatures.productId,
  productPublicId: requiredPublicIdOf('products', PF, 'product_id'),
  featureId: productFeatures.featureId,
  createdAt: productFeatures.createdAt,
} as const;

/** `already_attached` when the product already grants the feature. */
export async function attachFeature(
  tx: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly productId: string;
    readonly featureId: string;
  },
): Promise<ProductFeatureRow | 'already_attached'> {
  const [row] = await tx
    .insert(productFeatures)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(PRODUCT_FEATURE_COLUMNS);
  return row ?? 'already_attached';
}

export async function findProductFeature(
  db: DatabaseOrTransaction,
  publicId: string,
  productId: string,
): Promise<ProductFeatureRow | null> {
  const [row] = await db
    .select(PRODUCT_FEATURE_COLUMNS)
    .from(productFeatures)
    .where(and(eq(productFeatures.publicId, publicId), eq(productFeatures.productId, productId)));
  return row ?? null;
}

export async function detachFeature(tx: DatabaseOrTransaction, id: string): Promise<void> {
  await tx.delete(productFeatures).where(eq(productFeatures.id, id));
}

export async function listProductFeatures(
  db: DatabaseOrTransaction,
  productId: string,
  page: KeysetPage,
): Promise<{ data: ProductFeatureRow[]; hasMore: boolean }> {
  const walk = keyset(productFeatures.id, productFeatures.createdAt, page);
  const rows = await db
    .select(PRODUCT_FEATURE_COLUMNS)
    .from(productFeatures)
    .where(and(eq(productFeatures.productId, productId), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export async function findFeaturesByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<FeatureRow[]> {
  if (ids.length === 0) return [];
  return db
    .select(FEATURE_COLUMNS)
    .from(entitlementFeatures)
    .where(inArray(entitlementFeatures.id, [...ids]))
    .orderBy(asc(entitlementFeatures.lookupKey));
}

/**
 * The ACTIVE features a customer holds now: granted by any product on any of
 * their `trialing`, `active` or `past_due` subscriptions (one row per feature,
 * however many products grant it), sorted by lookup key.
 */
export async function activeFeatureIdsForCustomer(
  db: DatabaseOrTransaction,
  customerId: string,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct f.id, f.lookup_key from entitlement_features f
    join product_features pf on pf.feature_id = f.id
    join prices p on p.product_id = pf.product_id
    join subscription_items si on si.price_id = p.id and si.deleted_at is null
    join subscriptions s on s.id = si.subscription_id
    where s.customer_id = ${customerId}
      and s.status in ('trialing', 'active', 'past_due')
      and f.active
    order by f.lookup_key`);
  return [...rows].map((row) => row.id);
}

/** The customers holding a subscription to `productId` — whose summary a feature change moves. */
export async function customersSubscribedToProduct(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<string[]> {
  const rows = await db.execute<{ customer_id: string }>(sql`
    select distinct s.customer_id from subscriptions s
    join subscription_items si on si.subscription_id = s.id and si.deleted_at is null
    join prices p on p.id = si.price_id
    where p.product_id = ${productId} and s.status in ('trialing', 'active', 'past_due')`);
  return [...rows].map((row) => row.customer_id);
}

/** The customers holding a subscription that grants `featureId`. */
export async function customersGrantedFeature(
  db: DatabaseOrTransaction,
  featureId: string,
): Promise<string[]> {
  const rows = await db.execute<{ customer_id: string }>(sql`
    select distinct s.customer_id from subscriptions s
    join subscription_items si on si.subscription_id = s.id and si.deleted_at is null
    join prices p on p.id = si.price_id
    join product_features pf on pf.product_id = p.product_id
    where pf.feature_id = ${featureId}`);
  return [...rows].map((row) => row.customer_id);
}

/**
 * Store the summary when it moved; `true` when it did. Locks the row, so two
 * transactions publishing the same customer serialize and the second compares
 * against the first's answer.
 */
export async function storeSummaryIfChanged(
  tx: Transaction,
  customerId: string,
  featureIds: readonly string[],
): Promise<boolean> {
  const [current] = await tx
    .select({ featureIds: customerEntitlementSummaries.featureIds })
    .from(customerEntitlementSummaries)
    .where(eq(customerEntitlementSummaries.customerId, customerId))
    .for('update');
  const next = [...featureIds];
  if (current && JSON.stringify(current.featureIds) === JSON.stringify(next)) return false;
  if (!current && next.length === 0) return false;
  await tx
    .insert(customerEntitlementSummaries)
    .values({ customerId, featureIds: next })
    .onConflictDoUpdate({
      target: customerEntitlementSummaries.customerId,
      set: { featureIds: next, updatedAt: nowMs },
    });
  return true;
}
