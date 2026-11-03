import type {
  Coupon,
  CouponListParams,
  CreateCouponParams,
  CreatePriceParams,
  CreateProductParams,
  CreatePromotionCodeParams,
  DeletedCoupon,
  DeletedProduct,
  ExpandParams,
  List,
  Price,
  PriceListParams,
  Product,
  ProductListParams,
  PromotionCode,
  PromotionCodeListParams,
  UpdateCouponParams,
  UpdatePriceParams,
  UpdateProductParams,
  UpdatePromotionCodeParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

/**
 * The catalog (ADR 0018): what a merchant sells and on what terms — products,
 * their prices, coupons and the promotion codes that redeem them. Every amount
 * is a base-unit STRING (`'1999'` is 19.99 EUR); every write records its
 * `product.*` / `price.*` / `coupon.*` / `promotion_code.*` event.
 */

/** Options of a create: your own `Idempotency-Key` (the client mints one otherwise). */
export interface CatalogCreateOptions {
  idempotencyKey?: string;
}

const booleanParam = (value: boolean | undefined) =>
  value === undefined ? undefined : String(value);

function resourcePath(collection: string, id: string): string {
  return `/v1/${collection}/${encodeURIComponent(id)}`;
}

/** Products (`prod_…`). A product with prices cannot be deleted — archive it with `active: false`. */
export class ProductsResource {
  constructor(private readonly client: RestClient) {}

  /** `default_price_data` creates the product's default price with it. */
  create(
    params: CreateProductParams & ExpandParams,
    options: CatalogCreateOptions = {},
  ): Promise<Product> {
    return this.client.request<Product>('POST', '/v1/products', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<Product> {
    return this.client.request<Product>('GET', resourcePath('products', id), {
      query: { expand: params.expand },
    });
  }

  /** `''` clears an optional text field (and `default_price`); `metadata` is merged. */
  update(id: string, params: UpdateProductParams & ExpandParams): Promise<Product> {
    return this.client.request<Product>('POST', resourcePath('products', id), { body: params });
  }

  list(params: ProductListParams = {}): ApiListPromise<Product> {
    return listPromise(
      (page: ProductListParams) =>
        this.client.request<List<Product>>('GET', '/v1/products', {
          query: listQuery(page, { active: booleanParam(page.active), ids: page.ids }),
        }),
      params,
    );
  }

  /** Only a product with no prices and no coupon naming it. */
  del(id: string): Promise<DeletedProduct> {
    return this.client.request<DeletedProduct>('DELETE', resourcePath('products', id));
  }
}

/**
 * Prices (`price_…`). Immutable once created except `active`, `nickname`,
 * `metadata`, `lookup_key` and — while `unspecified` — `tax_behavior`: to
 * change an amount, create a price and archive the old one. Never deleted.
 */
export class PricesResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreatePriceParams & ExpandParams,
    options: CatalogCreateOptions = {},
  ): Promise<Price> {
    return this.client.request<Price>('POST', '/v1/prices', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<Price> {
    return this.client.request<Price>('GET', resourcePath('prices', id), {
      query: { expand: params.expand },
    });
  }

  update(id: string, params: UpdatePriceParams & ExpandParams): Promise<Price> {
    return this.client.request<Price>('POST', resourcePath('prices', id), { body: params });
  }

  /** `lookup_keys` (at most 10) finds the current price of a plan by its stable name. */
  list(params: PriceListParams = {}): ApiListPromise<Price> {
    return listPromise(
      (page: PriceListParams) =>
        this.client.request<List<Price>>('GET', '/v1/prices', {
          query: listQuery(page, {
            product: page.product,
            active: booleanParam(page.active),
            type: page.type,
            currency: page.currency,
            lookup_keys: page.lookup_keys,
            recurring: page.recurring,
          }),
        }),
      params,
    );
  }
}

/** Coupons — your own id (`SUMMER25`) or a generated `coupon_…`; only `name` and `metadata` change. */
export class CouponsResource {
  constructor(private readonly client: RestClient) {}

  create(
    params: CreateCouponParams & ExpandParams,
    options: CatalogCreateOptions = {},
  ): Promise<Coupon> {
    return this.client.request<Coupon>('POST', '/v1/coupons', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<Coupon> {
    return this.client.request<Coupon>('GET', resourcePath('coupons', id), {
      query: { expand: params.expand },
    });
  }

  update(id: string, params: UpdateCouponParams & ExpandParams): Promise<Coupon> {
    return this.client.request<Coupon>('POST', resourcePath('coupons', id), { body: params });
  }

  list(params: CouponListParams = {}): ApiListPromise<Coupon> {
    return listPromise(
      (page: CouponListParams) =>
        this.client.request<List<Coupon>>('GET', '/v1/coupons', { query: listQuery(page) }),
      params,
    );
  }

  /** It can no longer be redeemed; its id is never reused. */
  del(id: string): Promise<DeletedCoupon> {
    return this.client.request<DeletedCoupon>('DELETE', resourcePath('coupons', id));
  }
}

/** Promotion codes (`promo_…`) — customer-facing codes that redeem a coupon. Never deleted: deactivate. */
export class PromotionCodesResource {
  constructor(private readonly client: RestClient) {}

  /** Without `code`, one is generated. Codes are case-insensitive and unique among active codes. */
  create(
    params: CreatePromotionCodeParams & ExpandParams,
    options: CatalogCreateOptions = {},
  ): Promise<PromotionCode> {
    return this.client.request<PromotionCode>('POST', '/v1/promotion_codes', {
      body: params,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<PromotionCode> {
    return this.client.request<PromotionCode>('GET', resourcePath('promotion_codes', id), {
      query: { expand: params.expand },
    });
  }

  update(id: string, params: UpdatePromotionCodeParams & ExpandParams): Promise<PromotionCode> {
    return this.client.request<PromotionCode>('POST', resourcePath('promotion_codes', id), {
      body: params,
    });
  }

  list(params: PromotionCodeListParams = {}): ApiListPromise<PromotionCode> {
    return listPromise(
      (page: PromotionCodeListParams) =>
        this.client.request<List<PromotionCode>>('GET', '/v1/promotion_codes', {
          query: listQuery(page, {
            code: page.code,
            coupon: page.coupon,
            customer: page.customer,
            active: booleanParam(page.active),
          }),
        }),
      params,
    );
  }
}
