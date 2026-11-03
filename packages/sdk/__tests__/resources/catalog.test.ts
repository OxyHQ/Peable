/**
 * `products`, `prices`, `coupons` and `promotionCodes` (ADR 0018): the routes,
 * methods, query spellings and bodies an integrator would otherwise guess.
 */
import { describe, expect, test } from 'bun:test';
import type { Coupon, Price, Product, PromotionCode } from '@peable.to/shared-types';
import { Peable } from '../../src/index';
import {
  CouponsResource,
  PricesResource,
  ProductsResource,
  PromotionCodesResource,
} from '../../src/resources/catalog';
import { type CapturedRequest, createMockFetch, type MockResponseSpec } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const PRODUCT: Product = {
  id: 'prod_1',
  object: 'product',
  livemode: false,
  active: true,
  name: 'Plus',
  description: null,
  images: [],
  metadata: {},
  tax_code: null,
  default_price: null,
  unit_label: null,
  url: null,
  statement_descriptor: null,
  marketing_features: [],
  created: 1789776000,
  updated: 1789776000,
};

const PRICE: Price = {
  id: 'price_1',
  object: 'price',
  livemode: false,
  active: true,
  product: 'prod_1',
  currency: 'EUR',
  unit_amount: '999',
  billing_scheme: 'per_unit',
  tiers: null,
  tiers_mode: null,
  transform_quantity: null,
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
  tax_behavior: 'unspecified',
  lookup_key: 'plus_monthly',
  nickname: null,
  metadata: {},
  created: 1789776000,
};

const COUPON: Coupon = {
  id: 'SUMMER25',
  object: 'coupon',
  livemode: false,
  name: null,
  percent_off: 25,
  amount_off: null,
  currency: null,
  duration: 'once',
  duration_in_months: null,
  max_redemptions: null,
  redeem_by: null,
  times_redeemed: 0,
  valid: true,
  applies_to: null,
  metadata: {},
  created: 1789776000,
};

const PROMO: PromotionCode = {
  id: 'promo_1',
  object: 'promotion_code',
  livemode: false,
  code: 'SUMMER',
  coupon: 'SUMMER25',
  customer: null,
  active: true,
  max_redemptions: null,
  expires_at: null,
  times_redeemed: 0,
  restrictions: {
    first_time_transaction: false,
    minimum_amount: null,
    minimum_amount_currency: null,
  },
  metadata: {},
  created: 1789776000,
};

function harness(reply: unknown | ((request: CapturedRequest) => MockResponseSpec)) {
  const gateway: CapturedRequest[] = [];
  const mock = createMockFetch((request) => {
    if (!request.url.startsWith(TEST_GATEWAY_URL)) return serviceTokenMintResponse();
    gateway.push(request);
    return typeof reply === 'function'
      ? (reply as (request: CapturedRequest) => MockResponseSpec)(request)
      : { status: 200, json: reply };
  });
  return { client: buildTestClient(mock.fetch), gateway };
}

function last(gateway: CapturedRequest[]): CapturedRequest {
  const request = gateway.at(-1);
  if (!request) throw new Error('no gateway request was made');
  return request;
}

/** The decoded query of a captured request, as `key=value` pairs in order. */
function query(request: CapturedRequest): string[] {
  return [...new URL(request.url).searchParams.entries()].map(([key, value]) => `${key}=${value}`);
}

const list = <T>(data: T[], has_more = false, url = '/v1/x') => ({
  object: 'list',
  data,
  has_more,
  url,
});

describe('Peable wires the catalog', () => {
  test('products, prices, coupons and promotionCodes are resources of the client', () => {
    const peable = new Peable({
      tokenProvider: { getToken: async () => 'token', invalidate: () => undefined },
    });
    expect(peable.products).toBeInstanceOf(ProductsResource);
    expect(peable.prices).toBeInstanceOf(PricesResource);
    expect(peable.coupons).toBeInstanceOf(CouponsResource);
    expect(peable.promotionCodes).toBeInstanceOf(PromotionCodesResource);
  });
});

