/**
 * Entitlements (ADR 0018 §6): the authoritative access answer an app asks.
 *
 * A feature (`feat_…`, a `lookup_key` such as `mention_plus`) is attached to
 * products; a customer is entitled to it while ANY product granting it is on a
 * `trialing`, `active` or `past_due` subscription of theirs. "Mention Plus is
 * granted by the Plus product AND by Oxy One" is two attachments of one
 * feature, and a customer holding both still has ONE entitlement — so buying
 * One never requires buying Plus again, and cancelling one of the two keeps
 * access while the other stands.
 *
 * `entitlements.active_entitlement_summary.updated` is recorded in the
 * transaction of whatever moved the answer (a subscription status, its items,
 * an attachment), and only when the set of features actually changed.
 */
import { createHash } from 'node:crypto';
import type {
  ActiveEntitlement,
  ActiveEntitlementSummary,
  EntitlementFeature,
  ProductFeature,
} from '@peable.to/shared-types';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import {
  activeFeatureIdsForCustomer,
  attachFeature,
  customersGrantedFeature,
  customersSubscribedToProduct,
  detachFeature,
  findFeatureForMerchant,
  findFeaturesByIds,
  findProductFeature,
  insertFeature,
  storeSummaryIfChanged,
  updateFeature,
  type FeatureRow,
  type ProductFeatureRow,
} from '../../db/billingEngine/entitlementRepository';
import { findProductForMerchant } from '../../db/catalog/productRepository';
import { customers } from '../../db/schema';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import { type DatabaseOrTransaction, getDb, type Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toUnix } from '../../lib/time';
import { recordEvent } from '../events';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError, invalid, missing } from './errors';
import { eq } from 'drizzle-orm';

export function toFeatureDTO(row: FeatureRow): EntitlementFeature {
  return {
    id: row.publicId,
    object: 'entitlements.feature',
    livemode: row.livemode,
    lookup_key: row.lookupKey,
    name: row.name,
    active: row.active,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

export function toProductFeatureDTO(row: ProductFeatureRow, feature: FeatureRow): ProductFeature {
  return {
    id: row.publicId,
    object: 'product_feature',
    livemode: row.livemode,
    product: row.productPublicId,
    entitlement_feature: toFeatureDTO(feature),
  };
}

/** Stable per customer and feature: the same access always has the same id. */
function entitlementId(customerPublicId: string, featurePublicId: string): string {
  const digest = createHash('sha256')
    .update(`${customerPublicId}:${featurePublicId}`)
    .digest('hex');
  return `ent_${digest.slice(0, 24)}`;
}

function toActiveEntitlement(customerPublicId: string, feature: FeatureRow): ActiveEntitlement {
  return {
    id: entitlementId(customerPublicId, feature.publicId),
    object: 'entitlements.active_entitlement',
    livemode: feature.livemode,
    feature: feature.publicId,
    lookup_key: feature.lookupKey,
  };
}

/** What a customer is entitled to right now, sorted by lookup key. */
export async function activeEntitlements(
  db: DatabaseOrTransaction,
  customer: { readonly id: string; readonly publicId: string },
): Promise<ActiveEntitlement[]> {
  const ids = await activeFeatureIdsForCustomer(db, customer.id);
  const features = await findFeaturesByIds(db, ids);
  return features.map((feature) => toActiveEntitlement(customer.publicId, feature));
}

/**
 * Recompute one customer's summary and, when it moved, store it and record
 * `entitlements.active_entitlement_summary.updated` — on the caller's
 * transaction, the one that moved it.
 */
export async function refreshEntitlementSummary(
  tx: Transaction,
  merchantId: string,
  customerId: string,
): Promise<void> {
  const ids = await activeFeatureIdsForCustomer(tx, customerId);
  if (!(await storeSummaryIfChanged(tx, customerId, ids))) return;
  const [customer] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, customerId));
  const merchant = await findMerchantById(tx, merchantId);
  if (!customer || !merchant) throw new Error('customer or merchant vanished');
  const features = await findFeaturesByIds(tx, ids);
  const summary: ActiveEntitlementSummary = {
    object: 'entitlements.active_entitlement_summary',
    livemode: merchant.livemode,
    customer: customer.publicId,
    entitlements: {
      object: 'list',
      data: features.map((feature) => toActiveEntitlement(customer.publicId, feature)),
      has_more: false,
      url: `/v1/entitlements/active_entitlements?customer=${customer.publicId}`,
    },
  };
  await recordEvent(tx, {
    merchantId,
    type: 'entitlements.active_entitlement_summary.updated',
    object: summary,
  });
}

