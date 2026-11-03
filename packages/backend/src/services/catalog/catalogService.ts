/**
 * The catalog's writes (ADR 0018): every create, update and delete of a
 * product, price, coupon or promotion code commits WITH its event
 * (`recordEvent`, ADR 0014 D4) in one transaction, then kicks the outbox.
 *
 * A refusal is a {@link CatalogError} naming the offending `param`, thrown
 * before or inside the transaction (which then rolls back); the routes turn it
 * into the ADR 0014 error envelope.
 */
import type { WebhookEventPayload, WebhookEventType } from '@peable.to/shared-types';
import {
  deleteCoupon as deleteCouponRow,
  findCouponForMerchant,
  insertCoupon,
  lockCoupon,
  updateCoupon as updateCouponRow,
  type CouponRow,
  type InsertCouponParams,
} from '../../db/catalog/couponRepository';
import {
  findPriceForMerchant,
  insertPrice,
  lockPrice,
  updatePrice as updatePriceRow,
  type PricePatch,
  type PriceRow,
  type PriceShape,
} from '../../db/catalog/priceRepository';
import {
  deleteProduct as deleteProductRow,
  findProductForMerchant,
  findProductsByPublicIds,
  insertProduct,
  lockProduct,
  updateProduct as updateProductRow,
  type InsertProductParams,
  type ProductPatch,
  type ProductRow,
} from '../../db/catalog/productRepository';
import {
  insertPromotionCode,
  lockPromotionCode,
  updatePromotionCode as updatePromotionCodeRow,
  type InsertPromotionCodeParams,
  type PromotionCodeRow,
} from '../../db/catalog/promotionCodeRepository';
import { findLiveCustomerForMerchant } from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import { type DatabaseOrTransaction, getDb, type Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { METADATA_LIMIT_MESSAGE } from '@peable.to/contracts';
import {
  toCouponDTO,
  toPriceDTO,
  toProductDTO,
  toPromotionCodeDTO,
} from '../../lib/serializeCatalog';
import { recordEvent } from '../events';
import { kickWebhookOutbox } from '../webhookOutbox';
import { findMeterForMerchant } from '../../db/billingEngine/meterRepository';
import type { PricingPrice } from './pricing';
import { pricingPriceOfShape } from './pricingRows';

const GENERATED_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A generated promotion code: eight characters from an alphabet without the
 * look-alikes (0/O, 1/I), so a customer can read it off a poster.
 */
export function generatePromotionCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const byte of bytes) code += GENERATED_CODE_ALPHABET[byte % GENERATED_CODE_ALPHABET.length];
  return code;
}

export type CatalogErrorCode =
  | 'parameter_invalid'
  | 'resource_missing'
  | 'resource_already_exists'
  | 'lookup_key_taken'
  | 'promotion_code_taken'
  | 'product_has_prices'
  | 'product_in_use'
  | 'price_is_default'
  | 'tax_behavior_locked';

/** A refusal naming the request field at fault — always a 400 unless `status` says 404. */
export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly param?: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export function notFound(what: string): CatalogError {
  return new CatalogError('resource_missing', `${what} not found`, undefined, 404);
}

const metadataLimit = () =>
  new CatalogError('parameter_invalid', METADATA_LIMIT_MESSAGE, 'metadata');

/**
 * The top-level fields of `after` whose value differs from `before`, with
 * `before`'s value — `data.previous_attributes`. `updated` moves on every
 * write and says nothing by itself, so it is not a change on its own.
 * `null` when nothing moved: such an update records no event.
 */
export function previousAttributes(before: object, after: object): Record<string, unknown> | null {
  const was = before as Record<string, unknown>;
  const is = after as Record<string, unknown>;
  const moved: Record<string, unknown> = {};
  for (const key of Object.keys(is)) {
    if (key === 'updated') continue;
    if (JSON.stringify(was[key]) !== JSON.stringify(is[key])) moved[key] = was[key];
  }
  return Object.keys(moved).length === 0 ? null : moved;
}

type CatalogEventType = Extract<
  WebhookEventType,
  `product.${string}` | `price.${string}` | `coupon.${string}` | `promotion_code.${string}`
>;

