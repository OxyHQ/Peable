import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ProductMarketingFeature } from '@peable.to/shared-types';
import { uuidv7 } from '@oxy.so/db';
import { couponProducts, prices, products } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';

/**
 * Reads and writes for `products` (ADR 0018). Every read is scoped to the
 * merchant; a product id another merchant holds is the same answer as one
 * nobody holds.
 */

export interface ProductRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  /** The merchant's mode (ADR 0017). */
  readonly livemode: boolean;
  readonly active: boolean;
  readonly name: string;
  readonly description: string | null;
  readonly images: string[];
  readonly metadata: Record<string, string>;
  readonly taxCode: string | null;
  /** INTERNAL id of the default price. */
  readonly defaultPriceId: string | null;
  /** Its public `price_…`, what the wire calls `default_price`. */
  readonly defaultPricePublicId: string | null;
  readonly unitLabel: string | null;
  readonly url: string | null;
  readonly statementDescriptor: string | null;
  readonly marketingFeatures: ProductMarketingFeature[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Scalar subqueries rather than joins, so the same map serves SELECT and
 * RETURNING (`merchantLivemodeOf`'s reason).
 */
const PRODUCT_COLUMNS = {
  id: products.id,
  publicId: products.publicId,
  merchantId: products.merchantId,
  livemode: merchantLivemodeOf(products.merchantId),
  active: products.active,
  name: products.name,
  description: products.description,
  images: products.images,
  metadata: products.metadata,
  taxCode: products.taxCode,
  defaultPriceId: products.defaultPriceId,
  // Raw and table-qualified: RETURNING renders column refs unqualified
  // (CONVENTIONS.md §Catalog).
  defaultPricePublicId: sql<string | null>`(${sql.raw(
    'select p.public_id from prices p where p.id = "products"."default_price_id"',
  )})`,
  unitLabel: products.unitLabel,
  url: products.url,
  statementDescriptor: products.statementDescriptor,
  marketingFeatures: products.marketingFeatures,
  createdAt: products.createdAt,
  updatedAt: products.updatedAt,
} as const;

export interface InsertProductParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly active: boolean;
  readonly name: string;
  readonly description: string | null;
  readonly images: readonly string[];
  readonly metadata: Record<string, string>;
  readonly taxCode: string | null;
  readonly unitLabel: string | null;
  readonly url: string | null;
  readonly statementDescriptor: string | null;
  readonly marketingFeatures: readonly ProductMarketingFeature[];
}

export async function insertProduct(
  db: DatabaseOrTransaction,
  params: InsertProductParams,
): Promise<ProductRow> {
  const [row] = await db
    .insert(products)
    .values({
      id: uuidv7(),
      publicId: params.publicId,
      merchantId: params.merchantId,
      active: params.active,
      name: params.name,
      description: params.description,
      images: [...params.images],
      metadata: params.metadata,
      taxCode: params.taxCode,
      unitLabel: params.unitLabel,
      url: params.url,
      statementDescriptor: params.statementDescriptor,
      marketingFeatures: [...params.marketingFeatures],
    })
    .returning(PRODUCT_COLUMNS);
  if (!row) throw new Error('product insert returned no row');
  return row;
}

/** One product by its public `prod_…`, scoped to the merchant. */
export async function findProductForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<ProductRow | null> {
  const [row] = await db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(and(eq(products.publicId, publicId), eq(products.merchantId, merchantId)));
  return row ?? null;
}

/** The merchant's products among `publicIds` (any order; unknown ids are absent). */
export async function findProductsByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<ProductRow[]> {
  if (publicIds.length === 0) return [];
  return db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(and(eq(products.merchantId, merchantId), inArray(products.publicId, [...publicIds])));
}

/** Lock one product row for the rest of the transaction; `null` when it is not the merchant's. */
export async function lockProduct(
  tx: DatabaseOrTransaction,
  productId: string,
): Promise<ProductRow | null> {
  const [row] = await tx
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(eq(products.id, productId))
    .for('update', { of: products });
  return row ?? null;
}

export interface ProductListFilters {
  readonly merchantId: string;
  readonly page: KeysetPage;
  readonly active?: boolean | undefined;
  /** PUBLIC ids. */
  readonly ids?: readonly string[] | undefined;
}

/** One page of a merchant's products, newest first. */
export async function listProductsForMerchant(
  db: DatabaseOrTransaction,
  filters: ProductListFilters,
): Promise<{ data: ProductRow[]; hasMore: boolean }> {
  const walk = keyset(products.id, products.createdAt, filters.page);
  const rows = await db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(
      and(
        eq(products.merchantId, filters.merchantId),
        filters.active === undefined ? undefined : eq(products.active, filters.active),
        filters.ids === undefined ? undefined : inArray(products.publicId, [...filters.ids]),
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows);
}

export interface ProductPatch {
  readonly name?: string | undefined;
  readonly active?: boolean | undefined;
  /** `null` clears. */
  readonly description?: string | null | undefined;
  readonly images?: readonly string[] | undefined;
  readonly metadata?: MetadataPatch | undefined;
  readonly taxCode?: string | null | undefined;
  /** INTERNAL price id; `null` clears. The caller proved it is this product's and active. */
  readonly defaultPriceId?: string | null | undefined;
  readonly unitLabel?: string | null | undefined;
  readonly url?: string | null | undefined;
  readonly statementDescriptor?: string | null | undefined;
  readonly marketingFeatures?: readonly ProductMarketingFeature[] | undefined;
}

/**
 * Apply an update to a product the caller has LOCKED (`lockProduct`), in one
 * statement. `limit_exceeded` is the merged metadata over its key limit.
 */
export async function updateProduct(
  tx: DatabaseOrTransaction,
  productId: string,
  patch: ProductPatch,
): Promise<ProductRow | 'limit_exceeded'> {
  const values: Partial<typeof products.$inferInsert> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.active !== undefined) values.active = patch.active;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.images !== undefined) values.images = [...patch.images];
  if (patch.taxCode !== undefined) values.taxCode = patch.taxCode;
  if (patch.defaultPriceId !== undefined) values.defaultPriceId = patch.defaultPriceId;
  if (patch.unitLabel !== undefined) values.unitLabel = patch.unitLabel;
  if (patch.url !== undefined) values.url = patch.url;
  if (patch.statementDescriptor !== undefined) {
    values.statementDescriptor = patch.statementDescriptor;
  }
  if (patch.marketingFeatures !== undefined) {
    values.marketingFeatures = [...patch.marketingFeatures];
  }
  const merged = patch.metadata ? mergedMetadata(products.metadata, patch.metadata) : null;
  const scope = eq(products.id, productId);
  const [row] = await tx
    .update(products)
    .set({
      ...values,
      ...(merged ? { metadata: merged } : {}),
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(merged ? and(scope, metadataWithinLimit(merged)) : scope)
    .returning(PRODUCT_COLUMNS);
  return row ?? 'limit_exceeded';
}

/**
 * Delete a LOCKED product, unless something still names it: a price (archive
 * the product instead — Stripe's rule) or a coupon's `applies_to`.
 */
export async function deleteProduct(
  tx: DatabaseOrTransaction,
  productId: string,
): Promise<'deleted' | 'has_prices' | 'in_coupons'> {
  const [price] = await tx
    .select({ id: prices.id })
    .from(prices)
    .where(eq(prices.productId, productId))
    .limit(1);
  if (price) return 'has_prices';
  const [coupon] = await tx
    .select({ id: couponProducts.couponId })
    .from(couponProducts)
    .where(eq(couponProducts.productId, productId))
    .limit(1);
  if (coupon) return 'in_coupons';
  await tx.delete(products).where(eq(products.id, productId));
  return 'deleted';
}
