import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalStripeTestCheckoutRouter } from './stripeTestCheckoutRouter';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
});
async function harness(assertEnvironment = () => {}) {
  const keys: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createLocalStripeTestCheckoutRouter({
      assertEnvironment,
      prepare: async () => ({ environment: 'test', publishableKey: 'pk_test_public' }),
      read: async (id, capability) => {
        if (id !== 'pi_local' || capability !== 'payer-capability') throw new Error('not found');
        return { ready: false, invoiceStatus: 'open' };
      },
      create: async (key) => {
        keys.push(key);
        return { intentId: 'pi_local', clientSecret: 'payer-capability' };
      },
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    keys,
    prepare: (headers: Record<string, string> = {}) =>
      fetch(`${base}/__local/checkout-test/config`, {
        headers: {
          Host: '127.0.0.1:4310',
          Origin: 'http://localhost:8110',
          'X-Peable-Local-Test': '1',
          ...headers,
        },
      }),
    read: (id = 'pi_local', capability = 'payer-capability', origin = 'http://localhost:8110') =>
      fetch(`${base}/__local/checkout-test/${id}/subscription`, {
        headers: { Host: '127.0.0.1:4310', Origin: origin, 'X-Peable-Client-Secret': capability },
      }),
    request: (headers: Record<string, string> = {}, body = '{"interval":"month"}') =>
      fetch(`${base}/__local/checkout-test`, {
        method: 'POST',
        body,
        headers: {
          Host: '127.0.0.1:4310',
          Origin: 'http://localhost:8110',
          'Content-Type': 'application/json',
          'X-Peable-Local-Test': '1',
          'Idempotency-Key': 'stable-operation-12345',
          ...headers,
        },
      }),
  };
}
describe('loopback test checkout entry', () => {
  test('returns only the payer capability and preserves the operation identity', async () => {
    const h = await harness();
    const r = await h.request();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ intentId: 'pi_local', clientSecret: 'payer-capability' });
    await h.request();
    expect(h.keys).toEqual(['stable-operation-12345', 'stable-operation-12345']);
  });
  test('rejects other origins, hosts, missing opt-in and non-JSON before creation', async () => {
    const h = await harness();
    const invalidHeaders: Record<string, string>[] = [
      { Origin: 'https://mention.earth' },
      { Origin: 'null' },
      { Host: 'attacker.example:4310' },
      { 'X-Peable-Local-Test': '' },
      { 'Content-Type': 'text/plain' },
    ];
    for (const headers of invalidHeaders) expect((await h.request(headers)).status).toBe(403);
    expect(h.keys).toHaveLength(0);
  });
  test('rejects caller-selected amounts and missing operation identities', async () => {
    const h = await harness();
    for (const body of [
      '{"amount":1}',
      '[]',
      '{}',
      '{"interval":"week"}',
      '{"interval":"month","amount":1}',
    ])
      expect((await h.request({}, body)).status).toBe(400);
    expect((await h.request({ 'Idempotency-Key': '' })).status).toBe(400);
    expect(h.keys).toHaveLength(0);
  });
  test('rechecks the environment and fails closed after configuration changes', async () => {
    let permitted = true;
    const h = await harness(() => {
      if (!permitted) throw new Error('wrong mode');
    });
    permitted = false;
    const r = await h.request();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'local_test_unavailable' });
    expect(h.keys).toHaveLength(0);
  });
  test('subscription read requires the exact payer capability and allowed origin', async () => {
    const h = await harness();
    expect((await h.read()).status).toBe(200);
    expect((await h.read('pi_local', '')).status).toBe(403);
    expect((await h.read('pi_local', 'wrong-capability')).status).toBe(503);
    expect((await h.read('pi_other', 'payer-capability')).status).toBe(503);
    expect((await h.read('pi_local', 'payer-capability', 'https://attacker.example')).status).toBe(
      403,
    );
  });
  test('bounds requests even when different operation keys are supplied', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++)
      expect((await h.request({ 'Idempotency-Key': `operation-123456-${i}` })).status).toBe(200);
    const limited = await h.request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(h.keys).toHaveLength(10);
  });
});

test('readonly preparation returns public fields without creating a payment and rejects foreign scope', async () => {
  const h = await harness();
  const response = await h.prepare();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ environment: 'test', publishableKey: 'pk_test_public' });
  const invalidHeaders: Record<string, string>[] = [
    { Origin: 'https://mention.earth' },
    { Host: 'attacker.example' },
    { 'X-Peable-Local-Test': '' },
  ];
  for (const headers of invalidHeaders) expect((await h.prepare(headers)).status).toBe(403);
  expect(h.keys).toHaveLength(0);
});
test('readonly preparation rechecks environment even without any create request', async () => {
  let valid = true;
  const h = await harness(() => {
    if (!valid) throw new Error('wrong mode');
  });
  valid = false;
  expect((await h.prepare()).status).toBe(503);
  expect(h.keys).toHaveLength(0);
});