async function record<K extends CatalogEventType>(
  tx: DatabaseOrTransaction,
  merchantId: string,
  type: K,
  object: WebhookEventPayload[K],
  previous?: Record<string, unknown> | null,
): Promise<void> {
  await recordEvent(tx, {
    merchantId,
    type,
    object,
    ...(previous ? { previousAttributes: previous } : {}),
  });
}

/** Record `<object>.updated` when the change moved anything. Returns whether it did. */
async function recordUpdate<K extends CatalogEventType>(
  tx: DatabaseOrTransaction,
  merchantId: string,
  type: K,
  before: WebhookEventPayload[K],
  after: WebhookEventPayload[K],
): Promise<boolean> {
  const previous = previousAttributes(before, after);
  if (previous === null) return false;
  await record(tx, merchantId, type, after, previous);
  return true;
}

async function committed<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const result = await getDb().transaction(work);
  kickWebhookOutbox();
  return result;
}

// ---- Products ----------------------------------------------------------------

export type NewProduct = Omit<InsertProductParams, 'publicId' | 'merchantId'> & {
  /** `default_price_data`: the product's default price, created with it. */
  readonly defaultPrice?: PriceShape | undefined;
};

/** `product.created` (and `price.created` for a `default_price_data`). */
export async function createProduct(merchant: MerchantRow, input: NewProduct): Promise<ProductRow> {
  const { defaultPrice, ...fields } = input;
  return committed(async (tx) => {
    let product = await insertProduct(tx, {
      ...fields,
      publicId: newId('prod'),
      merchantId: merchant.id,
    });
    if (defaultPrice) {
      const shape = await withMeter(
        tx,
        merchant.id,
        defaultPrice,
        'default_price_data[recurring][meter]',
      );
      const written = await insertPrice(tx, {
        publicId: newId('price'),
        merchantId: merchant.id,
        productId: product.id,
        shape,
        active: true,
        lookupKey: null,
        transferLookupKey: false,
        nickname: null,
        metadata: {},
      });
      if (written === 'lookup_key_taken')
        throw new Error('a price without a lookup key conflicted');
      const updated = await updateProductRow(tx, product.id, { defaultPriceId: written.row.id });
      if (updated === 'limit_exceeded') throw new Error('a product with no metadata patch');
      product = updated;
      await record(tx, merchant.id, 'price.created', toPriceDTO(written.row));
    }
    await record(tx, merchant.id, 'product.created', toProductDTO(product));
    return product;
  });
}

export type ProductUpdate = Omit<ProductPatch, 'defaultPriceId'> & {
  /** A `price_…` of this product; `null` clears the default. */
  readonly defaultPrice?: string | null | undefined;
};

/** `product.updated`, when anything moved. */
export async function updateProduct(
  merchant: MerchantRow,
  publicId: string,
  input: ProductUpdate,
): Promise<ProductRow> {
  const { defaultPrice, ...patch } = input;
  return committed(async (tx) => {
    const found = await findProductForMerchant(tx, publicId, merchant.id);
    const locked = found ? await lockProduct(tx, found.id) : null;
    if (!locked) throw notFound('product');
    let defaultPriceId: string | null | undefined;
    if (defaultPrice === null) defaultPriceId = null;
    else if (defaultPrice !== undefined) {
      const price = await findPriceForMerchant(tx, defaultPrice, merchant.id);
      if (!price || price.productId !== locked.id) {
        throw new CatalogError(
          'resource_missing',
          `no price '${defaultPrice}' of this product`,
          'default_price',
        );
      }
      if (!price.active) {
        throw new CatalogError(
          'parameter_invalid',
          'an archived price cannot be the default price',
          'default_price',
        );
      }
      defaultPriceId = price.id;
    }
    const updated = await updateProductRow(tx, locked.id, {
      ...patch,
      ...(defaultPriceId !== undefined ? { defaultPriceId } : {}),
    });
    if (updated === 'limit_exceeded') throw metadataLimit();
    await recordUpdate(
      tx,
      merchant.id,
      'product.updated',
      toProductDTO(locked),
      toProductDTO(updated),
    );
    return updated;
  });
}

