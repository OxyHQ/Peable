import { expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createInternalErrorHandler, requestIdMiddleware } from '../requestId';
import { createGateway } from '../../server';

const REQUEST_ID = /^req_[0-9a-f]{24}$/;

async function withServer(
  app: express.Express | ReturnType<typeof createGateway>['httpServer'],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

test('the gateway names every response, health probe included, and lets a browser read it', async () => {
  const gateway = createGateway();
  try {
    await withServer(gateway.httpServer, async (base) => {
      const health = await fetch(`${base}/health`);
      const first = health.headers.get('Request-Id');
      expect(first).toMatch(REQUEST_ID);

      const again = await fetch(`${base}/health`);
      expect(again.headers.get('Request-Id')).not.toBe(first);

      // /health sits before CORS on purpose; any later route carries the CORS headers.
      const cors = await fetch(`${base}/no-such-route`, {
        headers: { Origin: 'https://peable.to' },
      });
      expect(cors.headers.get('Request-Id')).toMatch(REQUEST_ID);
      expect(cors.headers.get('Access-Control-Expose-Headers') ?? '').toContain('Request-Id');
    });
  } finally {
    gateway.io.close();
  }
});

test('a caller cannot choose the request id', async () => {
  const gateway = createGateway();
  try {
    await withServer(gateway.httpServer, async (base) => {
      const res = await fetch(`${base}/health`, { headers: { 'Request-Id': 'req_chosen' } });
      expect(res.headers.get('Request-Id')).not.toBe('req_chosen');
      expect(res.headers.get('Request-Id')).toMatch(REQUEST_ID);
    });
  } finally {
    gateway.io.close();
  }
});

test('an unmapped error answers 500 without its message, naming the request instead', async () => {
  const logged: { requestId: string | undefined; err: unknown }[] = [];
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/boom', () => {
    throw new Error('duplicate key value violates unique constraint "merchants_secret_idx"');
  });
  app.use(createInternalErrorHandler((requestId, _req, err) => logged.push({ requestId, err })));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    const requestId = res.headers.get('Request-Id');
    const text = await res.text();
    expect(text).not.toContain('merchants_secret_idx');
    const body = JSON.parse(text) as { error: { type: string; request_id: string } };
    expect(body.error.type).toBe('api_error');
    expect(body.error.request_id).toBe(String(requestId));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.requestId).toBe(String(requestId));
    expect(String(logged[0]?.err)).toContain('merchants_secret_idx');
  });
});
