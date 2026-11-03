/**
 * The catalog over HTTP (ADR 0018) — products, prices, coupons and promotion
 * codes through the real gateway (its request id, idempotency layer, routers
 * and events) against a real Postgres, with only the Oxy credential stubbed;
 * and the same cores through Orbit's dashboard, behind its membership gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import type { WebhookEventType } from '@peable.to/shared-types';
import { createGateway, type Gateway } from '../../server';
import { createDashboardRouter } from '../dashboard';
import { requestIdMiddleware } from '../../lib/requestId';
import type { AppMembershipResult } from '../../services/appMembership';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { must } from '../../__tests__/helpers/must';
import {
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_orbit_catalog';
const MEMBER = 'user_member';
let environment: OxyServiceEnvironment = 'development';
let gateway: Gateway | undefined;
let baseUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 'orbit',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment,
    tier: 'external',
  };
  next();
};

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    json: (await response.json()) as Json,
    headers: response.headers,
  };
}

/** A call that must succeed; answers its body. */
async function ok(method: string, path: string, body?: unknown): Promise<Json> {
  const answer = await call(method, path, body);
  expect([path, answer.status, answer.json]).toEqual([path, 200, answer.json]);
  return answer.json;
}

/** A call that must be refused with 400 naming `param` (and `code`, when given). */
async function refused(
  method: string,
  path: string,
  body: unknown,
  param: string | undefined,
  code?: string,
): Promise<Json> {
  const answer = await call(method, path, body);
  const error = answer.json.error as Json;
  expect([answer.status, error.param]).toEqual([400, param]);
  if (code) expect(error.code).toBe(code);
  return error;
}

const data = (list: Json) => list.data as Json[];
const ids = (list: Json) => data(list).map((object) => object.id);

