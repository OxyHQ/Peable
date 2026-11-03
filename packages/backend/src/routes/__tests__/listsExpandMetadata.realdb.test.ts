/**
 * ADR 0014 D1's list, expansion and metadata conventions, over HTTP, against
 * a real database.
 *
 * Every list goes through `lib/list.ts` + `db/keyset.ts`, so the pagination
 * contract is driven in depth on one resource (payment intents) and then
 * checked for SHAPE on every other list — the envelope, `url`, cursor
 * scoping — because a route that bypassed the helper would differ there first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { uuidv7 } from '@oxy.so/db';
import { createPaymentIntentsRouter } from '../paymentIntents';
import { updateIntentState } from '../../db/payments/paymentIntentRepository';
import { createPaymentLinksRouter } from '../paymentLinks';
import { createCheckoutSessionsRouter } from '../checkoutSessions';
import { createRefundsRouter } from '../refunds';
import { createTransfersRouter } from '../transfers';
import { createDisputesRouter } from '../disputes';
import { createConnectedAccountsRouter } from '../connectedAccounts';
import {
  insertPaymentIntent,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import { insertRefund } from '../../db/refunds/refundRepository';
import { upsertDispute } from '../../db/disputes/disputeRepository';
import { insertTransfer } from '../../db/transfers/transferRepository';
import {
  insertConnectedAccount,
  registerFaircoinKey,
  type ConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import { paymentIntents } from '../../db/schema';
import {
  gatewayDb,
  seedIntent,
  seedLink,
  seedPrice,
  seedMerchant,
  seedSession,
  testXpubFor,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { POSTGRES_TESTS_ENABLED } from '../../db/testDatabase';
import { must } from '../../__tests__/helpers/must';

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
type Json = Record<string, unknown> & {
  object?: string;
  data?: Json[];
  has_more?: boolean;
  url?: string;
  error?: { type: string; code?: string; param?: string; message: string };
};

let merchant: Merchant;
let stranger: Merchant;
let actingApp = '';
let server: Server | undefined;
let baseUrl = '';
let sellerKeys = 10;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Json) : {} };
}

const ids = (json: Json): string[] => (json.data ?? []).map((row) => String(row.id));

/** Pin a row's `created_at`, so `created[...]` has known instants to filter. */
async function setCreated(intent: PaymentIntentRow, at: Date): Promise<void> {
  await gatewayDb()
    .update(paymentIntents)
    .set({ createdAt: at })
    .where(eq(paymentIntents.id, intent.id));
}

/** Intents in DISTINCT milliseconds, oldest first — the resolution keyset order has. */
async function seedIntents(owner: Merchant, count: number): Promise<PaymentIntentRow[]> {
  const rows: PaymentIntentRow[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await seedIntent(owner));
    await Bun.sleep(2);
  }
  return rows;
}

async function seedSeller(owner: Merchant): Promise<ConnectedAccountRow> {
  const unique = uuidv7();
  const row = must(
    await insertConnectedAccount(gatewayDb(), {
      publicId: `ca_${unique}`,
      merchantId: owner.id,
      externalRef: `seller_${unique}`,
      faircoin: { network: 'testnet', oxyUserId: `user_${unique}` },
    }),
  );
  sellerKeys += 1;
  // A seller key is unique across accounts, so each seller gets its own.
  const registered = await registerFaircoinKey(
    gatewayDb(),
    row.id,
    testXpubFor('testnet', sellerKeys),
  );
  if (!registered.ok) throw new Error(`could not register the seller key: ${registered.refusal}`);
  return row;
}

async function seedCardAccount(owner: Merchant): Promise<ConnectedAccountRow> {
  const unique = uuidv7();
  return must(
    await insertConnectedAccount(gatewayDb(), {
      publicId: `ca_${unique}`,
      merchantId: owner.id,
      externalRef: `card_seller_${unique}`,
      provider: 'stripe',
      providerAccountId: `acct_${unique}`,
      country: 'ES',
    }),
  );
}

