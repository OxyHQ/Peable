import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type RequestListener } from 'node:http';
import { Peable } from '../../src/index';
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
function sdk(url: string) {
  return new Peable({
    publicKey: 'synthetic',
    secret: 'synthetic',
    baseURL: url,
    oxyApiUrl: url,
    requestTimeoutMs: 100,
  });
}
describe('HTTP deadline and existing intent propagation', () => {
  test.each(['mint-headers', 'mint-body', 'gateway-headers', 'gateway-body'])(
    'bounds %s without automatically repeating a POST',
    async (mode) => {
      let gatewayCalls = 0;
      let mintCalls = 0;
      const keys: Array<string | undefined> = [];
      const url = await listen((request, response) => {
        request.resume();
        const mint = request.url === '/auth/service-token';
        if (mint) mintCalls++;
        else {
          gatewayCalls++;
          keys.push(request.headers['idempotency-key'] as string | undefined);
        }
        const result = mint
          ? { data: { token: 'synthetic', expiresIn: 300 } }
          : { id: 'effect-once' };
        const blocked = mode.startsWith(mint ? 'mint-' : 'gateway-');
        if (blocked && mode.endsWith('body')) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.flushHeaders();
        }
        setTimeout(
          () => {
            if (!response.destroyed) {
              if (!response.headersSent)
                response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify(result));
            }
          },
          blocked ? 500 : 0,
        );
      });
      await expect(
        sdk(url).paymentIntents.create(
          { amount: '100', currency: 'USD', rail: 'card' },
          { idempotencyKey: 'owned-stable-key' },
        ),
      ).rejects.toMatchObject({
        name: 'PeableApiError',
        ...(mode.endsWith('body') ? { statusCode: 200, code: 'invalid_response' } : {}),
      });
      expect(mintCalls).toBe(1);
      expect(gatewayCalls).toBe(mode.startsWith('mint-') ? 0 : 1);
      expect(keys).toEqual(mode.startsWith('mint-') ? [] : ['owned-stable-key']);
    },
  );
  test('a timed-out accepted effect recovers only on explicit retry of the same key', async () => {
    const keys: string[] = [];
    const effects = new Set<string>();
    const url = await listen((request, response) => {
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/auth/service-token') {
        response.end(JSON.stringify({ data: { token: 'synthetic', expiresIn: 300 } }));
        return;
      }
      const key = request.headers['idempotency-key'] as string;
      keys.push(key);
      effects.add(key);
      const complete = () => {
        if (!response.destroyed) response.end(JSON.stringify({ id: 'accepted-once' }));
      };
      if (keys.length === 1) setTimeout(complete, 500);
      else complete();
    });
    const client = sdk(url);
    const params = { amount: '100', currency: 'USD' as const, rail: 'card' as const };
    await expect(
      client.paymentIntents.create(params, { idempotencyKey: 'stable-intent' }),
    ).rejects.toMatchObject({ name: 'PeableApiError' });
    expect(keys).toEqual(['stable-intent']);
    expect(
      await client.paymentIntents.create(params, { idempotencyKey: 'stable-intent' }),
    ).toMatchObject({ id: 'accepted-once' });
    expect(keys).toEqual(['stable-intent', 'stable-intent']);
    expect(effects.size).toBe(1);
  });
  test('preserves supplied keys on reject/refund/transfer without changing durable body identity', async () => {
    const seen: Array<{ path: string; key: string | undefined; body: unknown }> = [];
    const url = await listen(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const mint = request.url === '/auth/service-token';
      if (!mint)
        seen.push({
          path: request.url!,
          key: request.headers['idempotency-key'] as string | undefined,
          body: body ? JSON.parse(body) : null,
        });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(mint ? { data: { token: 'synthetic', expiresIn: 300 } } : { id: 'result' }),
      );
    });
    const client = sdk(url);
    await client.paymentIntents.reject('pi_owned', { idempotencyKey: 'reject-intent' });
    await client.refunds.create(
      { paymentIntentId: 'pi_owned', externalRef: 'refund-owned', amount: '10' },
      { idempotencyKey: 'refund-intent' },
    );
    await client.transfers.create(
      {
        paymentIntentId: 'pi_owned',
        connectedAccountId: 'ca_owned',
        externalRef: 'order-owned',
        amount: '90',
      },
      { idempotencyKey: 'transfer-intent' },
    );
    expect(seen.map((x) => x.key)).toEqual(['reject-intent', 'refund-intent', 'transfer-intent']);
    expect(seen[1]?.body).toMatchObject({ externalRef: 'refund-owned', amount: '10' });
    expect(seen[2]?.body).toMatchObject({ externalRef: 'order-owned', amount: '90' });
  });
});