async function refreshMany(tx: Transaction, merchantId: string, customerIds: readonly string[]) {
  for (const customerId of customerIds) await refreshEntitlementSummary(tx, merchantId, customerId);
}

async function committed<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const result = await getDb().transaction(work);
  kickWebhookOutbox();
  return result;
}

export async function createFeature(
  merchant: MerchantRow,
  input: { lookupKey: string; name: string; metadata: Record<string, string> },
): Promise<FeatureRow> {
  const row = await insertFeature(getDb(), {
    publicId: newId('feat'),
    merchantId: merchant.id,
    ...input,
  });
  if (row === 'lookup_key_taken') {
    throw new BillingEngineError(
      'feature_lookup_key_taken',
      'a feature with this lookup_key exists; lookup keys are never reused',
      'lookup_key',
    );
  }
  return row;
}

/** Archiving a feature (`active: false`) withdraws it from every summary that held it. */
export async function updateFeatureFields(
  merchant: MerchantRow,
  publicId: string,
  patch: { name?: string; active?: boolean; metadata?: MetadataPatch },
): Promise<FeatureRow> {
  return committed(async (tx) => {
    const feature = await findFeatureForMerchant(tx, publicId, merchant.id);
    if (!feature) throw missing('feature');
    const updated = await updateFeature(tx, feature.id, patch);
    if (updated === 'limit_exceeded') throw invalid('metadata limit exceeded', 'metadata');
    if (patch.active !== undefined && patch.active !== feature.active) {
      await refreshMany(tx, merchant.id, await customersGrantedFeature(tx, feature.id));
    }
    return updated;
  });
}

export async function attachProductFeature(
  merchant: MerchantRow,
  productPublicId: string,
  featurePublicId: string,
): Promise<{ attachment: ProductFeatureRow; feature: FeatureRow }> {
  return committed(async (tx) => {
    const product = await findProductForMerchant(tx, productPublicId, merchant.id);
    if (!product) throw missing('product');
    const feature = await findFeatureForMerchant(tx, featurePublicId, merchant.id);
    if (!feature) throw missing('feature', 'entitlement_feature');
    const attachment = await attachFeature(tx, {
      publicId: newId('prodft'),
      merchantId: merchant.id,
      productId: product.id,
      featureId: feature.id,
    });
    if (attachment === 'already_attached') {
      throw new BillingEngineError(
        'resource_already_exists',
        'this product already grants this feature',
        'entitlement_feature',
      );
    }
    await refreshMany(tx, merchant.id, await customersSubscribedToProduct(tx, product.id));
    return { attachment, feature };
  });
}

export async function detachProductFeature(
  merchant: MerchantRow,
  productPublicId: string,
  attachmentPublicId: string,
): Promise<ProductFeatureRow> {
  return committed(async (tx) => {
    const product = await findProductForMerchant(tx, productPublicId, merchant.id);
    if (!product) throw missing('product');
    const attachment = await findProductFeature(tx, attachmentPublicId, product.id);
    if (!attachment) throw missing('product feature');
    await detachFeature(tx, attachment.id);
    await refreshMany(tx, merchant.id, await customersSubscribedToProduct(tx, product.id));
    return attachment;
  });
}