async function seedRefund(intent: PaymentIntentRow, amount: string) {
  return must(
    await insertRefund(gatewayDb(), {
      publicId: `re_${uuidv7()}`,
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      externalRef: `ref_${uuidv7()}`,
      amount,
      currency: intent.currency,
      provider: 'stripe',
    }),
  );
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('lists, expand[] and metadata', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    merchant = await seedMerchant();
    stranger = await seedMerchant();

    const stubMerchantAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: actingApp,
        appName: 't',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: 'acct_lists',
        environment: 'development',
        tier: 'external',
      };
      next();
    };
    /** The dual-auth retrieve: merchant unless the test asks for the payer path. */
    const optionalAuth: RequestHandler = (req, res, next) => {
      if (req.header('X-Test-Payer') === '1') return next();
      stubMerchantAuth(req, res, next);
    };
    const passthrough: RequestHandler = (_req, _res, next) => next();

    const app = express();
    app.use(express.json());
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubMerchantAuth,
        optionalServiceAuth: optionalAuth,
      }),
    );
    app.use(
      createPaymentLinksRouter({ requireMerchant: stubMerchantAuth, publicRateLimit: passthrough }),
    );
    app.use(
      createCheckoutSessionsRouter({
        requireMerchant: stubMerchantAuth,
        publicRateLimit: passthrough,
      }),
    );
    app.use(createRefundsRouter({ requireMerchant: stubMerchantAuth }));
    app.use(createTransfersRouter({ requireMerchant: stubMerchantAuth }));
    app.use(createDisputesRouter({ requireMerchant: stubMerchantAuth }));
    app.use(createConnectedAccountsRouter({ requireMerchant: stubMerchantAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    actingApp = merchant.oxyAppId;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  });

  describe('pagination', () => {
    test('pages forward with starting_after and backward with ending_before, newest first both ways', async () => {
      const owner = await seedMerchant();
      actingApp = owner.oxyAppId;
      const created = await seedIntents(owner, 5);
      const newestFirst = [...created].reverse().map((row) => row.publicId);

      const first = await call('GET', '/v1/payment_intents?limit=2');
      expect(first.status).toBe(200);
      expect(first.json.object).toBe('list');
      expect(first.json.url).toBe('/v1/payment_intents');
      expect(ids(first.json)).toEqual(newestFirst.slice(0, 2));
      expect(first.json.has_more).toBe(true);

      const second = await call(
        'GET',
        `/v1/payment_intents?limit=2&starting_after=${newestFirst[1]}`,
      );
      expect(ids(second.json)).toEqual(newestFirst.slice(2, 4));
      expect(second.json.has_more).toBe(true);

      const third = await call(
        'GET',
        `/v1/payment_intents?limit=2&starting_after=${newestFirst[3]}`,
      );
      expect(ids(third.json)).toEqual(newestFirst.slice(4));
      expect(third.json.has_more).toBe(false);

      // Backwards from the last page's first row: the page before it, still
      // newest first, with `has_more` saying newer rows remain.
      const back = await call('GET', `/v1/payment_intents?limit=2&ending_before=${newestFirst[4]}`);
      expect(ids(back.json)).toEqual(newestFirst.slice(2, 4));
      expect(back.json.has_more).toBe(true);

      const backToTop = await call(
        'GET',
        `/v1/payment_intents?limit=2&ending_before=${newestFirst[2]}`,
      );
      expect(ids(backToTop.json)).toEqual(newestFirst.slice(0, 2));
      expect(backToTop.json.has_more).toBe(false);

      // Default limit 10 covers all five.
      const all = await call('GET', '/v1/payment_intents');
      expect(ids(all.json)).toEqual(newestFirst);
      expect(all.json.has_more).toBe(false);
    });

    test('refuses both cursors at once, naming ending_before', async () => {
      const [intent] = await seedIntents(merchant, 1);
      const id = must(intent).publicId;
      const { status, json } = await call(
        'GET',
        `/v1/payment_intents?starting_after=${id}&ending_before=${id}`,
      );
      expect(status).toBe(400);
      expect(json.error?.param).toBe('ending_before');
    });

    test('bounds limit to 1..100 and refuses an unknown parameter by name', async () => {
      for (const limit of ['0', '101', 'ten']) {
        const { status, json } = await call('GET', `/v1/payment_intents?limit=${limit}`);
        expect(status).toBe(400);
        expect(json.error?.param).toBe('limit');
      }
      expect((await call('GET', '/v1/payment_intents?limit=100')).status).toBe(200);

      const typo = await call('GET', '/v1/payment_intents?stauts=settled');
      expect(typo.status).toBe(400);
      expect(typo.json.error?.param).toBe('stauts');
    });

    test('a cursor from another merchant is the same 400 as an unknown one, and confirms nothing', async () => {
      const [foreign] = await seedIntents(stranger, 1);
      for (const param of ['starting_after', 'ending_before']) {
        const theirs = await call('GET', `/v1/payment_intents?${param}=${must(foreign).publicId}`);
        const unknown = await call('GET', `/v1/payment_intents?${param}=pi_${'0'.repeat(24)}`);
        expect(theirs.status).toBe(400);
        expect(theirs.json.error?.code).toBe('resource_missing');
        expect(theirs.json.error?.param).toBe(param);
        expect(theirs.json.error?.message).toBe(String(unknown.json.error?.message));
      }
    });

    test('filters by created, judged against the floored second the wire shows', async () => {
      const owner = await seedMerchant();
      actingApp = owner.oxyAppId;
      const [a, b, c] = await seedIntents(owner, 3);
      const base = 1_800_000_000;
      // `b` is created HALF a second into `base + 100`: its wire `created` is
      // `base + 100`, and every filter must agree with that.
      await setCreated(must(a), new Date(base * 1000));
      await setCreated(must(b), new Date((base + 100) * 1000 + 500));
      await setCreated(must(c), new Date((base + 200) * 1000));
      const [ida, idb, idc] = [must(a).publicId, must(b).publicId, must(c).publicId];

      const at = async (query: string) =>
        ids((await call('GET', `/v1/payment_intents?${query}`)).json);
      expect(await at(`created=${base + 100}`)).toEqual([idb]);
      expect(await at(`created[lte]=${base + 100}`)).toEqual([idb, ida]);
      expect(await at(`created[lt]=${base + 100}`)).toEqual([ida]);
      expect(await at(`created[gte]=${base + 100}`)).toEqual([idc, idb]);
      expect(await at(`created[gt]=${base + 100}`)).toEqual([idc]);
      expect(await at(`created[gte]=${base + 1}&created[lte]=${base + 199}`)).toEqual([idb]);

      const bad = await call('GET', '/v1/payment_intents?created[after]=1');
      expect(bad.status).toBe(400);
      expect(bad.json.error?.param).toBe('created');
    });
  });

  describe('every list speaks the same envelope', () => {
    test('per-intent sub-lists page with has_more and url, and refunds keep remaining_refundable', async () => {
      const seeded = await seedIntent(merchant, { rail: 'card', amount: '10000' });
      // Refunds draw on what was RECEIVED (ADR 0019), so the payment succeeds first.
      const moved = await updateIntentState(gatewayDb(), seeded.id, {
        from: 'requires_payment_method',
        status: 'succeeded',
      });
      const intent = moved.kind === 'updated' ? moved.row : seeded;
      const refunds = [] as Awaited<ReturnType<typeof seedRefund>>[];
      for (let index = 0; index < 3; index += 1) {
        refunds.push(await seedRefund(intent, '100'));
        await Bun.sleep(2);
      }
      const path = `/v1/payment_intents/${intent.publicId}/refunds`;
      const page = await call('GET', `${path}?limit=2`);
      expect(page.status).toBe(200);
      expect(page.json.url).toBe(path);
      expect(page.json.has_more).toBe(true);
      expect(ids(page.json)).toEqual([must(refunds[2]).publicId, must(refunds[1]).publicId]);
      expect(page.json.remaining_refundable).toBe('9700');

      const rest = await call('GET', `${path}?limit=2&starting_after=${must(refunds[1]).publicId}`);
      expect(ids(rest.json)).toEqual([must(refunds[0]).publicId]);
      expect(rest.json.has_more).toBe(false);

      for (const sub of ['transfers', 'disputes']) {
        const list = await call('GET', `/v1/payment_intents/${intent.publicId}/${sub}`);
        expect(list.json).toEqual({
          object: 'list',
          data: [],
          has_more: false,
          url: `/v1/payment_intents/${intent.publicId}/${sub}`,
        });
      }
    });

    test('top-level refunds, disputes and transfers list, filter by payment_intent and retrieve', async () => {
      const owner = await seedMerchant();
      actingApp = owner.oxyAppId;
      const one = await seedIntent(owner, { rail: 'card', amount: '5000' });
      const two = await seedIntent(owner, { rail: 'card', amount: '5000' });
      const r1 = await seedRefund(one, '100');
      await Bun.sleep(2);
      const r2 = await seedRefund(two, '200');

      const all = await call('GET', '/v1/refunds');
      expect(all.json.url).toBe('/v1/refunds');
      expect(ids(all.json)).toEqual([r2.publicId, r1.publicId]);
      expect(must(all.json.data)[0]?.payment_intent).toBe(two.publicId);

      const filtered = await call('GET', `/v1/refunds?payment_intent=${one.publicId}`);
      expect(ids(filtered.json)).toEqual([r1.publicId]);

      const unknownFilter = await call('GET', `/v1/refunds?payment_intent=pi_${'0'.repeat(24)}`);
      expect(unknownFilter.status).toBe(400);
      expect(unknownFilter.json.error?.param).toBe('payment_intent');

      const retrieved = await call('GET', `/v1/refunds/${r1.publicId}`);
      expect(retrieved.status).toBe(200);
      expect(retrieved.json.payment_intent).toBe(one.publicId);

      const { dispute } = await upsertDispute(gatewayDb(), {
        merchantId: owner.id,
        paymentIntentId: two.id,
        provider: 'stripe',
        providerObjectId: `du_${uuidv7()}`,
        amount: '5000',
        currency: 'EUR',
        status: 'needs_response',
      });
      const disputes = await call('GET', '/v1/disputes');
      expect(ids(disputes.json)).toEqual([dispute.publicId]);
      expect((await call('GET', `/v1/disputes?payment_intent=${one.publicId}`)).json.data).toEqual(
        [],
      );
      const oneDispute = await call(
        'GET',
        `/v1/disputes/${dispute.publicId}?expand[]=payment_intent`,
      );
      expect((oneDispute.json.payment_intent as Json).id).toBe(two.publicId);

      const seller = await seedCardAccount(owner);
      const transfer = must(
        await insertTransfer(gatewayDb(), {
          publicId: `tr_${uuidv7()}`,
          merchantId: owner.id,
          paymentIntentId: one.id,
          connectedAccountId: seller.id,
          externalRef: `order_${uuidv7()}`,
          amount: '1000',
          currency: 'EUR',
          provider: 'stripe',
          sourcePaymentObjectId: 'ch_1',
        }),
      );
      const transfers = await call(
        'GET',
        `/v1/transfers?connected_account=${seller.publicId}&expand[]=data.connected_account`,
      );
      expect(ids(transfers.json)).toEqual([transfer.publicId]);
      expect((must(must(transfers.json.data)[0]).connected_account as Json).id).toBe(
        seller.publicId,
      );
      const oneTransfer = await call('GET', `/v1/transfers/${transfer.publicId}`);
      expect(oneTransfer.json.payment_intent).toBe(one.publicId);
      expect(oneTransfer.json.connected_account).toBe(seller.publicId);

      // Nothing here reaches across merchants.
      actingApp = stranger.oxyAppId;
      expect((await call('GET', `/v1/refunds/${r1.publicId}`)).status).toBe(404);
      expect((await call('GET', `/v1/disputes/${dispute.publicId}`)).status).toBe(404);
      expect((await call('GET', `/v1/transfers/${transfer.publicId}`)).status).toBe(404);
      expect((await call('GET', '/v1/refunds')).json.data).toEqual([]);
    });

    test('links, sessions and connected accounts carry the envelope and url', async () => {
      const owner = await seedMerchant();
      actingApp = owner.oxyAppId;
      await seedLink(owner);
      await seedSession(owner, await seedIntent(owner));
      await seedSeller(owner);
      for (const path of ['/v1/payment_links', '/v1/checkout_sessions', '/v1/connected_accounts']) {
        const { status, json } = await call('GET', `${path}?limit=1`);
        expect(status).toBe(200);
        expect(json.object).toBe('list');
        expect(json.url).toBe(path);
        expect(json.has_more).toBe(false);
        expect(json.data).toHaveLength(1);
      }
    });
  });

  describe('expand[]', () => {
    test('replaces an id with its object on a retrieve, nested up to four levels', async () => {
      const owner = await seedMerchant();
      actingApp = owner.oxyAppId;
      const seller = await seedSeller(owner);
      const unique = uuidv7();
      const intent = must(
        await insertPaymentIntent(gatewayDb(), {
          publicId: `pi_${unique}`,
          merchantId: owner.id,
          connectedAccountId: seller.id,
          rail: 'faircoin',
          amount: '100000000',
          currency: 'FAIR',
          network: 'testnet',
          address: `T${unique}`,
          provider: null,
          status: 'requires_action' as const,
          clientSecret: `pi_${unique}_secret_x`,
          idempotencyKey: unique,
          metadata: {},
          expiresAt: new Date(Date.now() + 900_000),
        }),
      );
      const session = await seedSession(owner, intent);

      const plain = await call('GET', `/v1/checkout_sessions/${session.publicId}`);
      expect(plain.json.payment_intent).toBe(intent.publicId);
      expect(plain.json.connected_account).toBe(seller.publicId);

      const nested = await call(
        'GET',
        `/v1/checkout_sessions/${session.publicId}?expand[]=payment_intent.connected_account`,
      );
      expect(nested.status).toBe(200);
      const expandedIntent = nested.json.payment_intent as Json;
      expect(expandedIntent.object).toBe('payment_intent');
      expect(expandedIntent.id).toBe(intent.publicId);
      expect((expandedIntent.connected_account as Json).object).toBe('connected_account');
      expect((expandedIntent.connected_account as Json).id).toBe(seller.publicId);
      // Only what was asked for: the session's own seller reference stays an id.
      expect(nested.json.connected_account).toBe(seller.publicId);

      const onIntent = await call(
        'GET',
        `/v1/payment_intents/${intent.publicId}?expand=connected_account`,
      );
      expect((onIntent.json.connected_account as Json).id).toBe(seller.publicId);

      const list = await call('GET', '/v1/checkout_sessions?expand[]=data.payment_intent');
      expect((must(must(list.json.data)[0]).payment_intent as Json).id).toBe(intent.publicId);
    });

    test('a null reference stays null', async () => {
      const intent = await seedIntent(merchant);
      const { json } = await call(
        'GET',
        `/v1/payment_intents/${intent.publicId}?expand[]=connected_account`,
      );
      expect(json.connected_account).toBeNull();
    });

    test('refuses an unknown, malformed or too-deep path with param expand, before reading anything', async () => {
      const intent = await seedIntent(merchant);
      const session = await seedSession(merchant, intent);
      const refusals = [
        `/v1/checkout_sessions/${session.publicId}?expand[]=line_items`,
        `/v1/checkout_sessions/${session.publicId}?expand[]=payment_intent.address`,
        `/v1/checkout_sessions/${session.publicId}?expand[]=payment_intent..connected_account`,
        `/v1/checkout_sessions/${session.publicId}?expand[]=a.b.c.d.e`,
        // On a list every path names the elements first.
        '/v1/checkout_sessions?expand[]=payment_intent',
        '/v1/payment_links?expand[]=data.payment_intent',
        // Nothing to expand on a missing object is still an invalid path first.
        `/v1/checkout_sessions/cs_${'0'.repeat(24)}?expand[]=nope`,
      ];
      for (const path of refusals) {
        const { status, json } = await call('GET', path);
        expect({ path, status, param: json.error?.param }).toEqual({
          path,
          status: 400,
          param: 'expand',
        });
      }
    });

    test('the payer path cannot expand: expansion is merchant-scoped', async () => {
      const intent = await seedIntent(merchant);
      const response = await fetch(
        `${baseUrl}/v1/payment_intents/${intent.publicId}?expand[]=connected_account`,
        { headers: { 'X-Test-Payer': '1', 'X-Peable-Client-Secret': intent.clientSecret } },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as Json).error?.param).toBe('expand');
    });
  });

  describe('metadata', () => {
    test('POST /v1/payment_intents/:id merges, and an empty value unsets a key', async () => {
      const intent = await seedIntent(merchant, { metadata: { order: 'o_1', keep: 'yes' } });
      const set = await call('POST', `/v1/payment_intents/${intent.publicId}`, {
        metadata: { order: 'o_2', added: 'a' },
      });
      expect(set.status).toBe(200);
      expect(set.json.metadata).toEqual({ order: 'o_2', keep: 'yes', added: 'a' });

      const unset = await call('POST', `/v1/payment_intents/${intent.publicId}`, {
        metadata: { order: '', missing: '' },
      });
      expect(unset.json.metadata).toEqual({ keep: 'yes', added: 'a' });

      // The status is not mutable through an update.
      const sneaky = await call('POST', `/v1/payment_intents/${intent.publicId}`, {
        status: 'succeeded',
      });
      expect(sneaky.status).toBe(400);
      expect(sneaky.json.error?.param).toBe('status');
    });

    test('enforces 50 keys, 40-char keys and 500-char values, naming the field', async () => {
      const intent = await seedIntent(merchant);
      const path = `/v1/payment_intents/${intent.publicId}`;

      const longKey = 'k'.repeat(41);
      const key = await call('POST', path, { metadata: { [longKey]: 'v' } });
      expect(key.status).toBe(400);
      expect(key.json.error?.param).toBe(`metadata[${longKey}]`);

      const value = await call('POST', path, { metadata: { note: 'v'.repeat(501) } });
      expect(value.status).toBe(400);
      expect(value.json.error?.param).toBe('metadata[note]');

      const fiftyOne = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
      const tooMany = await call('POST', path, { metadata: fiftyOne });
      expect(tooMany.status).toBe(400);
      expect(tooMany.json.error?.param).toBe('metadata');

      // At the limits exactly: accepted.
      const fifty = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(500)]),
      );
      expect((await call('POST', path, { metadata: { ['k'.repeat(40)]: 'v' } })).status).toBe(200);
      const full = await seedIntent(merchant, { metadata: fifty });
      // The MERGED bag is what is judged: one more key on fifty is refused…
      const overflow = await call('POST', `/v1/payment_intents/${full.publicId}`, {
        metadata: { extra: 'x' },
      });
      expect(overflow.status).toBe(400);
      expect(overflow.json.error?.param).toBe('metadata');
      // …and changing one of the fifty, or swapping one out, is not.
      const swap = await call('POST', `/v1/payment_intents/${full.publicId}`, {
        metadata: { k0: '', extra: 'x', k1: 'changed' },
      });
      expect(swap.status).toBe(200);
      expect(Object.keys(swap.json.metadata as object)).toHaveLength(50);
    });

    test('creates refuse oversized metadata and drop empty values', async () => {
      const fiftyOne = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
      const price = await seedPrice(merchant, { currency: 'FAIR' });
      const lineItems = [{ price: price.publicId, quantity: 1 }];
      const refused = await call('POST', '/v1/payment_links', {
        line_items: lineItems,
        metadata: fiftyOne,
      });
      expect(refused.status).toBe(400);
      expect(refused.json.error?.param).toBe('metadata');

      const created = await call('POST', '/v1/payment_links', {
        line_items: lineItems,
        metadata: { kept: 'a', empty: '' },
      });
      expect(created.status).toBe(201);
      expect(created.json.metadata).toEqual({ kept: 'a' });
    });

    test('links and sessions update with POST and patch semantics; foreign ids are 404', async () => {
      const link = await seedLink(merchant, { metadata: { a: '1', b: '2' } });
      const linkUpdate = await call('POST', `/v1/payment_links/${link.publicId}`, {
        metadata: { a: '', c: '3' },
      });
      expect(linkUpdate.json.metadata).toEqual({ b: '2', c: '3' });

      const session = await seedSession(merchant, await seedIntent(merchant), {
        metadata: { x: '1' },
      });
      const sessionUpdate = await call('POST', `/v1/checkout_sessions/${session.publicId}`, {
        metadata: { y: '2' },
        expand: ['payment_intent'],
      });
      expect(sessionUpdate.status).toBe(200);
      expect(sessionUpdate.json.metadata).toEqual({ x: '1', y: '2' });
      expect((sessionUpdate.json.payment_intent as Json).object).toBe('payment_intent');

      actingApp = stranger.oxyAppId;
      expect(
        (await call('POST', `/v1/payment_links/${link.publicId}`, { metadata: { z: '1' } })).status,
      ).toBe(404);
      expect(
        (await call('POST', `/v1/checkout_sessions/${session.publicId}`, { metadata: { z: '1' } }))
          .status,
      ).toBe(404);
      const intent = await seedIntent(merchant);
      expect(
        (await call('POST', `/v1/payment_intents/${intent.publicId}`, { metadata: { z: '1' } }))
          .status,
      ).toBe(404);
    });
  });
});