describe('products', () => {
  test('create POSTs the body with the Idempotency-Key given', async () => {
    const { client, gateway } = harness(PRODUCT);
    const body = {
      name: 'Plus',
      default_price_data: {
        currency: 'EUR' as const,
        unit_amount: '999',
        recurring: { interval: 'month' as const },
      },
      expand: ['default_price'],
    };
    await new ProductsResource(client).create(body, { idempotencyKey: 'prod-1' });
    const request = last(gateway);
    expect([request.method, request.url]).toEqual(['POST', `${TEST_GATEWAY_URL}/v1/products`]);
    expect(request.headers.get('Idempotency-Key')).toBe('prod-1');
    expect(JSON.parse(request.body ?? '{}')).toEqual(body);
  });

  test('retrieve expands, update and del address the product', async () => {
    const { client, gateway } = harness(PRODUCT);
    const products = new ProductsResource(client);

    await products.retrieve('prod_1', { expand: ['default_price'] });
    expect(last(gateway).method).toBe('GET');
    expect(last(gateway).url.split('?')[0]).toBe(`${TEST_GATEWAY_URL}/v1/products/prod_1`);
    expect(query(last(gateway))).toEqual(['expand[]=default_price']);

    await products.update('prod_1', { active: false, description: '' });
    expect(last(gateway).method).toBe('POST');
    expect(JSON.parse(last(gateway).body ?? '{}')).toEqual({ active: false, description: '' });
    // An update is a POST, so the client mints a key for it.
    expect(last(gateway).headers.get('Idempotency-Key')).toBeTruthy();

    await products.del('prod_1');
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'DELETE',
      `${TEST_GATEWAY_URL}/v1/products/prod_1`,
    ]);
  });

  test('list encodes active and ids[]', async () => {
    const { client, gateway } = harness(list([PRODUCT]));
    await new ProductsResource(client).list({ active: true, ids: ['prod_1', 'prod_2'], limit: 3 });
    expect(query(last(gateway))).toEqual([
      'limit=3',
      'active=true',
      'ids[]=prod_1',
      'ids[]=prod_2',
    ]);
    await new ProductsResource(client).list({ active: false });
    expect(query(last(gateway))).toEqual(['active=false']);
  });

  test('list auto-paginates across pages with starting_after', async () => {
    const second = { ...PRODUCT, id: 'prod_2' };
    const { client, gateway } = harness((request: CapturedRequest) => ({
      status: 200,
      json: request.url.includes('starting_after=prod_1')
        ? list([second], false, '/v1/products')
        : list([PRODUCT], true, '/v1/products'),
    }));
    const all = await new ProductsResource(client)
      .list({ limit: 1 })
      .autoPagingToArray({ limit: 10 });
    expect(all.map((product) => product.id)).toEqual(['prod_1', 'prod_2']);
    expect(gateway).toHaveLength(2);
    expect(query(last(gateway))).toEqual(['limit=1', 'starting_after=prod_1']);
  });
});

describe('prices', () => {
  test('create and update', async () => {
    const { client, gateway } = harness(PRICE);
    const prices = new PricesResource(client);
    await prices.create(
      {
        product: 'prod_1',
        currency: 'EUR',
        billing_scheme: 'tiered',
        tiers_mode: 'graduated',
        tiers: [
          { up_to: 10, unit_amount: '100' },
          { up_to: 'inf', unit_amount: '80' },
        ],
        lookup_key: 'seats',
        transfer_lookup_key: true,
      },
      { idempotencyKey: 'price-1' },
    );
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'POST',
      `${TEST_GATEWAY_URL}/v1/prices`,
    ]);
    expect(last(gateway).headers.get('Idempotency-Key')).toBe('price-1');
    expect(JSON.parse(last(gateway).body ?? '{}').tiers[1]).toEqual({
      up_to: 'inf',
      unit_amount: '80',
    });

    await prices.update('price_1', { active: false, lookup_key: '' });
    expect(last(gateway).url).toBe(`${TEST_GATEWAY_URL}/v1/prices/price_1`);
    expect(JSON.parse(last(gateway).body ?? '{}')).toEqual({ active: false, lookup_key: '' });

    await prices.retrieve('price_1', { expand: ['product'] });
    expect(query(last(gateway))).toEqual(['expand[]=product']);
  });

  test('list encodes every filter', async () => {
    const { client, gateway } = harness(list([PRICE]));
    await new PricesResource(client).list({
      product: 'prod_1',
      active: true,
      type: 'recurring',
      currency: 'EUR',
      lookup_keys: ['plus_monthly', 'plus_yearly'],
      recurring: { interval: 'month' },
      expand: ['data.product'],
    });
    expect(query(last(gateway))).toEqual([
      'expand[]=data.product',
      'product=prod_1',
      'active=true',
      'type=recurring',
      'currency=EUR',
      'lookup_keys[]=plus_monthly',
      'lookup_keys[]=plus_yearly',
      'recurring[interval]=month',
    ]);
  });
});

