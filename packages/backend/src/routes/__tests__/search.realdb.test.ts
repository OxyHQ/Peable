/**
 * Search over HTTP against a real Postgres: every searchable resource, its
 * merchant and mode scoping, the page token, the refusals, the dashboard's
 * routes behind the membership gate, and the indexes the common predicates use.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { createDashboardRouter } from '../dashboard';
import { requestIdMiddleware } from '../../lib/requestId';
import { stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  type PaymentIntentRow,
  updateIntentState,
} from '../../db/payments/paymentIntentRepository';
import { ensureChargeForIntent, updateChargeSnapshot } from '../../db/payments/chargeRepository';
import { insertRefund, markRefundSucceeded } from '../../db/refunds/refundRepository';
import { charges, customers, paymentIntents } from '../../db/schema';
import { compileSearch } from '../../lib/search/compile';
import { parseSearchQuery } from '../../lib/search/parser';
import { CUSTOMER_SEARCH_FIELDS } from '../../db/search/searchFields';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_orbit_search';
const MEMBER = 'user_member';
let environment: OxyServiceEnvironment = 'development';
let appId = APP_ID;
let gateway: Gateway | undefined;
let baseUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId,
    appName: 'orbit',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment,
    tier: 'external',
  };
  next();
};

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

async function ok(method: string, path: string, body?: unknown): Promise<Json> {
  const answer = await call(method, path, body);
  // A create answers 201 on some resources (customers), 200 on others.
  expect([path, answer.status === 201 ? 200 : answer.status, answer.json]).toEqual([
    path,
    200,
    answer.json,
  ]);
  return answer.json;
}

/** `GET /v1/<resource>/search` with `query` and extra parameters. */
async function search(
  resource: string,
  query: string,
  extra: Record<string, string | string[]> = {},
): Promise<{ status: number; json: Json }> {
  const params = new URLSearchParams({ query });
  for (const [key, value] of Object.entries(extra)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return call('GET', `/v1/${resource}/search?${params.toString()}`);
}

async function found(resource: string, query: string, extra = {}): Promise<string[]> {
  const answer = await search(resource, query, extra);
  expect([query, answer.status, answer.json.error]).toEqual([query, 200, undefined]);
  return (answer.json.data as Json[]).map((object) => String(object.id));
}

async function refusedQuery(resource: string, query: string, param = 'query') {
  const answer = await search(resource, query);
  const error = answer.json.error as Json;
  expect([query, answer.status, error.param]).toEqual([query, 400, param]);
  return error;
}

async function customer(body: Json): Promise<string> {
  return String((await ok('POST', '/v1/customers', body)).id);
}

/** A card intent that succeeded, with its charge, optionally its customer. */
async function paidCard(
  owner: MerchantRow,
  values: { amount?: string; metadata?: Record<string, string>; customer?: string } = {},
): Promise<{ intent: PaymentIntentRow; charge: string }> {
  const seeded = await seedIntent(owner, {
    rail: 'card',
    amount: values.amount ?? '1000',
    metadata: values.metadata ?? {},
  });
  if (values.customer !== undefined) {
    const [row] = await gatewayDb()
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.publicId, values.customer));
    await gatewayDb()
      .update(paymentIntents)
      .set({ customerId: must(row).id })
      .where(eq(paymentIntents.id, seeded.id));
  }
  const moved = await updateIntentState(gatewayDb(), seeded.id, {
    from: 'requires_payment_method',
    status: 'succeeded',
  });
  if (moved.kind !== 'updated') throw new Error('the intent did not move');
  await ensureChargeForIntent(gatewayDb(), moved.row);
  const [charge] = await gatewayDb()
    .select({ publicId: charges.publicId })
    .from(charges)
    .where(eq(charges.paymentIntentId, seeded.id));
  return { intent: moved.row, charge: must(charge).publicId };
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
      access: stubOxyAccess({
        application: (userId) => (userId === MEMBER ? { ownerAccountId: 'owner' } : undefined),
      }),
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