/** `product.deleted` — only a product nothing names (no prices, no coupon). */
export async function deleteProduct(merchant: MerchantRow, publicId: string): Promise<ProductRow> {
  return committed(async (tx) => {
    const found = await findProductForMerchant(tx, publicId, merchant.id);
    const locked = found ? await lockProduct(tx, found.id) : null;
    if (!locked) throw notFound('product');
    const outcome = await deleteProductRow(tx, locked.id);
    if (outcome === 'has_prices') {
      throw new CatalogError(
        'product_has_prices',
        'this product has prices and cannot be deleted; archive it with active: false',
      );
    }
    if (outcome === 'in_coupons') {
      throw new CatalogError(
        'product_in_use',
        "a coupon's applies_to names this product, so it cannot be deleted; archive it with active: false",
      );
    }
    await record(tx, merchant.id, 'product.deleted', toProductDTO(locked));
    return locked;
  });
}

// ---- Prices ------------------------------------------------------------------

export interface NewPrice {
  /** The `prod_…` it prices. */
  readonly product: string;
  readonly shape: PriceShape;
  readonly active: boolean;
  readonly lookupKey: string | null;
  readonly transferLookupKey: boolean;
  readonly nickname: string | null;
  readonly metadata: Record<string, string>;
}

function lookupKeyTaken(): CatalogError {
  return new CatalogError(
    'lookup_key_taken',
    'another price already has this lookup_key; pass transfer_lookup_key: true to move it here',
    'lookup_key',
  );
}

/**
 * `price.created`, and `price.updated` for the price a transferred lookup key
 * was taken from. The product is LOCKED, so a concurrent delete of it cannot
 * leave the new price pointing at nothing.
 */
/**
 * Resolve a metered shape's `mtr_…` (ADR 0018 §7): it must be an ACTIVE meter
 * of the merchant.
 */
async function withMeter(
  tx: DatabaseOrTransaction,
  merchantId: string,
  shape: PriceShape,
  param: string,
): Promise<PriceShape> {
  const recurring = shape.recurring;
  if (!recurring?.meterPublicId) return shape;
  const meter = await findMeterForMerchant(tx, recurring.meterPublicId, merchantId);
  if (meter?.status !== 'active') {
    throw new CatalogError(
      'resource_missing',
      `no active meter '${recurring.meterPublicId}'`,
      param,
    );
  }
  const { meterPublicId: _named, ...rest } = recurring;
  return { ...shape, recurring: { ...rest, meterId: meter.id } };
}

export async function createPrice(merchant: MerchantRow, input: NewPrice): Promise<PriceRow> {
  return committed(async (tx) => {
    input = { ...input, shape: await withMeter(tx, merchant.id, input.shape, 'recurring[meter]') };
    const found = await findProductForMerchant(tx, input.product, merchant.id);
    const product = found ? await lockProduct(tx, found.id) : null;
    if (!product) {
      throw new CatalogError('resource_missing', `no such product: '${input.product}'`, 'product');
    }
    const written = await insertPrice(tx, {
      publicId: newId('price'),
      merchantId: merchant.id,
      productId: product.id,
      shape: input.shape,
      active: input.active,
      lookupKey: input.lookupKey,
      transferLookupKey: input.transferLookupKey,
      nickname: input.nickname,
      metadata: input.metadata,
    });
    if (written === 'lookup_key_taken') throw lookupKeyTaken();
    if (written.displaced)
      await recordDisplaced(tx, merchant.id, written.displaced, input.lookupKey);
    await record(tx, merchant.id, 'price.created', toPriceDTO(written.row));
    return written.row;
  });
}

async function recordDisplaced(
  tx: DatabaseOrTransaction,
  merchantId: string,
  displaced: PriceRow,
  lookupKey: string | null,
): Promise<void> {
  await record(tx, merchantId, 'price.updated', toPriceDTO(displaced), { lookup_key: lookupKey });
}

/**
 * `price.updated`. Archiving the product's default price is refused — the
 * default must stay sellable — and a set `tax_behavior` never changes. The
 * product is locked before the price, the order `updateProduct` takes them in.
 */