describe('coupons', () => {
  test('create, retrieve, update, list and del', async () => {
    const { client, gateway } = harness(COUPON);
    const coupons = new CouponsResource(client);

    await coupons.create(
      { id: 'SUMMER25', percent_off: 25, applies_to: { products: ['prod_1'] } },
      { idempotencyKey: 'coupon-1' },
    );
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'POST',
      `${TEST_GATEWAY_URL}/v1/coupons`,
    ]);
    expect(last(gateway).headers.get('Idempotency-Key')).toBe('coupon-1');

    await coupons.retrieve('SUMMER 25');
    expect(last(gateway).url).toBe(`${TEST_GATEWAY_URL}/v1/coupons/SUMMER%2025`);

    await coupons.update('SUMMER25', { name: 'Summer' });
    expect(JSON.parse(last(gateway).body ?? '{}')).toEqual({ name: 'Summer' });

    await coupons.del('SUMMER25');
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'DELETE',
      `${TEST_GATEWAY_URL}/v1/coupons/SUMMER25`,
    ]);
  });

  test('list pages with the shared parameters', async () => {
    const { client, gateway } = harness(list([COUPON]));
    const all = await new CouponsResource(client)
      .list({ created: { gte: 1 } })
      .autoPagingToArray({ limit: 5 });
    expect(all).toEqual([COUPON]);
    expect(query(last(gateway))).toEqual(['created[gte]=1']);
  });
});

describe('promotionCodes', () => {
  test('create, retrieve with expand, update', async () => {
    const { client, gateway } = harness(PROMO);
    const codes = new PromotionCodesResource(client);

    await codes.create(
      {
        coupon: 'SUMMER25',
        code: 'SUMMER',
        restrictions: { minimum_amount: '5000', minimum_amount_currency: 'EUR' },
      },
      { idempotencyKey: 'promo-1' },
    );
    expect([last(gateway).method, last(gateway).url]).toEqual([
      'POST',
      `${TEST_GATEWAY_URL}/v1/promotion_codes`,
    ]);
    expect(last(gateway).headers.get('Idempotency-Key')).toBe('promo-1');

    await codes.retrieve('promo_1', { expand: ['coupon', 'customer'] });
    expect(last(gateway).url.split('?')[0]).toBe(`${TEST_GATEWAY_URL}/v1/promotion_codes/promo_1`);
    expect(query(last(gateway))).toEqual(['expand[]=coupon', 'expand[]=customer']);

    await codes.update('promo_1', { active: false });
    expect(JSON.parse(last(gateway).body ?? '{}')).toEqual({ active: false });
  });

  test('list encodes code, coupon, customer and active', async () => {
    const { client, gateway } = harness(list([PROMO]));
    await new PromotionCodesResource(client).list({
      code: 'summer',
      coupon: 'SUMMER25',
      customer: 'cus_1',
      active: false,
    });
    expect(query(last(gateway))).toEqual([
      'code=summer',
      'coupon=SUMMER25',
      'customer=cus_1',
      'active=false',
    ]);
  });
});
