/**
 * The generic idempotency layer (ADR 0014 D3) against a real Postgres.
 *
 * Two surfaces: a route this suite controls — so a request can be held in
 * flight, made to fail with a 5xx, or answered with a 4xx on demand — and the
 * real `POST /v1/payment_intents`, so "a replayed create does not create a
 * second row" is asserted against the money table rather than a stub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { must } from '../../__tests__/helpers/must';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { idempotencyKeys, paymentIntents } from '../../db/schema';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
} from '../../db/idempotency/idempotencyKeyRepository';
import { createPaymentIntentsRouter } from '../../routes/paymentIntents';
import { runIdempotencySweep } from '../../services/idempotencySweeper';
import { wrap } from '../http';
import { canonicalJson, idempotent, requestHashOf } from '../idempotency';
import { createInternalErrorHandler, requestIdMiddleware } from '../requestId';

let server: Server;
let baseUrl: string;
let merchantA: MerchantRow;
let merchantB: MerchantRow;
let actingApp: string;

/** What the controlled route does next. */
let handlerRuns = 0;
let answerStatus = 201;
let throwNext = false;
let hold: Promise<void> | undefined;

const stubMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: actingApp,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'development',
    tier: 'external',
  };
  next();
};

interface Answer {
  status: number;
  replayed: string | null;
  json: Record<string, unknown>;
}

async function post(path: string, body: unknown, key?: string): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    replayed: response.headers.get('Idempotent-Replayed'),
    json: (await response.json()) as Record<string, unknown>,
  };
}

function errorOf(answer: Answer): Record<string, unknown> {
  return answer.json.error as Record<string, unknown>;
}

async function rowsFor(merchant: MerchantRow, key: string) {
  return gatewayDb()
    .select({
      status: idempotencyKeys.status,
      responseStatus: idempotencyKeys.responseStatus,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.merchantId, merchant.id), eq(idempotencyKeys.key, key)));
}