describe.skipIf(!POSTGRES_TESTS_ENABLED)('search', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    environment = 'development';
    appId = APP_ID;
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  describe('customers', () => {
    test('email is case-insensitive and exact; ~ is a case-insensitive substring', async () => {
      const jenny = await customer({ email: 'Jenny.Rosen@Example.com', name: 'Jenny Rosen' });
      const john = await customer({ email: 'john@example.com', name: 'John Doe', phone: '+34600' });
      expect(await found('customers', 'email:"jenny.rosen@example.com"')).toEqual([jenny]);
      expect(await found('customers', 'email:"jenny"')).toEqual([]);
      expect(await found('customers', 'email~"EXAMPLE.COM"')).toEqual([john, jenny]);
      expect(await found('customers', 'name~"rose"')).toEqual([jenny]);
      expect(await found('customers', 'phone:"+34600"')).toEqual([john]);
      expect(await found('customers', 'phone:null')).toEqual([jenny]);
      expect(await found('customers', '-phone:null')).toEqual([john]);
    });

    test('negation keeps the rows the field is NULL on', async () => {
      const withEmail = await customer({ email: 'a@example.com' });
      const without = await customer({ name: 'No email' });
      expect(await found('customers', '-email:"a@example.com"')).toEqual([without]);
      expect(await found('customers', '-email:"b@example.com"')).toEqual([without, withEmail]);
    });

    test('metadata, with quotes in keys and values', async () => {
      const tagged = await customer({ metadata: { "it's": 'say "hi"', order_id: '6735' } });
      await customer({ metadata: { order_id: '6736' } });
      expect(await found('customers', "metadata['order_id']:'6735'")).toEqual([tagged]);
      expect(await found('customers', 'metadata["order_id"]:6735')).toEqual([tagged]);
      expect(await found('customers', `metadata["it's"]:'say "hi"'`)).toEqual([tagged]);
      expect(await found('customers', `metadata['it\\'s']:"say \\"hi\\""`)).toEqual([tagged]);
      expect(await found('customers', "metadata['order_id']:'6'")).toEqual([]);
      expect((await found('customers', "metadata['missing']:null")).length).toBe(2);
    });

    test('AND, OR, created ranges and total_count', async () => {
      const first = await customer({ email: 'one@example.com', name: 'One' });
      await Bun.sleep(1100);
      const second = await customer({ email: 'two@example.com', name: 'Two' });
      const created = Number((await ok('GET', `/v1/customers/${second}`)).created);
      expect(await found('customers', 'name:"One" OR name:"Two"')).toEqual([second, first]);
      expect(await found('customers', 'name:"One" AND email~"example"')).toEqual([first]);
      expect(await found('customers', `created>=${String(created)}`)).toEqual([second]);
      expect(await found('customers', `created<${String(created)}`)).toEqual([first]);
      expect(await found('customers', `created:${String(created)}`)).toEqual([second]);
      const counted = await search('customers', 'email~"example"', {
        limit: '1',
        'expand[]': 'total_count',
      });
      expect(counted.json.total_count).toBe(2);
      expect((counted.json.data as Json[]).length).toBe(1);
      expect((await search('customers', 'email~"example"')).json.total_count).toBeUndefined();
    });

    test('a deleted customer is never found', async () => {
      const gone = await customer({ email: 'gone@example.com' });
      await ok('DELETE', `/v1/customers/${gone}`);
      expect(await found('customers', 'email:"gone@example.com"')).toEqual([]);
    });
  });

  describe('scope', () => {
    test('another merchant, and the other mode of the same application, are invisible', async () => {
      const mine = await customer({ email: 'shared@example.com' });

      appId = 'app_someone_else';
      await seedMerchant({ oxyAppId: appId, environment: 'development' });
      const theirs = await customer({ email: 'shared@example.com' });
      expect(await found('customers', 'email:"shared@example.com"')).toEqual([theirs]);

      appId = APP_ID;
      environment = 'production';
      await seedMerchant({ oxyAppId: APP_ID, environment: 'production', network: 'mainnet' });
      const live = await customer({ email: 'shared@example.com' });
      const answer = await search('customers', 'email:"shared@example.com"');
      expect((answer.json.data as Json[]).map((c) => [c.id, c.livemode])).toEqual([[live, true]]);

      environment = 'development';
      const test = await search('customers', 'email:"shared@example.com"');
      expect((test.json.data as Json[]).map((c) => [c.id, c.livemode])).toEqual([[mine, false]]);
    });

    test("a reference to another merchant's object matches nothing", async () => {
      appId = 'app_someone_else';
      await seedMerchant({ oxyAppId: appId, environment: 'development' });
      const foreign = await customer({ email: 'f@example.com' });
      appId = APP_ID;
      const own = await customer({ email: 'o@example.com' });
      await paidCard(merchant, { customer: own });
      expect(await found('payment_intents', `customer:"${foreign}"`)).toEqual([]);
      expect((await found('payment_intents', `customer:"${own}"`)).length).toBe(1);
    });
  });

  describe('payment intents', () => {
    test('status, amount as a number (beyond a JS number), currency, customer, metadata', async () => {
      const jenny = await customer({ email: 'jenny@example.com' });
      const small = await paidCard(merchant, { amount: '999', customer: jenny });
      const big = await seedIntent(merchant, {
        amount: '123456789012345678901',
        metadata: { order_id: '42' },
      });
      expect(await found('payment_intents', 'status:"succeeded"')).toEqual([small.intent.publicId]);
      expect(await found('payment_intents', 'status:"requires_action"')).toEqual([big.publicId]);
      expect(await found('payment_intents', 'amount>1000')).toEqual([big.publicId]);
      expect(await found('payment_intents', 'amount>123456789012345678900')).toEqual([
        big.publicId,
      ]);
      expect(await found('payment_intents', 'amount<=999')).toEqual([small.intent.publicId]);
      expect(await found('payment_intents', 'amount:999')).toEqual([small.intent.publicId]);
      expect(await found('payment_intents', 'currency:"fair"')).toEqual([big.publicId]);
      expect(await found('payment_intents', `customer:"${jenny}"`)).toEqual([
        small.intent.publicId,
      ]);
      expect(await found('payment_intents', 'customer:null')).toEqual([big.publicId]);
      expect(await found('payment_intents', "metadata['order_id']:'42'")).toEqual([big.publicId]);
      expect((await refusedQuery('payment_intents', 'status:"settled"')).message).toContain(
        'status is one of',
      );
    });

    test('expand[] of the hits, inside the merchant', async () => {
      const jenny = await customer({ email: 'jenny@example.com' });
      await paidCard(merchant, { customer: jenny });
      const answer = await search('payment_intents', `customer:"${jenny}"`, {
        'expand[]': 'data.customer',
      });
      const [hit] = answer.json.data as Json[];
      expect((must(hit).customer as Json).email).toBe('jenny@example.com');
      const bad = await search('payment_intents', 'status:"succeeded"', { 'expand[]': 'customer' });
      expect([bad.status, (bad.json.error as Json).param]).toEqual([400, 'expand']);
    });
  });

  describe('charges', () => {
    test('billing details, last4, customer through the intent, refunded and disputed as the DTO says', async () => {
      const jenny = await customer({ email: 'jenny@example.com' });
      const full = await paidCard(merchant, {
        amount: '500',
        customer: jenny,
        metadata: { a: 'b' },
      });
      const partial = await paidCard(merchant, { amount: '700' });
      await updateChargeSnapshot(gatewayDb(), full.intent.id, {
        outcome: null,
        billingDetails: { address: null, email: 'Jenny@Example.com', name: 'Jenny', phone: null },
        paymentMethodDetails: {
          type: 'card',
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 1,
            exp_year: 2030,
            country: 'ES',
            funding: 'credit',
          },
        },
      });
      for (const [intent, amount] of [
        [full.intent, '500'],
        [partial.intent, '100'],
      ] as const) {
        const refund = must(
          await insertRefund(gatewayDb(), {
            publicId: `re_${uuidv7()}`,
            merchantId: merchant.id,
            paymentIntentId: intent.id,
            externalRef: `ref_${uuidv7()}`,
            amount,
            currency: intent.currency,
            provider: 'stripe',
          }),
        );
        await markRefundSucceeded(gatewayDb(), refund.id, `re_provider_${uuidv7()}`);
      }

      expect(await found('charges', 'billing_details.email:"jenny@example.com"')).toEqual([
        full.charge,
      ]);
      expect(await found('charges', 'billing_details.email~"example"')).toEqual([full.charge]);
      expect(await found('charges', 'payment_method_details.card.last4:"4242"')).toEqual([
        full.charge,
      ]);
      expect(await found('charges', `customer:"${jenny}"`)).toEqual([full.charge]);
      expect(await found('charges', `payment_intent:"${partial.intent.publicId}"`)).toEqual([
        partial.charge,
      ]);
      expect(await found('charges', "metadata['a']:'b'")).toEqual([full.charge]);
      expect(await found('charges', 'status:"succeeded"')).toEqual([partial.charge, full.charge]);
      expect(await found('charges', 'status:"failed"')).toEqual([]);
      expect(await found('charges', 'disputed:false')).toEqual([partial.charge, full.charge]);

      // `refunded` is derived in SQL and in `toChargeDTO`: the two agree.
      const all = await search('charges', 'amount>0', { limit: '100' });
      const byDto = (all.json.data as Json[]).filter((c) => c.refunded === true).map((c) => c.id);
      expect(await found('charges', 'refunded:true')).toEqual(byDto as string[]);
      expect(byDto).toEqual([full.charge]);
      expect(await found('charges', 'refunded:false')).toEqual([partial.charge]);
    });
  });

  describe('catalog and refunds', () => {
    test('products and prices', async () => {
      const shirt = String(
        (await ok('POST', '/v1/products', { name: 'Blue Shirt', description: 'Cotton' })).id,
      );
      const mug = String((await ok('POST', '/v1/products', { name: 'Mug' })).id);
      await ok('POST', `/v1/products/${mug}`, { active: false });
      const price = String(
        (
          await ok('POST', '/v1/prices', {
            product: shirt,
            currency: 'EUR',
            unit_amount: '2500',
            lookup_key: 'shirt_monthly',
            recurring: { interval: 'month' },
          })
        ).id,
      );
      await ok('POST', '/v1/prices', { product: mug, currency: 'USD', unit_amount: '900' });

      expect(await found('products', 'name~"shirt"')).toEqual([shirt]);
      expect(await found('products', 'active:false')).toEqual([mug]);
      expect(await found('products', 'description:null')).toEqual([mug]);
      expect(await found('prices', `product:"${shirt}"`)).toEqual([price]);
      expect(await found('prices', 'type:"recurring" currency:"eur"')).toEqual([price]);
      expect(await found('prices', 'lookup_key:"SHIRT_MONTHLY"')).toEqual([price]);
      expect((await refusedQuery('prices', 'product:"cus_1"')).message).toContain('prod_');
    });

    test('refunds', async () => {
      const paid = await paidCard(merchant, { amount: '1000' });
      const refund = must(
        await insertRefund(gatewayDb(), {
          publicId: `re_${uuidv7()}`,
          merchantId: merchant.id,
          paymentIntentId: paid.intent.id,
          externalRef: `ref_${uuidv7()}`,
          amount: '300',
          currency: paid.intent.currency,
          provider: 'stripe',
          reason: 'requested_by_customer',
          metadata: { ticket: 'T-1' },
        }),
      );
      expect(await found('refunds', `payment_intent:"${paid.intent.publicId}"`)).toEqual([
        refund.publicId,
      ]);
      expect(await found('refunds', 'status:"pending" reason:"requested_by_customer"')).toEqual([
        refund.publicId,
      ]);
      expect(await found('refunds', "metadata['ticket']:'T-1' amount<301")).toEqual([
        refund.publicId,
      ]);
      expect(await found('refunds', 'status:"succeeded"')).toEqual([]);
    });
  });

  describe('pages', () => {
    test('next_page walks every match exactly once, newest first, as the list does', async () => {
      const made: string[] = [];
      for (let i = 0; i < 23; i += 1) made.push(await customer({ email: `c${i}@example.com` }));
      await customer({ email: 'other@elsewhere.org' });
      const seen: string[] = [];
      let page: string | undefined;
      for (let guard = 0; guard < 5; guard += 1) {
        const answer = await search('customers', 'email~"example.com"', {
          limit: '10',
          ...(page ? { page } : {}),
        });
        expect(answer.status).toBe(200);
        expect(answer.json.object).toBe('search_result');
        expect(answer.json.url).toBe('/v1/customers/search');
        seen.push(...(answer.json.data as Json[]).map((c) => String(c.id)));
        if (page === undefined) {
          // A customer created mid-walk is newer than the boundary: the walk
          // already passed it, and the pages after this one do not move.
          await customer({ email: 'late@example.com' });
        }
        if (answer.json.has_more !== true) {
          expect(answer.json.next_page).toBeNull();
          break;
        }
        page = String(answer.json.next_page);
      }
      expect(seen).toEqual([...made].reverse());
      const list = await ok('GET', '/v1/customers?limit=100');
      const listed = (list.data as Json[])
        .map((c) => String(c.id))
        .filter((id) => made.includes(id));
      expect(seen).toEqual(listed);
    });

    test('a page token is bound to its query and resource', async () => {
      for (let i = 0; i < 3; i += 1) await customer({ email: `p${i}@example.com` });
      const first = await search('customers', 'email~"example"', { limit: '1' });
      const token = String(first.json.next_page);
      const other = await search('customers', 'email~"exampl"', { page: token });
      expect([other.status, (other.json.error as Json).param]).toEqual([400, 'page']);
      expect(String((other.json.error as Json).message)).toContain('different query');
      const wrongResource = await search('products', 'email~"example"', { page: token });
      expect(wrongResource.status).toBe(400);
      const garbage = await search('customers', 'email~"example"', { page: 'not-a-token' });
      expect([garbage.status, (garbage.json.error as Json).param]).toEqual([400, 'page']);
      const forged = Buffer.from('v1.x.not-a-uuid').toString('base64url');
      expect((await search('customers', 'email~"example"', { page: forged })).status).toBe(400);
    });
  });

  describe('refusals', () => {
    test('the query and the parameters', async () => {
      const missing = await call('GET', '/v1/customers/search');
      expect([missing.status, (missing.json.error as Json).param]).toEqual([400, 'query']);
      const error = await refusedQuery('customers', 'email:"a" OR name:"b" phone:"c"');
      expect(String(error.message)).toContain('(at position 22)');
      expect(String(error.message)).toContain('AND and OR cannot be combined');
      expect(String((await refusedQuery('customers', 'colour:"red"')).message)).toContain(
        "customers has no searchable field 'colour'",
      );
      const unknown = await search('customers', 'email:"a"', { starting_after: 'cus_1' });
      expect([unknown.status, (unknown.json.error as Json).param]).toEqual([400, 'starting_after']);
      const limit = await search('customers', 'email:"a"', { limit: '101' });
      expect([limit.status, (limit.json.error as Json).param]).toEqual([400, 'limit']);
    });

    test('the route is never mistaken for a retrieve', async () => {
      for (const resource of [
        'payment_intents',
        'charges',
        'customers',
        'products',
        'prices',
        'refunds',
      ]) {
        const answer = await search(resource, 'created>0');
        expect([resource, answer.status, answer.json.object]).toEqual([
          resource,
          200,
          'search_result',
        ]);
      }
    });
  });

  describe("Orbit's dashboard", () => {
    async function dashboard(path: string, user = MEMBER) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetch(
        `${dashboardUrl}/v1/dashboard/applications/${APP_ID}${path}${separator}environment=development`,
        { headers: { 'X-Test-User-Id': user } },
      );
      return { status: response.status, json: (await response.json()) as Json };
    }

    test('the global box: ids, free text and queries, grouped by resource', async () => {
      const jenny = await customer({ email: 'jenny@example.com', name: 'Jenny Rosen' });
      const shirt = String((await ok('POST', '/v1/products', { name: 'Jenny shirt' })).id);
      const paid = await paidCard(merchant, { customer: jenny });

      const byId = await dashboard(`/search?q=${paid.intent.publicId}`);
      expect(byId.json.mode).toBe('id');
      expect(byId.json.groups).toEqual([
        expect.objectContaining({ resource: 'payment_intents', has_more: false }),
      ]);

      const text = await dashboard('/search?q=jenny');
      expect(text.json.mode).toBe('text');
      const groups = text.json.groups as Json[];
      expect(groups.map((g) => g.resource)).toEqual(['customers', 'products']);
      expect((must(groups[0]).data as Json[]).map((c) => c.id)).toEqual([jenny]);
      expect((must(groups[1]).data as Json[]).map((p) => p.id)).toEqual([shirt]);

      const query = await dashboard(`/search?q=${encodeURIComponent('status:"succeeded"')}`);
      expect(query.json.mode).toBe('query');
      expect((query.json.groups as Json[]).map((g) => g.resource)).toEqual([
        'payment_intents',
        'charges',
      ]);

      const bad = await dashboard(`/search?q=${encodeURIComponent('colour:"red"')}`);
      expect([bad.status, (bad.json.error as Json).param]).toEqual([400, 'query']);
    });

    test('per-resource search shares the core; a non-member is refused', async () => {
      const jenny = await customer({ email: 'jenny@example.com' });
      const answer = await dashboard(
        `/customers/search?query=${encodeURIComponent('email~"jenny"')}`,
      );
      expect((answer.json.data as Json[]).map((c) => c.id)).toEqual([jenny]);
      const product = await dashboard(`/products/search?query=${encodeURIComponent('name~"x y"')}`);
      expect(product.json.object).toBe('search_result');
      expect((await dashboard('/search?q=jenny', 'user_stranger')).status).toBe(403);
      expect((await dashboard('/customers/search?query=x', 'user_stranger')).status).toBe(403);
    });
  });

  describe('indexes', () => {
    /** The plan's index names, with sequential scans priced out of the choice. */
    async function indexesUsed(query: SQL) {
      return gatewayDb().transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const rows = await tx.execute(sql`explain (format json) ${query}`);
        const plan = JSON.stringify(rows);
        return [...plan.matchAll(/"Index Name":\s*"([^"]+)"/g)].map((match) => match[1]);
      });
    }

    test('the common predicates have an index to use', async () => {
      await customer({ email: 'jenny@example.com' });
      const email = compileSearch(
        parseSearchQuery('email:"jenny@example.com"'),
        CUSTOMER_SEARCH_FIELDS,
        {
          merchantId: merchant.id,
          resource: 'customers',
        },
      );
      const byEmail = gatewayDb()
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.merchantId, merchant.id), isNull(customers.deletedAt), email))
        .orderBy(desc(customers.id))
        .limit(11)
        .getSQL();
      expect(await indexesUsed(byEmail)).toContain('customers_merchant_id_lower_email_idx');

      const intents = gatewayDb()
        .select({ id: paymentIntents.id })
        .from(paymentIntents)
        .where(eq(paymentIntents.merchantId, merchant.id))
        .orderBy(desc(paymentIntents.id))
        .limit(11)
        .getSQL();
      expect(await indexesUsed(intents)).toContain('payment_intents_merchant_id_id_idx');

      const chargeWalk = gatewayDb()
        .select({ id: charges.id })
        .from(charges)
        .where(eq(charges.merchantId, merchant.id))
        .orderBy(desc(charges.id))
        .limit(11)
        .getSQL();
      expect(await indexesUsed(chargeWalk)).toContain('charges_merchant_id_id_idx');
    });
  });
});
