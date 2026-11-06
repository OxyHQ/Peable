/**
 * The per-payer bound on fresh FairCoin addresses (ADR 0021 D9, amended
 * 2026-11-06): a hosted checkout's confirm that will pay with FairCoin passes
 * the payer limiter whether the payer NAMED FairCoin or the order defaults to
 * it (a FAIR order), and a card confirm never does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { sendError } from '../../lib/http';
import { requestIdMiddleware } from '../../lib/requestId';
import {
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  seedPrice,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createCheckoutSessionsRouter } from '../checkoutSessions';

const APP_ID = 'app_payer_limit';
let merchant: MerchantRow;
let server: Server;
let baseUrl: string;
let limited = 0;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'development',
    tier: 'external',
  } as unknown as OxyAuthRequest['serviceApp'];
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();
/** A payer who has used up their budget: every request it sees is refused. */
const exhausted: RequestHandler = (_req, res) => {
  limited += 1;
  sendError(res, 429, 'rate_limit_error', 'too many FairCoin payments');
};

type Json = Record<string, unknown>;

async function call(
  method: 'POST',
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

useGatewayDatabase();

beforeAll(async () => {
  if (!POSTGRES_TESTS_ENABLED) return;
  merchant = await seedMerchant({ oxyAppId: APP_ID, network: 'testnet' });
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    createCheckoutSessionsRouter({
      requireMerchant: stubRequireMerchant,
      publicRateLimit: passthrough,
      faircoinPayerLimit: exhausted,
    }),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function fairSession(): Promise<{ id: string; secret: string }> {
  const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '150000000' });
  const created = await call('POST', '/v1/checkout_sessions', {
    success_url: 'https://example.com/thanks',
    line_items: [{ price: price.publicId, quantity: 1 }],
  });
  expect(created.status).toBe(201);
  const secret = decodeURIComponent(String(created.body.url).split('#cs=')[1] ?? '');
  return { id: String(created.body.id), secret };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the FairCoin payer limit on a hosted confirm', () => {
  test('applies when the payer names FairCoin, and when a FAIR order defaults to it', async () => {
    for (const body of [{ payment_method_type: 'faircoin' }, {}]) {
      const session = await fairSession();
      const before = limited;
      const confirmed = await call(
        'POST',
        `/v1/checkout_sessions/${session.id}/public/confirm`,
        body,
        { 'X-Peable-Client-Secret': session.secret },
      );
      expect(confirmed.status).toBe(429);
      expect(limited).toBe(before + 1);
    }
  });
});