export async function updatePrice(
  merchant: MerchantRow,
  publicId: string,
  patch: PricePatch,
): Promise<PriceRow> {
  return committed(async (tx) => {
    const found = await findPriceForMerchant(tx, publicId, merchant.id);
    if (!found) throw notFound('price');
    const product = await lockProduct(tx, found.productId);
    const locked = product ? await lockPrice(tx, found.id) : null;
    if (!product || !locked) throw notFound('price');
    if (patch.active === false && product.defaultPriceId === locked.id) {
      throw new CatalogError(
        'price_is_default',
        "this price is its product's default_price; set another default_price (or clear it) before archiving it",
        'active',
      );
    }
    if (
      patch.taxBehavior !== undefined &&
      locked.taxBehavior !== 'unspecified' &&
      patch.taxBehavior !== locked.taxBehavior
    ) {
      throw new CatalogError(
        'tax_behavior_locked',
        `tax_behavior is already '${locked.taxBehavior}' and can no longer change`,
        'tax_behavior',
      );
    }
    const written = await updatePriceRow(tx, locked, patch);
    if (written === 'limit_exceeded') throw metadataLimit();
    if (written === 'lookup_key_taken') throw lookupKeyTaken();
    if (written.displaced) {
      await recordDisplaced(tx, merchant.id, written.displaced, patch.lookupKey ?? null);
    }
    await recordUpdate(
      tx,
      merchant.id,
      'price.updated',
      toPriceDTO(locked),
      toPriceDTO(written.row),
    );
    return written.row;
  });
}

/**
 * Resolve an inline `price_data` against the merchant's catalog: its product
 * must exist and be active. What a checkout line item or an invoice item
 * prices with `pricing.ts`; nothing is stored.
 */
export async function resolvePriceData(
  db: DatabaseOrTransaction,
  merchantId: string,
  priceData: { readonly product: string; readonly shape: PriceShape },
  param = 'price_data',
): Promise<{ product: ProductRow; shape: PriceShape; pricing: PricingPrice }> {
  const product = await findProductForMerchant(db, priceData.product, merchantId);
  if (!product) {
    throw new CatalogError(
      'resource_missing',
      `no such product: '${priceData.product}'`,
      `${param}[product]`,
    );
  }
  if (!product.active) {
    throw new CatalogError(
      'parameter_invalid',
      'the product is archived and cannot be sold',
      `${param}[product]`,
    );
  }
  return { product, shape: priceData.shape, pricing: pricingPriceOfShape(priceData.shape) };
}

// ---- Coupons -----------------------------------------------------------------

export type NewCoupon = Omit<
  InsertCouponParams,
  'merchantId' | 'publicId' | 'appliesToProductIds'
> & {
  /** The merchant's own id, or `undefined` for a generated `coupon_…`. */
  readonly id?: string | undefined;
  /** PUBLIC product ids. */
  readonly appliesTo?: readonly string[] | undefined;
};

/** `coupon.created`. */
export async function createCoupon(merchant: MerchantRow, input: NewCoupon): Promise<CouponRow> {
  const { id, appliesTo, ...fields } = input;
  return committed(async (tx) => {
    let productIds: string[] = [];
    if (appliesTo !== undefined) {
      const wanted = [...new Set(appliesTo)];
      const found = await findProductsByPublicIds(tx, merchant.id, wanted);
      const missing = wanted.find((publicId) => !found.some((row) => row.publicId === publicId));
      if (missing !== undefined) {
        throw new CatalogError(
          'resource_missing',
          `no such product: '${missing}'`,
          'applies_to[products]',
        );
      }
      productIds = found.map((row) => row.id);
    }
    const coupon = await insertCoupon(tx, {
      ...fields,
      publicId: id ?? newId('coupon'),
      merchantId: merchant.id,
      appliesToProductIds: productIds,
    });
    if (coupon === 'id_taken') {
      throw new CatalogError(
        'resource_already_exists',
        'a coupon with this id exists or existed; coupon ids are never reused',
        'id',
      );
    }
    await record(tx, merchant.id, 'coupon.created', toCouponDTO(coupon));
    return coupon;
  });
}

/** `coupon.updated` — name and metadata only. */
export async function updateCoupon(
  merchant: MerchantRow,
  publicId: string,
  patch: {
    readonly name?: string | null | undefined;
    readonly metadata?: MetadataPatch | undefined;
  },
): Promise<CouponRow> {
  return committed(async (tx) => {
    const locked = await lockCoupon(tx, publicId, merchant.id);
    if (!locked) throw notFound('coupon');
    const updated = await updateCouponRow(tx, locked.id, patch);
    if (updated === 'limit_exceeded') throw metadataLimit();
    await recordUpdate(
      tx,
      merchant.id,
      'coupon.updated',
      toCouponDTO(locked),
      toCouponDTO(updated),
    );
    return updated;
  });
}