async function eventTypes(): Promise<WebhookEventType[]> {
  return (await storedEvents({ merchantId: merchant.id })).map(({ row }) => row.type);
}

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    createDashboardRouter({
      requireOxyUser: (req, _res, next) => {
        const userId = req.header('X-Test-User-Id') ?? MEMBER;
        (req as OxyAuthRequest).userId = userId;
        (req as OxyAuthRequest).accessToken = `token-for-${userId}`;
        next();
      },
      assertAppMembership: async (userId: string): Promise<AppMembershipResult> =>
        userId === MEMBER ? { allowed: true, ownerAccountId: 'owner' } : { allowed: false },
    }),
  );
  dashboardServer = app.listen(0);
  dashboardUrl = `http://127.0.0.1:${(dashboardServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
  dashboardServer?.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the catalog', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    environment = 'development';
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  describe('products', () => {
    test('create, retrieve, update, list and delete, each with its event', async () => {
      const created = await ok('POST', '/v1/products', {
        name: 'Plus',
        description: 'Mention Plus',
        images: ['https://cdn.example/plus.png'],
        tax_code: 'txcd_10103000',
        unit_label: 'seat',
        url: 'https://mention.example/plus',
        statement_descriptor: 'MENTION PLUS',
        marketing_features: [{ name: 'Longer posts' }],
        metadata: { sku: 'plus', empty: '' },
      });
      expect(created).toMatchObject({
        object: 'product',
        livemode: false,
        active: true,
        name: 'Plus',
        description: 'Mention Plus',
        images: ['https://cdn.example/plus.png'],
        tax_code: 'txcd_10103000',
        default_price: null,
        unit_label: 'seat',
        statement_descriptor: 'MENTION PLUS',
        marketing_features: [{ name: 'Longer posts' }],
        metadata: { sku: 'plus' },
      });
      expect(String(created.id)).toMatch(/^prod_[0-9a-f]{24}$/);
      expect(typeof created.created).toBe('number');
      expect(typeof created.updated).toBe('number');

      const id = String(created.id);
      expect(await ok('GET', `/v1/products/${id}`)).toEqual(created);

      const updated = await ok('POST', `/v1/products/${id}`, {
        name: 'Mention Plus',
        description: '',
        unit_label: '',
        metadata: { sku: '', tier: 'gold' },
      });
      expect(updated).toMatchObject({
        name: 'Mention Plus',
        description: null,
        unit_label: null,
        metadata: { tier: 'gold' },
      });

      // An update that moves nothing records nothing.
      await ok('POST', `/v1/products/${id}`, { name: 'Mention Plus' });

      const deleted = await ok('DELETE', `/v1/products/${id}`);
      expect(deleted).toEqual({ id, object: 'product', deleted: true });
      expect((await call('GET', `/v1/products/${id}`)).status).toBe(404);

      const events = await storedEvents({ merchantId: merchant.id });
      expect(events.map(({ row }) => row.type)).toEqual([
        'product.created',
        'product.updated',
        'product.deleted',
      ]);
      const update = must(events[1]).event;
      expect(update.data.previous_attributes).toEqual({
        name: 'Plus',
        description: 'Mention Plus',
        unit_label: 'seat',
        metadata: { sku: 'plus' },
      });
      // `request` is the API call that caused it — on the DELETE too.
      expect(must(events[2]).event.request.id).toMatch(/^req_/);
    });

    test('validation names the offending field', async () => {
      await refused('POST', '/v1/products', {}, 'name');
      await refused('POST', '/v1/products', { name: 'x', tax_code: 'txcd_99999999' }, 'tax_code');
      await refused(
        'POST',
        '/v1/products',
        { name: 'x', images: Array.from({ length: 9 }, () => 'https://a.example/i.png') },
        'images',
      );
      await refused('POST', '/v1/products', { name: 'x', images: ['ftp://a'] }, 'images[0]');
      await refused(
        'POST',
        '/v1/products',
        { name: 'x', statement_descriptor: 'A'.repeat(23) },
        'statement_descriptor',
      );
      await refused(
        'POST',
        '/v1/products',
        { name: 'x', statement_descriptor: 'BAD*CHAR' },
        'statement_descriptor',
      );
      await refused(
        'POST',
        '/v1/products',
        { name: 'x', unit_label: 'a'.repeat(13) },
        'unit_label',
      );
      await refused('POST', '/v1/products', { name: 'x', colour: 'red' }, 'colour');
      await refused(
        'POST',
        '/v1/products',
        { name: 'x', default_price_data: { currency: 'EUR' } },
        'default_price_data[unit_amount]',
      );
      await refused('POST', '/v1/products', { name: 'x', expand: ['owner'] }, 'expand');
    });

    test('default_price_data creates the default price with the product', async () => {
      const product = await ok('POST', '/v1/products', {
        name: 'Plus',
        default_price_data: {
          currency: 'EUR',
          unit_amount: '499',
          recurring: { interval: 'month' },
          tax_behavior: 'inclusive',
        },
        expand: ['default_price'],
      });
      const price = product.default_price as Json;
      expect(price).toMatchObject({
        object: 'price',
        product: product.id,
        currency: 'EUR',
        unit_amount: '499',
        type: 'recurring',
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        tax_behavior: 'inclusive',
      });
      expect(await eventTypes()).toEqual(['price.created', 'product.created']);
      // The product's event carries its default price already set.
      const created = must((await storedEvents({ type: 'product.created' }))[0]).event;
      expect((created.data.object as unknown as Json).default_price).toBe(price.id);
    });

    test('a product with prices or named by a coupon cannot be deleted; archived it can be', async () => {
      const product = await ok('POST', '/v1/products', { name: 'Plus' });
      const id = String(product.id);
      await ok('POST', '/v1/prices', { product: id, currency: 'EUR', unit_amount: '100' });
      await refused('DELETE', `/v1/products/${id}`, undefined, undefined, 'product_has_prices');

      const other = await ok('POST', '/v1/products', { name: 'Lite' });
      await ok('POST', '/v1/coupons', { percent_off: 10, applies_to: { products: [other.id] } });
      await refused(
        'DELETE',
        `/v1/products/${String(other.id)}`,
        undefined,
        undefined,
        'product_in_use',
      );

      expect(await ok('POST', `/v1/products/${id}`, { active: false })).toMatchObject({
        active: false,
      });
    });

    test('list filters by active, ids and created, and pages', async () => {
      const a = await ok('POST', '/v1/products', { name: 'A' });
      const b = await ok('POST', '/v1/products', { name: 'B', active: false });
      const c = await ok('POST', '/v1/products', { name: 'C' });

      expect(ids(await ok('GET', '/v1/products'))).toEqual([c.id, b.id, a.id]);
      expect(ids(await ok('GET', '/v1/products?active=true'))).toEqual([c.id, a.id]);
      expect(ids(await ok('GET', '/v1/products?active=false'))).toEqual([b.id]);
      expect(ids(await ok('GET', `/v1/products?ids[]=${a.id}&ids[]=${b.id}`))).toEqual([
        b.id,
        a.id,
      ]);
      expect(ids(await ok('GET', `/v1/products?ids=${c.id}`))).toEqual([c.id]);
      const first = await ok('GET', '/v1/products?limit=2');
      expect([ids(first), first.has_more, first.url]).toEqual([[c.id, b.id], true, '/v1/products']);
      expect(ids(await ok('GET', `/v1/products?limit=2&starting_after=${b.id}`))).toEqual([a.id]);
      expect(ids(await ok('GET', `/v1/products?created[gte]=${a.created}`))).toHaveLength(3);
      expect(ids(await ok('GET', '/v1/products?created[lt]=1'))).toEqual([]);
      await refused('GET', '/v1/products?active=yes', undefined, 'active');
    });

    test('another merchant cannot read or write them', async () => {
      const product = await ok('POST', '/v1/products', { name: 'Plus' });
      environment = 'production';
      await seedMerchant({ oxyAppId: APP_ID, environment: 'production', network: 'mainnet' });
      expect((await call('GET', `/v1/products/${String(product.id)}`)).status).toBe(404);
      expect(
        (await call('POST', `/v1/products/${String(product.id)}`, { name: 'Stolen' })).status,
      ).toBe(404);
      expect(ids(await ok('GET', '/v1/products'))).toEqual([]);
      await refused(
        'POST',
        '/v1/prices',
        { product: product.id, currency: 'EUR', unit_amount: '1' },
        'product',
        'resource_missing',
      );
    });

    test('a retried create replays the same product, not a second one', async () => {
      const body = { name: 'Plus' };
      const first = await call('POST', '/v1/products', body, { 'Idempotency-Key': 'prod-1' });
      const second = await call('POST', '/v1/products', body, { 'Idempotency-Key': 'prod-1' });
      expect(second.headers.get('Idempotent-Replayed')).toBe('true');
      expect(second.json).toEqual(first.json);
      expect(data(await ok('GET', '/v1/products'))).toHaveLength(1);
      expect(await eventTypes()).toEqual(['product.created']);
      const event = must((await storedEvents({ type: 'product.created' }))[0]).event;
      expect(event.request.idempotency_key).toBe('prod-1');
    });
  });

  describe('prices', () => {
    let product: Json;
    beforeEach(async () => {
      product = await ok('POST', '/v1/products', { name: 'Plus' });
    });

    test('create, retrieve, expand and list', async () => {
      const price = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'FAIR',
        unit_amount: '150000000',
        nickname: 'Monthly',
        lookup_key: 'plus_monthly',
        recurring: { interval: 'month', interval_count: 1 },
        metadata: { plan: 'plus' },
      });
      expect(price).toMatchObject({
        object: 'price',
        livemode: false,
        active: true,
        product: product.id,
        currency: 'FAIR',
        unit_amount: '150000000',
        billing_scheme: 'per_unit',
        tiers: null,
        tiers_mode: null,
        transform_quantity: null,
        type: 'recurring',
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        tax_behavior: 'unspecified',
        lookup_key: 'plus_monthly',
        nickname: 'Monthly',
        metadata: { plan: 'plus' },
      });
      expect(String(price.id)).toMatch(/^price_[0-9a-f]{24}$/);

      const expanded = await ok('GET', `/v1/prices/${String(price.id)}?expand[]=product`);
      expect((expanded.product as Json).id).toBe(product.id);
      const list = await ok('GET', '/v1/prices?expand[]=data.product');
      expect((must(data(list)[0]).product as Json).object).toBe('product');
      expect(await eventTypes()).toEqual(['product.created', 'price.created']);
    });

    test('tiered and transformed prices keep their shape', async () => {
      const tieredPrice = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        billing_scheme: 'tiered',
        tiers_mode: 'volume',
        tiers: [
          { up_to: 10, unit_amount: '100' },
          { up_to: 'inf', unit_amount: '80', flat_amount: '500' },
        ],
        recurring: { interval: 'year' },
      });
      expect(tieredPrice).toMatchObject({
        unit_amount: null,
        billing_scheme: 'tiered',
        tiers_mode: 'volume',
        tiers: [
          { up_to: 10, unit_amount: '100', flat_amount: null },
          { up_to: null, unit_amount: '80', flat_amount: '500' },
        ],
      });
      const packs = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'USD',
        unit_amount: '1000',
        transform_quantity: { divide_by: 10, round: 'up' },
      });
      expect(packs).toMatchObject({
        type: 'one_time',
        recurring: null,
        transform_quantity: { divide_by: 10, round: 'up' },
      });
    });

    test('validation names the offending field', async () => {
      const base = { product: product.id, currency: 'EUR' };
      await refused('POST', '/v1/prices', { ...base }, 'unit_amount');
      await refused('POST', '/v1/prices', { ...base, unit_amount: 100 }, 'unit_amount');
      await refused('POST', '/v1/prices', { ...base, unit_amount: '1.5' }, 'unit_amount');
      await refused(
        'POST',
        '/v1/prices',
        { ...base, currency: 'BRL', unit_amount: '1' },
        'currency',
      );
      await refused(
        'POST',
        '/v1/prices',
        { ...base, unit_amount: '1', recurring: { interval: 'month', usage_type: 'metered' } },
        'recurring[usage_type]',
      );
      await refused(
        'POST',
        '/v1/prices',
        {
          ...base,
          billing_scheme: 'tiered',
          tiers_mode: 'graduated',
          tiers: [{ up_to: 5, unit_amount: '1' }],
        },
        'tiers[0][up_to]',
      );
      await refused(
        'POST',
        '/v1/prices',
        { ...base, product: 'prod_000000000000000000000000', unit_amount: '1' },
        'product',
        'resource_missing',
      );
    });

    test('a price is immutable except active, nickname, metadata, lookup_key and an unspecified tax_behavior', async () => {
      const price = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        unit_amount: '100',
      });
      const path = `/v1/prices/${String(price.id)}`;
      for (const field of ['unit_amount', 'currency', 'recurring', 'product', 'billing_scheme']) {
        await refused('POST', path, { [field]: price[field] ?? '1' }, field, 'parameter_invalid');
      }
      const updated = await ok('POST', path, {
        nickname: 'Base',
        metadata: { a: '1' },
        tax_behavior: 'exclusive',
        active: false,
      });
      expect(updated).toMatchObject({
        nickname: 'Base',
        metadata: { a: '1' },
        tax_behavior: 'exclusive',
        active: false,
        unit_amount: '100',
      });
      // The same value again is no change; a different one is refused.
      await ok('POST', path, { tax_behavior: 'exclusive' });
      await refused(
        'POST',
        path,
        { tax_behavior: 'inclusive' },
        'tax_behavior',
        'tax_behavior_locked',
      );
      expect(await ok('POST', path, { nickname: '' })).toMatchObject({ nickname: null });

      const updates = await storedEvents({ type: 'price.updated' });
      expect(updates).toHaveLength(2);
      expect(must(updates[0]).event.data.previous_attributes).toEqual({
        active: true,
        nickname: null,
        metadata: {},
        tax_behavior: 'unspecified',
      });
    });

    test('the default price cannot be archived; default_price must be an active price of the product', async () => {
      const price = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        unit_amount: '100',
      });
      const productPath = `/v1/products/${String(product.id)}`;
      expect(await ok('POST', productPath, { default_price: price.id })).toMatchObject({
        default_price: price.id,
      });
      await refused(
        'POST',
        `/v1/prices/${String(price.id)}`,
        { active: false },
        'active',
        'price_is_default',
      );

      const other = await ok('POST', '/v1/products', { name: 'Other' });
      const foreign = await ok('POST', '/v1/prices', {
        product: other.id,
        currency: 'EUR',
        unit_amount: '1',
      });
      await refused(
        'POST',
        productPath,
        { default_price: foreign.id },
        'default_price',
        'resource_missing',
      );
      const archived = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        unit_amount: '2',
        active: false,
      });
      await refused('POST', productPath, { default_price: archived.id }, 'default_price');

      expect(await ok('POST', productPath, { default_price: '' })).toMatchObject({
        default_price: null,
      });
      await ok('POST', `/v1/prices/${String(price.id)}`, { active: false });
    });

    test('lookup keys are unique per merchant and move only when asked', async () => {
      const first = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        unit_amount: '100',
        lookup_key: 'plus',
      });
      await refused(
        'POST',
        '/v1/prices',
        { product: product.id, currency: 'EUR', unit_amount: '200', lookup_key: 'plus' },
        'lookup_key',
        'lookup_key_taken',
      );
      const second = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        unit_amount: '200',
        lookup_key: 'plus',
        transfer_lookup_key: true,
      });
      expect(second.lookup_key).toBe('plus');
      expect((await ok('GET', `/v1/prices/${String(first.id)}`)).lookup_key).toBeNull();

      // The price that lost it is told, with what it had.
      const displaced = (await storedEvents({ type: 'price.updated' })).map(({ event }) => event);
      expect(displaced.map((event) => (event.data.object as unknown as Json).id)).toEqual([
        first.id,
      ]);
      expect(must(displaced[0]).data.previous_attributes).toEqual({ lookup_key: 'plus' });

      // Back again through an update, and refused without the transfer.
      await refused(
        'POST',
        `/v1/prices/${String(first.id)}`,
        { lookup_key: 'plus' },
        'lookup_key',
        'lookup_key_taken',
      );
      await ok('POST', `/v1/prices/${String(first.id)}`, {
        lookup_key: 'plus',
        transfer_lookup_key: true,
      });
      expect(ids(await ok('GET', '/v1/prices?lookup_keys[]=plus'))).toEqual([first.id]);

      // Another mode's merchant has its own key space.
      environment = 'production';
      await seedMerchant({ oxyAppId: APP_ID, environment: 'production', network: 'mainnet' });
      const live = await ok('POST', '/v1/products', { name: 'Plus' });
      await ok('POST', '/v1/prices', {
        product: live.id,
        currency: 'EUR',
        unit_amount: '100',
        lookup_key: 'plus',
      });
    });

    test('list filters by product, active, type, currency, lookup_keys and recurring', async () => {
      const other = await ok('POST', '/v1/products', { name: 'Other' });
      const monthly = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'EUR',
        unit_amount: '100',
        recurring: { interval: 'month' },
        lookup_key: 'm',
      });
      const yearly = await ok('POST', '/v1/prices', {
        product: product.id,
        currency: 'USD',
        unit_amount: '1000',
        recurring: { interval: 'year' },
        lookup_key: 'y',
        active: false,
      });
      const once = await ok('POST', '/v1/prices', {
        product: other.id,
        currency: 'EUR',
        unit_amount: '5',
      });

      expect(ids(await ok('GET', `/v1/prices?product=${String(product.id)}`))).toEqual([
        yearly.id,
        monthly.id,
      ]);
      expect(ids(await ok('GET', '/v1/prices?active=false'))).toEqual([yearly.id]);
      expect(ids(await ok('GET', '/v1/prices?type=one_time'))).toEqual([once.id]);
      expect(ids(await ok('GET', '/v1/prices?currency=EUR'))).toEqual([once.id, monthly.id]);
      expect(ids(await ok('GET', '/v1/prices?lookup_keys[]=m&lookup_keys[]=y'))).toEqual([
        yearly.id,
        monthly.id,
      ]);
      expect(ids(await ok('GET', '/v1/prices?recurring[interval]=month'))).toEqual([monthly.id]);
      await refused(
        'GET',
        '/v1/prices?product=prod_000000000000000000000000',
        undefined,
        'product',
        'resource_missing',
      );
      await refused('GET', '/v1/prices?recurring[interval]=hour', undefined, 'recurring[interval]');
    });
  });

  describe('coupons', () => {
    test('create (own or generated id), retrieve, update, list and delete', async () => {
      const product = await ok('POST', '/v1/products', { name: 'Plus' });
      const percent = await ok('POST', '/v1/coupons', {
        id: 'SUMMER25',
        name: 'Summer',
        percent_off: 12.5,
        duration: 'repeating',
        duration_in_months: 3,
        max_redemptions: 100,
        redeem_by: Math.floor(Date.now() / 1000) + 86_400,
        applies_to: { products: [product.id] },
        metadata: { campaign: 'summer' },
      });
      expect(percent).toMatchObject({
        id: 'SUMMER25',
        object: 'coupon',
        livemode: false,
        name: 'Summer',
        percent_off: 12.5,
        amount_off: null,
        currency: null,
        duration: 'repeating',
        duration_in_months: 3,
        max_redemptions: 100,
        times_redeemed: 0,
        valid: true,
        applies_to: { products: [product.id] },
        metadata: { campaign: 'summer' },
      });
      const fixed = await ok('POST', '/v1/coupons', {
        amount_off: '500',
        currency: 'EUR',
        duration: 'forever',
      });
      expect(String(fixed.id)).toMatch(/^coupon_[0-9a-f]{24}$/);
      expect(fixed).toMatchObject({ amount_off: '500', currency: 'EUR', applies_to: null });

      expect(await ok('GET', '/v1/coupons/SUMMER25')).toEqual(percent);
      expect(await ok('POST', '/v1/coupons/SUMMER25', { name: '' })).toMatchObject({ name: null });
      await refused('POST', '/v1/coupons/SUMMER25', { percent_off: 50 }, 'percent_off');
      expect(ids(await ok('GET', '/v1/coupons'))).toEqual([fixed.id, 'SUMMER25']);

      expect(await ok('DELETE', '/v1/coupons/SUMMER25')).toEqual({
        id: 'SUMMER25',
        object: 'coupon',
        deleted: true,
      });
      expect((await call('GET', '/v1/coupons/SUMMER25')).status).toBe(404);
      expect(ids(await ok('GET', '/v1/coupons'))).toEqual([fixed.id]);
      // An id names one coupon forever.
      await refused(
        'POST',
        '/v1/coupons',
        { id: 'SUMMER25', percent_off: 5 },
        'id',
        'resource_already_exists',
      );

      expect(await eventTypes()).toEqual([
        'product.created',
        'coupon.created',
        'coupon.created',
        'coupon.updated',
        'coupon.deleted',
      ]);
      const deleted = must((await storedEvents({ type: 'coupon.deleted' }))[0]).event;
      expect((deleted.data.object as unknown as Json).valid).toBe(false);
    });

    test('validation names the offending field', async () => {
      await refused('POST', '/v1/coupons', {}, 'percent_off');
      await refused(
        'POST',
        '/v1/coupons',
        { percent_off: 10, amount_off: '5', currency: 'EUR' },
        'percent_off',
      );
      await refused('POST', '/v1/coupons', { amount_off: '5' }, 'currency');
      await refused('POST', '/v1/coupons', { percent_off: 10, currency: 'EUR' }, 'currency');
      await refused('POST', '/v1/coupons', { amount_off: '0', currency: 'EUR' }, 'amount_off');
      await refused('POST', '/v1/coupons', { percent_off: 100.5 }, 'percent_off');
      await refused('POST', '/v1/coupons', { percent_off: 10.125 }, 'percent_off');
      await refused(
        'POST',
        '/v1/coupons',
        { percent_off: 10, duration: 'repeating' },
        'duration_in_months',
      );
      await refused(
        'POST',
        '/v1/coupons',
        { percent_off: 10, duration_in_months: 2 },
        'duration_in_months',
      );
      await refused('POST', '/v1/coupons', { percent_off: 10, redeem_by: 1_000_000 }, 'redeem_by');
      await refused('POST', '/v1/coupons', { id: 'no spaces', percent_off: 10 }, 'id');
      await refused(
        'POST',
        '/v1/coupons',
        { percent_off: 10, applies_to: { products: ['prod_000000000000000000000000'] } },
        'applies_to[products]',
        'resource_missing',
      );
    });
  });

  describe('promotion codes', () => {
    test('create, retrieve with the coupon expanded, update and list', async () => {
      await ok('POST', '/v1/coupons', { id: 'TEN', percent_off: 10 });
      const customer = (await call('POST', '/v1/customers', { email: 'ada@example.com' })).json;
      expect(String(customer.id)).toStartWith('cus_');
      const code = await ok('POST', '/v1/promotion_codes', {
        coupon: 'TEN',
        code: 'Welcome10',
        customer: customer.id,
        max_redemptions: 50,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        restrictions: {
          first_time_transaction: true,
          minimum_amount: '1000',
          minimum_amount_currency: 'EUR',
        },
        metadata: { channel: 'email' },
        expand: ['coupon', 'customer'],
      });
      expect(code).toMatchObject({
        object: 'promotion_code',
        livemode: false,
        code: 'Welcome10',
        active: true,
        max_redemptions: 50,
        times_redeemed: 0,
        restrictions: {
          first_time_transaction: true,
          minimum_amount: '1000',
          minimum_amount_currency: 'EUR',
        },
        metadata: { channel: 'email' },
      });
      expect(String(code.id)).toMatch(/^promo_[0-9a-f]{24}$/);
      expect((code.coupon as Json).id).toBe('TEN');
      expect((code.customer as Json).id).toBe(customer.id);

      const path = `/v1/promotion_codes/${String(code.id)}`;
      expect((await ok('GET', path)).coupon).toBe('TEN');
      expect(await ok('POST', path, { active: false, metadata: { channel: '' } })).toMatchObject({
        active: false,
        metadata: {},
      });

      // Case-insensitive filter; coupon, customer and active filters.
      expect(ids(await ok('GET', '/v1/promotion_codes?code=WELCOME10'))).toEqual([code.id]);
      expect(ids(await ok('GET', '/v1/promotion_codes?coupon=TEN'))).toEqual([code.id]);
      expect(ids(await ok('GET', `/v1/promotion_codes?customer=${String(customer.id)}`))).toEqual([
        code.id,
      ]);
      expect(ids(await ok('GET', '/v1/promotion_codes?active=true'))).toEqual([]);
      await refused(
        'GET',
        '/v1/promotion_codes?coupon=NOPE',
        undefined,
        'coupon',
        'resource_missing',
      );

      const catalogEvents = (await eventTypes()).filter((type) => !type.startsWith('customer.'));
      expect(catalogEvents).toEqual([
        'coupon.created',
        'promotion_code.created',
        'promotion_code.updated',
      ]);
    });

    test('a code is unique among active codes, ignoring case', async () => {
      await ok('POST', '/v1/coupons', { id: 'TEN', percent_off: 10 });
      const first = await ok('POST', '/v1/promotion_codes', { coupon: 'TEN', code: 'SPRING' });
      await refused(
        'POST',
        '/v1/promotion_codes',
        { coupon: 'TEN', code: 'spring' },
        'code',
        'promotion_code_taken',
      );
      await ok('POST', `/v1/promotion_codes/${String(first.id)}`, { active: false });
      const second = await ok('POST', '/v1/promotion_codes', { coupon: 'TEN', code: 'spring' });
      // Reactivating the first would make two active codes spell the same.
      await refused(
        'POST',
        `/v1/promotion_codes/${String(first.id)}`,
        { active: true },
        'active',
        'promotion_code_taken',
      );
      expect(second.code).toBe('spring');

      const generated = await ok('POST', '/v1/promotion_codes', { coupon: 'TEN' });
      expect(String(generated.code)).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    });

    test('validation names the offending field', async () => {
      await ok('POST', '/v1/coupons', {
        id: 'SOON',
        percent_off: 10,
        redeem_by: Math.floor(Date.now() / 1000) + 600,
      });
      await refused('POST', '/v1/promotion_codes', {}, 'coupon');
      await refused(
        'POST',
        '/v1/promotion_codes',
        { coupon: 'NOPE' },
        'coupon',
        'resource_missing',
      );
      await refused('POST', '/v1/promotion_codes', { coupon: 'SOON', code: 'NO-DASH' }, 'code');
      await refused(
        'POST',
        '/v1/promotion_codes',
        { coupon: 'SOON', expires_at: Math.floor(Date.now() / 1000) + 7200 },
        'expires_at',
      );
      await refused(
        'POST',
        '/v1/promotion_codes',
        { coupon: 'SOON', restrictions: { minimum_amount: '100' } },
        'restrictions[minimum_amount_currency]',
      );
      await refused(
        'POST',
        '/v1/promotion_codes',
        { coupon: 'SOON', customer: 'cus_000000000000000000000000' },
        'customer',
        'resource_missing',
      );
      await ok('DELETE', '/v1/coupons/SOON');
      await refused(
        'POST',
        '/v1/promotion_codes',
        { coupon: 'SOON' },
        'coupon',
        'resource_missing',
      );
    });

    test('a promotion code of a deleted coupon expands it as no longer valid and cannot be reactivated', async () => {
      await ok('POST', '/v1/coupons', { id: 'GONE', percent_off: 10 });
      const code = await ok('POST', '/v1/promotion_codes', { coupon: 'GONE', active: false });
      await ok('DELETE', '/v1/coupons/GONE');
      const path = `/v1/promotion_codes/${String(code.id)}`;
      const read = await ok('GET', `${path}?expand[]=coupon`);
      expect(read.coupon).toMatchObject({ id: 'GONE', valid: false });
      await refused('POST', path, { active: true }, 'active', 'parameter_invalid');
    });
  });

  describe('Orbit dashboard', () => {
    const dashboard = (path: string, init: RequestInit & { user?: string } = {}) =>
      fetch(
        `${dashboardUrl}/v1/dashboard/applications/${APP_ID}${path}${path.includes('?') ? '&' : '?'}environment=development`,
        {
          ...init,
          headers: { 'Content-Type': 'application/json', 'X-Test-User-Id': init.user ?? MEMBER },
        },
      );

    test('a member runs the same cores; an outsider is refused', async () => {
      const created = await dashboard('/products', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Plus',
          default_price_data: { currency: 'EUR', unit_amount: '1' },
        }),
      });
      expect(created.status).toBe(200);
      const product = (await created.json()) as Json;
      const listed = (await (await dashboard('/products?limit=5')).json()) as Json;
      expect(ids(listed)).toEqual([product.id]);
      const prices = (await (
        await dashboard(`/prices?product=${String(product.id)}`)
      ).json()) as Json;
      expect(ids(prices)).toEqual([product.default_price]);
      // The service API reads the same row.
      expect((await ok('GET', `/v1/products/${String(product.id)}`)).name).toBe('Plus');
      // Writes record the request that made them.
      const event = must((await storedEvents({ type: 'product.created' }))[0]).event;
      expect(event.request.id).toMatch(/^req_/);

      for (const [path, init] of [
        ['/products', {}],
        [`/products/${String(product.id)}`, {}],
        ['/products', { method: 'POST', body: JSON.stringify({ name: 'Nope' }) }],
        [`/products/${String(product.id)}`, { method: 'DELETE' }],
        ['/coupons', { method: 'POST', body: JSON.stringify({ percent_off: 5 }) }],
      ] as const) {
        const answer = await dashboard(path, { ...init, user: 'user_outsider' });
        expect([path, answer.status]).toEqual([path, 403]);
      }
      expect(ids(await ok('GET', '/v1/products'))).toEqual([product.id]);
    });

    test('a validation error names its param on the dashboard too', async () => {
      const answer = await dashboard('/prices', {
        method: 'POST',
        body: JSON.stringify({ product: 'prod_x', currency: 'EUR' }),
      });
      expect(answer.status).toBe(400);
      expect(((await answer.json()) as { error: Json }).error.param).toBe('unit_amount');
    });
  });
});