async function intentCount(merchant: MerchantRow): Promise<number> {
  const [row] = await gatewayDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(eq(paymentIntents.merchantId, merchant.id));
  return must(row).n;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('generic idempotency', () => {
  useGatewayDatabase();

  beforeAll(async () => {
    merchantA = await seedMerchant();
    merchantB = await seedMerchant();

    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    const operation = wrap(async (req, res) => {
      handlerRuns += 1;
      if (hold) await hold;
      if (throwNext) {
        throwNext = false;
        throw new Error('the handler failed');
      }
      res.status(answerStatus).json({ run: handlerRuns, echo: req.body as unknown });
    });
    app.post('/v1/test_operations', stubMerchant, idempotent, operation);
    app.post('/v1/other_operations', stubMerchant, idempotent, operation);
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubMerchant,
        optionalServiceAuth: stubMerchant,
      }),
    );
    app.use(createInternalErrorHandler(() => undefined));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    actingApp = merchantA.oxyAppId;
    handlerRuns = 0;
    answerStatus = 201;
    throwNext = false;
    hold = undefined;
  });

  test('replays the stored status and body, marked, without running the handler again', async () => {
    const first = await post('/v1/test_operations', { a: 1 }, 'replay-1');
    const second = await post('/v1/test_operations', { a: 1 }, 'replay-1');

    expect(first.status).toBe(201);
    expect(first.replayed).toBeNull();
    expect(second.status).toBe(201);
    expect(second.replayed).toBe('true');
    expect(second.json).toEqual(first.json);
    expect(handlerRuns).toBe(1);
    expect(await rowsFor(merchantA, 'replay-1')).toEqual([
      { status: 'completed', responseStatus: 201 },
    ]);
  });

  test('the body is compared canonically: key order is not a different request', async () => {
    await post('/v1/test_operations', { a: 1, b: { c: 2, d: [1, 2] } }, 'canonical-1');
    const reordered = await post(
      '/v1/test_operations',
      { b: { d: [1, 2], c: 2 }, a: 1 },
      'canonical-1',
    );
    expect(reordered.replayed).toBe('true');
    expect(handlerRuns).toBe(1);
    expect(canonicalJson({ b: [2, 1], a: null })).toBe('{"a":null,"b":[2,1]}');
    expect(requestHashOf(undefined)).toBe(requestHashOf({}));
  });

  test('a replayed create does not create a second payment intent', async () => {
    const before = await intentCount(merchantA);
    const body = { amount: '150000000', network: 'testnet', metadata: { order: 'o1' } };
    const first = await post('/v1/payment_intents', body, 'create-once');
    const second = await post('/v1/payment_intents', body, 'create-once');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.replayed).toBe('true');
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.client_secret).toBe(first.json.client_secret);
    expect(await intentCount(merchantA)).toBe(before + 1);
  });

  test('the same key with a different body is 400 idempotency_error, and runs nothing', async () => {
    await post('/v1/test_operations', { a: 1 }, 'mismatch-body');
    const other = await post('/v1/test_operations', { a: 2 }, 'mismatch-body');

    expect(other.status).toBe(400);
    expect(errorOf(other).type).toBe('invalid_request_error');
    expect(errorOf(other).code).toBe('idempotency_error');
    expect(errorOf(other).param).toBeUndefined();
    expect(handlerRuns).toBe(1);
  });

  test('the same key on a different path is 400 idempotency_error', async () => {
    await post('/v1/test_operations', { a: 1 }, 'mismatch-path');
    const other = await post('/v1/other_operations', { a: 1 }, 'mismatch-path');

    expect(other.status).toBe(400);
    expect(errorOf(other).code).toBe('idempotency_error');
    expect(handlerRuns).toBe(1);
  });

  test('the same key while the first request is in flight is 409, then the answer replays', async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = post('/v1/test_operations', { a: 1 }, 'in-flight');
    while (handlerRuns === 0) await Bun.sleep(5);

    const concurrent = await post('/v1/test_operations', { a: 1 }, 'in-flight');
    expect(concurrent.status).toBe(409);
    expect(errorOf(concurrent).code).toBe('idempotency_error');
    expect(await rowsFor(merchantA, 'in-flight')).toEqual([
      { status: 'in_progress', responseStatus: null },
    ]);

    release();
    expect((await first).status).toBe(201);
    const after = await post('/v1/test_operations', { a: 1 }, 'in-flight');
    expect(after.replayed).toBe('true');
    expect(handlerRuns).toBe(1);
  });

  test('a 5xx is not stored: the key is released and the retry runs again', async () => {
    answerStatus = 503;
    const failed = await post('/v1/test_operations', { a: 1 }, 'five-hundred');
    expect(failed.status).toBe(503);
    expect(await rowsFor(merchantA, 'five-hundred')).toEqual([]);

    answerStatus = 201;
    const retried = await post('/v1/test_operations', { a: 1 }, 'five-hundred');
    expect(retried.status).toBe(201);
    expect(retried.replayed).toBeNull();
    expect(handlerRuns).toBe(2);
  });

  test('an unhandled error (the 500 envelope) is not stored either', async () => {
    throwNext = true;
    const failed = await post('/v1/test_operations', { a: 1 }, 'thrown');
    expect(failed.status).toBe(500);
    expect(await rowsFor(merchantA, 'thrown')).toEqual([]);

    const retried = await post('/v1/test_operations', { a: 1 }, 'thrown');
    expect(retried.status).toBe(201);
    expect(handlerRuns).toBe(2);
  });

  test('a 4xx IS stored, and replayed as the answer that request got', async () => {
    answerStatus = 404;
    const refused = await post('/v1/test_operations', { a: 1 }, 'four-hundred');
    answerStatus = 201;
    const again = await post('/v1/test_operations', { a: 1 }, 'four-hundred');

    expect(refused.status).toBe(404);
    expect(again.status).toBe(404);
    expect(again.replayed).toBe('true');
    expect(again.json).toEqual(refused.json);
    expect(handlerRuns).toBe(1);
  });

  test('after 24 hours the key is free again, and the sweeper deletes it', async () => {
    await post('/v1/test_operations', { a: 1 }, 'expired');
    await gatewayDb()
      .update(idempotencyKeys)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(idempotencyKeys.key, 'expired'));

    // A different request is no longer a mismatch: the key binds nothing.
    const fresh = await post('/v1/test_operations', { a: 2 }, 'expired');
    expect(fresh.status).toBe(201);
    expect(fresh.replayed).toBeNull();
    expect(handlerRuns).toBe(2);

    // The fresh claim started a new window, so the sweep leaves it alone and
    // takes only what is past its deadline.
    await post('/v1/test_operations', { a: 3 }, 'expired-other');
    await gatewayDb()
      .update(idempotencyKeys)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(idempotencyKeys.key, 'expired-other'));
    const swept = await runIdempotencySweep();
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowsFor(merchantA, 'expired-other')).toEqual([]);
    expect(await rowsFor(merchantA, 'expired')).toHaveLength(1);
  });

  test('keys are scoped per merchant: another merchant’s identical key is its own', async () => {
    const body = { amount: '150000000', network: 'testnet' };
    const beforeB = await intentCount(merchantB);
    const fromA = await post('/v1/payment_intents', body, 'shared-key');
    actingApp = merchantB.oxyAppId;
    const fromB = await post('/v1/payment_intents', body, 'shared-key');

    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);
    expect(fromB.replayed).toBeNull();
    expect(fromB.json.id).not.toBe(fromA.json.id);
    expect(await intentCount(merchantB)).toBe(beforeB + 1);
    expect(await rowsFor(merchantA, 'shared-key')).toHaveLength(1);
    expect(await rowsFor(merchantB, 'shared-key')).toHaveLength(1);
  });

  test('a lease that ran out is taken over by the SAME request only', async () => {
    const request = {
      merchantId: merchantA.id,
      key: 'abandoned',
      method: 'POST',
      path: '/v1/test_operations',
      requestHash: requestHashOf({ a: 1 }),
    };
    // A request that claimed the key and then died: in progress, lease past.
    const deadClaim = must(await claimIdempotencyKey(gatewayDb(), request));
    await gatewayDb()
      .update(idempotencyKeys)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(idempotencyKeys.id, deadClaim));

    const different = await post('/v1/test_operations', { a: 2 }, 'abandoned');
    expect(different.status).toBe(400);
    expect(errorOf(different).code).toBe('idempotency_error');

    const retry = await post('/v1/test_operations', { a: 1 }, 'abandoned');
    expect(retry.status).toBe(201);
    expect(handlerRuns).toBe(1);

    // The dead request, were it to finish now, stores nothing over the retry's.
    expect(await completeIdempotencyKey(gatewayDb(), deadClaim, { status: 200, body: {} })).toBe(
      false,
    );
    const replay = await post('/v1/test_operations', { a: 1 }, 'abandoned');
    expect(replay.replayed).toBe('true');
    expect(replay.json).toEqual(retry.json);
  });

  test('a live lease is not taken over', async () => {
    const request = {
      merchantId: merchantA.id,
      key: 'live-lease',
      method: 'POST',
      path: '/v1/test_operations',
      requestHash: requestHashOf({ a: 1 }),
    };
    expect(await claimIdempotencyKey(gatewayDb(), request)).not.toBeNull();
    expect(await claimIdempotencyKey(gatewayDb(), request)).toBeNull();
  });

  test('refuses a key that is not 1–255 printable ASCII characters', async () => {
    for (const key of ['k'.repeat(256), 'clé']) {
      const refused = await post('/v1/test_operations', { a: 1 }, key);
      expect(refused.status).toBe(400);
      expect(errorOf(refused).code).toBe('idempotency_key_invalid');
    }
    expect(handlerRuns).toBe(0);
  });

  test('without a key every request runs, and nothing is stored', async () => {
    const before = await gatewayDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(idempotencyKeys);
    await post('/v1/test_operations', { a: 1 });
    await post('/v1/test_operations', { a: 1 });
    const after = await gatewayDb().select({ n: sql<number>`count(*)::int` }).from(idempotencyKeys);

    expect(handlerRuns).toBe(2);
    expect(must(after[0]).n).toBe(must(before[0]).n);
  });

  test('a credential with no merchant passes through to the route and stores nothing', async () => {
    actingApp = 'app_without_a_merchant';
    const first = await post('/v1/payment_intents', { amount: '1000', network: 'testnet' }, 'nm');
    expect(first.status).toBe(403);
    const rows = await gatewayDb()
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, 'nm'));
    expect(rows).toEqual([]);
  });
});