/**
 * `coupon.deleted`. A deleted coupon can no longer be redeemed, through a
 * promotion code or otherwise; discounts already applied keep their terms.
 */
export async function deleteCoupon(merchant: MerchantRow, publicId: string): Promise<CouponRow> {
  return committed(async (tx) => {
    const locked = await lockCoupon(tx, publicId, merchant.id);
    if (!locked) throw notFound('coupon');
    const deleted = await deleteCouponRow(tx, locked.id);
    await record(tx, merchant.id, 'coupon.deleted', toCouponDTO(deleted));
    return deleted;
  });
}

// ---- Promotion codes ---------------------------------------------------------

export type NewPromotionCode = Omit<
  InsertPromotionCodeParams,
  'merchantId' | 'publicId' | 'couponId' | 'customerId' | 'code'
> & {
  /** The coupon's id. */
  readonly coupon: string;
  /** A `cus_…`, or `undefined` for any customer. */
  readonly customer?: string | undefined;
  /** `undefined`: generate one. */
  readonly code?: string | undefined;
};

/** How many generated codes are tried before giving up on a collision run. */
const GENERATED_CODE_ATTEMPTS = 5;

/**
 * `promotion_code.created`. The coupon must be live, and the code cannot
 * outlive the coupon's `redeem_by`.
 */
export async function createPromotionCode(
  merchant: MerchantRow,
  input: NewPromotionCode,
): Promise<PromotionCodeRow> {
  const { coupon: couponId, customer: customerId, code, ...fields } = input;
  return committed(async (tx) => {
    const coupon = await lockCoupon(tx, couponId, merchant.id);
    if (!coupon) {
      throw new CatalogError('resource_missing', `no such coupon: '${couponId}'`, 'coupon');
    }
    if (
      coupon.redeemBy !== null &&
      fields.expiresAt !== null &&
      fields.expiresAt.getTime() > coupon.redeemBy.getTime()
    ) {
      throw new CatalogError(
        'parameter_invalid',
        "expires_at cannot be after the coupon's redeem_by",
        'expires_at',
      );
    }
    let customerRowId: string | null = null;
    if (customerId !== undefined) {
      const customer = await findLiveCustomerForMerchant(tx, customerId, merchant.id);
      if (!customer) {
        throw new CatalogError('resource_missing', `no such customer: '${customerId}'`, 'customer');
      }
      customerRowId = customer.id;
    }
    const attempts = code === undefined ? GENERATED_CODE_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row = await insertPromotionCode(tx, {
        ...fields,
        publicId: newId('promo'),
        merchantId: merchant.id,
        couponId: coupon.id,
        customerId: customerRowId,
        code: code ?? generatePromotionCode(),
      });
      if (row === 'code_taken') continue;
      await record(tx, merchant.id, 'promotion_code.created', toPromotionCodeDTO(row));
      return row;
    }
    throw new CatalogError(
      'promotion_code_taken',
      'an active promotion code already uses this code',
      'code',
    );
  });
}

/** `promotion_code.updated` — `active` and `metadata`. */
export async function updatePromotionCode(
  merchant: MerchantRow,
  publicId: string,
  patch: { readonly active?: boolean | undefined; readonly metadata?: MetadataPatch | undefined },
): Promise<PromotionCodeRow> {
  return committed(async (tx) => {
    const locked = await lockPromotionCode(tx, publicId, merchant.id);
    if (!locked) throw notFound('promotion code');
    if (patch.active === true && !locked.active) {
      const coupon = await findCouponForMerchant(tx, locked.couponPublicId, merchant.id);
      if (!coupon) {
        throw new CatalogError(
          'parameter_invalid',
          'the coupon of this promotion code was deleted; it cannot be reactivated',
          'active',
        );
      }
    }
    const updated = await updatePromotionCodeRow(tx, locked.id, patch);
    if (updated === 'limit_exceeded') throw metadataLimit();
    if (updated === 'code_taken') {
      throw new CatalogError(
        'promotion_code_taken',
        'another active promotion code uses this code; deactivate it first',
        'active',
      );
    }
    await recordUpdate(
      tx,
      merchant.id,
      'promotion_code.updated',
      toPromotionCodeDTO(locked),
      toPromotionCodeDTO(updated),
    );
    return updated;
  });
}
